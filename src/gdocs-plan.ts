// Plans Docs API batchUpdate requests that move a remote document toward a target.
//
// Planning happens in passes. Each pass looks at a fresh copy of the document,
// fixes what it safely can, and the caller fetches again and replans until
// nothing differs. Content (text, styles, structure) comes first; lists are
// rebuilt once the paragraphs line up, because list edits need stable ranges.
// Within a pass, edits run from the end of each segment backwards so earlier
// indices stay valid. The body, each header/footer/footnote and each tab are
// separate index spaces.
//
// Docs rules this relies on (checked against the live API; test/sim.ts models them):
// - A segment always ends with a paragraph, can't start with a table, and two
//   tables can't touch. The newline before a table and a segment's last
//   newline can't be deleted.
// - A paragraph's style and bullet live on its newline. Inserting "\n" copies
//   the paragraph it lands in.
// - insertTable at index i splits the paragraph there: the table starts at
//   i + 1 and is followed by a new empty paragraph.
// - insertPageBreak also inserts a newline right after the break.
// - updateTextStyle only removes a link if its range starts on linked text.
// - createParagraphBullets next to a list with the same preset joins that list,
//   and then ignores nesting tabs: only a new list takes levels from tabs.

import {diffArrays} from "diff";
import {blockKey} from "./format.ts";
import {LINK_COLOR, NAMED_TYPE, FOOTNOTE_SIZE, footnoteDefaults, type IBlock, type IPara, type ISegment, type ITable, type Remote, type RSegment} from "./gdocs-read.ts";
import {
  type Atom, type Block, type CellInfo, type Doc, type ListInfo, type Para, type Run, type Segment, type TextStyle,
  atomKey, paraText,
} from "./model.ts";

type Req = Record<string, any>;

// A request that creates something whose id comes back in the batchUpdate
// reply. The caller passes the reply to `apply`, which writes the id into the
// target so the next pass recognizes the new object.
export interface Created {
  req: Req;
  apply: (reply: any) => void;
}

export interface Plan {
  pass: "content" | "lists" | "done";
  requests: Req[];
  warnings: string[];
  created: Created[];
}

// The raw documents.get JSON, attached by fetchDoc. Optional: without it the
// planner can't copy images or see named style defaults.
export type PlanRemote = Remote & {api?: any};

const EMPTY: Para = {type: "para", style: "p", runs: []};

// ---------- target normalization ----------

// Docs keeps a paragraph before a leading table, between tables, and at the
// end of every segment; the file may leave them out.
export function normalizeTarget(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.type === "table" && (!out.length || out.at(-1)!.type === "table")) out.push(EMPTY);
    out.push(b);
  }
  if (!out.length || out.at(-1)!.type !== "para") out.push(EMPTY);
  return out;
}

interface Defaults {
  font?: string;
  size?: number;
  color?: string;
}

function hexOf(c: any): string | undefined {
  const rgb = c?.color?.rgbColor;
  if (!rgb) return undefined;
  const h = (v: number | undefined) => Math.round((v ?? 0) * 255).toString(16).padStart(2, "0");
  return `#${h(rgb.red)}${h(rgb.green)}${h(rgb.blue)}`;
}

function namedDefaults(dt: any): Record<string, Defaults> {
  const styles: any[] = dt?.namedStyles?.styles ?? [];
  const read = (s: any): Defaults => ({
    font: s?.textStyle?.weightedFontFamily?.fontFamily,
    size: s?.textStyle?.fontSize?.magnitude,
    color: hexOf(s?.textStyle?.foregroundColor),
  });
  const normal = read(styles.find((s) => s.namedStyleType === "NORMAL_TEXT"));
  const out: Record<string, Defaults> = {};
  for (const s of styles) {
    const own = read(s);
    out[s.namedStyleType] = {font: own.font ?? normal.font, size: own.size ?? normal.size, color: own.color ?? normal.color};
  }
  return out;
}

// A run styled with what the paragraph style gives anyway reads back without
// it, so compare without it too.
function dropDefaults(blocks: Block[], defaults: Record<string, Defaults>): Block[] {
  if (!Object.keys(defaults).length) return blocks;
  const para = (p: Para): Para => {
    const d = defaults[NAMED_TYPE[p.style]] ?? {};
    let changed = false;
    const runs = p.runs.map((r) => {
      const s = r.style;
      if ((s.font && s.font === d.font) || (s.size && s.size === d.size) || (s.color && s.color === (d.color ?? "#000000"))) {
        changed = true;
        const style = {...s};
        if (style.font === d.font) delete style.font;
        if (style.size === d.size) delete style.size;
        if (style.color === (d.color ?? "#000000")) delete style.color;
        return {...r, style} as Run;
      }
      return r;
    });
    return changed ? {...p, runs} : p;
  };
  const walk = (b: Block): Block =>
    b.type === "para" ? para(b) : b.type === "table" ? {...b, rows: b.rows.map((r) => r.map((c) => c.map(walk)))} : b;
  return blocks.map(walk);
}

// ---------- diffing helpers ----------

function stripLists(b: Block): Block {
  if (b.type === "para") return b.list ? {...b, list: undefined} : b;
  if (b.type === "table") return {...b, rows: b.rows.map((r) => r.map((c) => c.map(stripLists)))};
  return b;
}

const contentKey = (b: Block) => blockKey(stripLists(b));

interface Hunk {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
}

function hunks(a: string[], b: string[]): Hunk[] {
  const out: Hunk[] = [];
  let i = 0;
  let j = 0;
  let cur: Hunk | null = null;
  for (const part of diffArrays(a, b)) {
    if (!part.added && !part.removed) {
      if (cur) out.push(cur);
      cur = null;
      i += part.count!;
      j += part.count!;
      continue;
    }
    cur ??= {i0: i, i1: i, j0: j, j1: j};
    if (part.removed) i = cur.i1 = i + part.count!;
    else j = cur.j1 = j + part.count!;
  }
  if (cur) out.push(cur);
  return out;
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function similarity(a: string, b: string, x: Map<string, number>, y: Map<string, number>): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  let common = 0;
  for (const [g, n] of x) common += Math.min(n, y.get(g) ?? 0);
  return (2 * common) / (a.length - 1 + (b.length - 1));
}

type Op = {o?: number; n?: number};

// Lines up the blocks of a changed stretch: same-type blocks pair up (and get
// edited in place), similar paragraphs preferably with each other. Pairing
// keeps a paragraph's comments, ids and bullets; only unpaired ones are
// deleted or inserted.
function align(olds: IBlock[], news: Block[]): Op[] {
  const n = olds.length;
  const m = news.length;
  const text = (b: Block) => (b.type === "para" ? paraText(b) : "");
  const ot = olds.map((o) => text(o.block));
  const nt = news.map(text);
  const big = n * m <= 40000;
  const og = big ? ot.map(bigrams) : [];
  const ng = big ? nt.map(bigrams) : [];
  const score = (i: number, j: number): number => {
    const o = olds[i];
    const b = news[j];
    if (o.type !== b.type) return -1;
    if (o.type === "opaque") return o.block.key === (b as any).key && o.block.kind === (b as any).kind ? 1 : -1;
    if (o.type === "table") return 0.6;
    if (!big) return 0.1;
    return 0.1 + similarity(ot[i], nt[j], og[i], ng[j]) + (o.block.style === (b as Para).style ? 0.01 : 0);
  };
  if (!big) {
    // Too big to score every pair: line up by type from both ends.
    const ops: Op[] = [];
    let k = 0;
    while (k < n && k < m && score(k, k) > 0) ops.push({o: k, n: k++});
    let e = 0;
    while (e < n - k && e < m - k && score(n - 1 - e, m - 1 - e) > 0) e++;
    for (let i = k; i < n - e; i++) ops.push({o: i});
    for (let j = k; j < m - e; j++) ops.push({n: j});
    for (let t = e - 1; t >= 0; t--) ops.push({o: n - 1 - t, n: m - 1 - t});
    return ops;
  }
  const best: number[][] = Array.from({length: n + 1}, () => new Array(m + 1).fill(0));
  const pairScore: number[][] = Array.from({length: n}, () => new Array(m).fill(-1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = (pairScore[i][j] = score(i, j));
      best[i][j] = Math.max(best[i + 1][j], best[i][j + 1], s > 0 ? s + best[i + 1][j + 1] : -Infinity);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && pairScore[i][j] > 0 && best[i][j] === pairScore[i][j] + best[i + 1][j + 1]) ops.push({o: i++, n: j++});
    else if (i < n && (j === m || best[i][j] === best[i + 1][j])) ops.push({o: i++});
    else ops.push({n: j++});
  }
  // Within a run of deletes and inserts, deletes first, so an insert lands
  // next to a block that stays.
  return ops;
}

// Lines up table rows (or columns), each given as its cells' keys. Rows that
// share cells pair up wherever they are; others pair by position.
function alignLines(a: string[][], b: string[][]): Op[] {
  const n = a.length;
  const m = b.length;
  const score = (x: string[], y: string[]) => {
    const left = [...y];
    let common = 0;
    for (const k of x) {
      const i = left.indexOf(k);
      if (i >= 0) {
        common++;
        left.splice(i, 1);
      }
    }
    return 0.1 + common / Math.max(x.length, y.length, 1);
  };
  const best: number[][] = Array.from({length: n + 1}, () => new Array(m + 1).fill(0));
  const ps: number[][] = Array.from({length: n}, () => new Array(m).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      ps[i][j] = score(a[i], b[j]);
      best[i][j] = Math.max(best[i + 1][j], best[i][j + 1], ps[i][j] + best[i + 1][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && best[i][j] === ps[i][j] + best[i + 1][j + 1]) ops.push({o: i++, n: j++});
    else if (i < n && (j === m || best[i][j] === best[i + 1][j])) ops.push({o: i++});
    else ops.push({n: j++});
  }
  return ops;
}

// ---------- request building ----------

function rgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return {color: {rgbColor: {red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255}}};
}

const TEXT_FIELDS = [
  "bold", "italic", "underline", "strikethrough", "smallCaps", "baselineOffset", "link", "backgroundColor",
  "foregroundColor", "fontSize", "weightedFontFamily",
].join(",");

export function apiTextStyle(s: TextStyle, defaultFont?: string, tabId?: string, defaultSize?: number): Req {
  const linkDefault = !!s.href && !s.color && !s.u;
  const ts: Req = {
    bold: !!s.b,
    italic: !!s.i,
    underline: !!s.u || linkDefault,
    strikethrough: !!s.s,
    smallCaps: !!s.smallcaps,
    baselineOffset: s.sup ? "SUPERSCRIPT" : s.sub ? "SUBSCRIPT" : "NONE",
  };
  if (s.href) {
    const [, kind, id, tab] = /^#(heading|bookmark|tab)=([^&]+)(?:&tab=(.+))?$/.exec(s.href) ?? [];
    if (kind === "tab") ts.link = {tabId: id};
    else if (kind) ts.link = {[kind]: tab ?? tabId ? {id, tabId: tab ?? tabId} : {id}};
    else ts.link = {url: s.href};
  }
  if (s.mark) ts.backgroundColor = rgb(s.mark);
  if (s.color || linkDefault) ts.foregroundColor = rgb(s.color ?? LINK_COLOR);
  if (s.size || defaultSize) ts.fontSize = {magnitude: s.size ?? defaultSize, unit: "PT"};
  if (s.font || s.weight) {
    ts.weightedFontFamily = {fontFamily: s.font ?? defaultFont ?? "Arial"};
    if (s.weight) ts.weightedFontFamily.weight = s.weight;
  }
  return ts;
}

// Text style keys the planner can set. Suggestions (ins/del) can only be kept.
const SETTABLE = ["href", "mark", "color", "font", "size", "weight", "smallcaps", "b", "i", "u", "s", "sup", "sub"] as const;
const styleEq = (a: TextStyle, b: TextStyle) => SETTABLE.every((k) => (a[k] || undefined) === (b[k] || undefined));
const styleKey = (s: TextStyle) => SETTABLE.map((k) => s[k] || "").join("|");

const ALIGN_API = {left: "START", center: "CENTER", right: "END", justify: "JUSTIFIED"} as const;

// Bullet presets and the glyph `<li type>` reads back as at each level
// (undefined = the plain default ● ○ ■). Measured live.
const PRESETS: [string, boolean, (string | undefined)[]][] = [
  ["BULLET_DISC_CIRCLE_SQUARE", false, []],
  ["BULLET_CHECKBOX", false, Array(9).fill("check")],
  ["BULLET_DIAMONDX_ARROW3D_SQUARE", false, ["❖", "➢", undefined, undefined, "◆", "➢", undefined, undefined, "◆"]],
  ["BULLET_ARROW_DIAMOND_DISC", false, ["➔", "◆", "●", "○", "◆", "●", "○", "◆", "●"]],
  ["BULLET_STAR_CIRCLE_SQUARE", false, ["★"]],
  ["BULLET_ARROW3D_CIRCLE_SQUARE", false, ["➢"]],
  ["BULLET_LEFTTRIANGLE_DIAMOND_DISC", false, ["◄", "◆", "●", "○", "◆", "●", "○", "◆", "●"]],
  ["BULLET_DIAMONDX_HOLLOWDIAMOND_SQUARE", false, ["❖", "◇", undefined, undefined, "◆", "◇", undefined, undefined, "◆"]],
  ["BULLET_DIAMOND_CIRCLE_SQUARE", false, ["◆"]],
  ["NUMBERED_DECIMAL_ALPHA_ROMAN", true, ["1", "a", "i", "1", "a", "i", "1", "a", "i"]],
  ["NUMBERED_UPPERALPHA_ALPHA_ROMAN", true, ["A", "a", "i", "1", "a", "i", "1", "a", "i"]],
  ["NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL", true, ["I", "A", "1", "a", "1", "a", "i", "a", "i"]],
  ["NUMBERED_ZERODECIMAL_ALPHA_ROMAN", true, ["01", "a", "i", "1", "a", "i", "1", "a", "i"]],
  ["NUMBERED_DECIMAL_NESTED", true, Array(9).fill("1")],
];
const DEFAULT_BULLETS = ["●", "○", "■"];

function presetGlyph(p: (typeof PRESETS)[number], level: number): string | undefined {
  const g = p[2][level];
  return g === DEFAULT_BULLETS[level % 3] ? undefined : g;
}

// What a target list item's glyph means: unset is the default for its kind.
function wantGlyph(l: ListInfo): string | undefined {
  if (l.glyph === undefined) return l.ordered ? "1" : undefined;
  return l.glyph === DEFAULT_BULLETS[l.level % 3] ? undefined : l.glyph;
}

function pickPreset(items: ListInfo[]): (typeof PRESETS)[number] {
  const ordered = items[0].ordered;
  let best = PRESETS.find((p) => p[1] === ordered)!;
  let bestScore = -1;
  for (const p of PRESETS) {
    if (p[1] !== ordered) continue;
    // The top-level glyph matters most.
    const score = items.reduce((n, l) => n + (presetGlyph(p, l.level) === wantGlyph(l) ? (l.level === items[0].level ? 100 : 1) : 0), 0);
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

type DiffUnit = {tok: string; len: number; run: Run};
type DiffSeg = {t: "eq"; o: DiffUnit[]; n: DiffUnit[]} | {t: "edit"; o: DiffUnit[]; n: DiffUnit[]};

// A character diff of unrelated text keeps scattered common letters, which
// would become dozens of tiny edits. Like diff-match-patch's semantic cleanup,
// fold a short stretch of kept text into the edits around it when those are
// at least as long. Objects are never folded: they'd be deleted and recreated.
function cleanup(a: DiffUnit[], b: DiffUnit[]): DiffSeg[] {
  const segs: DiffSeg[] = [];
  let i = 0;
  let j = 0;
  for (const part of diffArrays(a.map((u) => u.tok), b.map((u) => u.tok))) {
    const n = part.count!;
    if (!part.added && !part.removed) {
      segs.push({t: "eq", o: a.slice(i, i + n), n: b.slice(j, j + n)});
      i += n;
      j += n;
      continue;
    }
    let last = segs.at(-1);
    if (last?.t !== "edit") segs.push((last = {t: "edit", o: [], n: []}));
    if (part.removed) last.o.push(...a.slice(i, (i += n)));
    else last.n.push(...b.slice(j, (j += n)));
  }
  const size = (s: DiffSeg | undefined) => (s?.t === "edit" ? s.o.reduce((x, u) => x + u.len, 0) + s.n.reduce((x, u) => x + u.len, 0) : 0);
  for (let changed = true; changed; ) {
    changed = false;
    for (let k = 1; k < segs.length - 1; k++) {
      const e = segs[k];
      if (e.t !== "eq" || e.o.some((u) => !("text" in u.run))) continue;
      const len = e.o.reduce((x, u) => x + u.len, 0);
      const before = segs[k - 1];
      const after = segs[k + 1];
      if (len > Math.min(size(before), size(after))) continue;
      // before + e + after become one edit.
      segs.splice(k - 1, 3, {t: "edit", o: [...before.o, ...e.o, ...after.o], n: [...before.n, ...e.n, ...after.n]});
      changed = true;
    }
  }
  // Folding can leave an edit that starts or ends with the same text on both
  // sides; keep that part.
  const out: DiffSeg[] = [];
  for (const sg of segs) {
    if (sg.t === "eq") {
      out.push(sg);
      continue;
    }
    let p = 0;
    while (p < sg.o.length && p < sg.n.length && sg.o[p].tok === sg.n[p].tok && "text" in sg.o[p].run) p++;
    let q = 0;
    while (q < sg.o.length - p && q < sg.n.length - p && sg.o[sg.o.length - 1 - q].tok === sg.n[sg.n.length - 1 - q].tok && "text" in sg.o[sg.o.length - 1 - q].run) q++;
    if (p) out.push({t: "eq", o: sg.o.slice(0, p), n: sg.n.slice(0, p)});
    out.push({t: "edit", o: sg.o.slice(p, sg.o.length - q), n: sg.n.slice(p, sg.n.length - q)});
    if (q) out.push({t: "eq", o: sg.o.slice(sg.o.length - q), n: sg.n.slice(sg.n.length - q)});
  }
  return out;
}

interface Ctx {
  segmentId?: string;
  tabId?: string;
}

interface RemoteObj {
  uri?: string;
  size?: any;
}

interface DropdownDef {
  id: string;
  options: {id: string; value: string}[];
}

// Dropdown definitions per tab ("" is the first tab), and which one each
// dropdown in the doc uses.
interface Dropdowns {
  defs: Map<string, DropdownDef[]>;
  of: Map<string, string>;
  made: Map<string, DropdownDef>; // definitions this plan creates, by tab + options
}

interface Shared {
  warnings: string[];
  created: Created[];
  objects: Map<string, RemoteObj>;
  keep: Set<string>;
  remoteKeys: Set<string>;
  dropdowns: Dropdowns;
  // Gives a footnote made this pass its text, once the reply has its id.
  addFootnote: (tabId: string | undefined, id: string, text: string) => void;
}

class Planner {
  out: Req[] = [];
  warnings: string[];
  created: Created[];
  ctx: Ctx = {};
  objects: Map<string, RemoteObj>;
  keep: Set<string>; // atom keys the target still has somewhere
  remoteKeys: Set<string>; // atom keys the doc has somewhere
  dropdowns: Dropdowns;
  addFootnote: Shared["addFootnote"];
  defaultFont?: string;
  defaultSize?: number; // set in footnotes, where Docs' default is 10pt
  inTable = 0;

  constructor(shared: Shared) {
    this.remoteKeys = shared.remoteKeys;
    this.dropdowns = shared.dropdowns;
    this.addFootnote = shared.addFootnote;
    this.warnings = shared.warnings;
    this.created = shared.created;
    this.objects = shared.objects;
    this.keep = shared.keep;
  }

  warn(msg: string) {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  loc(index: number): Req {
    return {index, ...this.ctx};
  }

  range(startIndex: number, endIndex: number): Req {
    return {startIndex, endIndex, ...this.ctx};
  }

  // ---------- content pass ----------

  segment(seg: ISegment, target: Block[]) {
    target = normalizeTarget(target);
    const hs = hunks(seg.map((b) => contentKey(b.block)), target.map(contentKey));
    for (const h of hs.reverse()) this.hunk(seg, target, h);
  }

  hunk(seg: ISegment, target: Block[], h: Hunk) {
    const ops = align(seg.slice(h.i0, h.i1), target.slice(h.j0, h.j1)).map((op) => ({
      o: op.o === undefined ? undefined : op.o + h.i0,
      n: op.n === undefined ? undefined : op.n + h.j0,
    }));
    const dels = ops.some((op) => op.n === undefined);
    // The target block that will stand right before old block i, if it stays.
    const pairedTarget = (i: number): Block | undefined => {
      if (i < h.i0) return target[h.j0 - (h.i0 - i)];
      return target[ops.find((op) => op.o === i)?.n ?? -1];
    };
    let k = ops.length - 1;
    while (k >= 0) {
      const op = ops[k];
      if (op.o !== undefined && op.n !== undefined) {
        this.pair(seg[op.o], target[op.n]);
        k--;
        continue;
      }
      let a = k;
      if (op.n === undefined) {
        while (a > 0 && ops[a - 1].n === undefined) a--;
        const from = ops[a].o!;
        this.deleteBlocks(seg, from, op.o! + 1, pairedTarget(from - 1));
      } else {
        while (a > 0 && ops[a - 1].o === undefined) a--;
        // Inserting next to blocks being deleted would race their index math;
        // the next pass inserts once they're gone.
        if (!dels) {
          const pos = ops.slice(k + 1).find((x) => x.o !== undefined)?.o ?? h.i1;
          this.insertBlocks(seg, pos, ops.slice(a, k + 1).map((x) => target[x.n!]));
        }
      }
      k = a - 1;
    }
  }

  deleteBlocks(seg: ISegment, a: number, b: number, prevTarget: Block | undefined) {
    // A paragraph holding an object that the target has elsewhere but that
    // can't be copied (a footnote, a chip) is cut down to that object instead.
    for (let i = b - 1; i >= a; i--) {
      const x = seg[i];
      if (x.type !== "para") continue;
      const stuck = x.block.runs.filter((r) => "atom" in r && this.stuck(r.atom));
      if (!stuck.length) continue;
      if (i + 1 < b) this.deleteBlocks(seg, i + 1, b, x.block);
      for (const r of stuck) if ("atom" in r) this.warn(`can't move ${atomDesc(r.atom)}; it stays where it was`);
      this.para(x, {...x.block, runs: stuck});
      if (i > a) this.deleteBlocks(seg, a, i, prevTarget);
      return;
    }
    const first = seg[a];
    const last = seg[b - 1];
    const prev = seg[a - 1];
    const next = seg[b];
    for (let i = a; i < b; i++) this.protect(seg[i]);
    let start = first.start;
    let end = last.end;
    if (!next || next.type === "table") {
      // Docs won't delete a segment's final newline or the one before a table,
      // so give up the previous paragraph's newline instead. Its paragraph
      // style and bullet come from the last deleted paragraph then, so put
      // the previous paragraph's back.
      if (prev?.type === "para" && last.type === "para") {
        start = prev.end - 1;
        end = last.end - 1;
        this.out.push({deleteContentRange: {range: this.range(start, end)}});
        const want = prevTarget?.type === "para" ? prevTarget : prev.block;
        if (last.block.list && !want.list) this.out.push({deleteParagraphBullets: {range: this.range(start, start + 1)}});
        this.paraStyle(start, prev.block, want, true);
        return;
      }
      if (last.type === "para") end = last.end - 1;
    }
    if (end > start) this.out.push({deleteContentRange: {range: this.range(start, end)}});
  }

  // An object the target still has somewhere, that Docs can't recreate.
  stuck(atom: Atom): boolean {
    return !!atom.attrs.id && this.keep.has(atom.key) && !this.objects.get(atom.key)?.uri;
  }

  // Warns about objects in a table that's going away but that the target
  // still has elsewhere.
  protect(b: IBlock) {
    if (b.type !== "table") return;
    for (const row of b.cells) {
      for (const cell of row) {
        for (const x of cell) {
          if (x.type === "table") this.protect(x);
          if (x.type !== "para") continue;
          for (const r of x.block.runs) {
            if ("atom" in r && this.stuck(r.atom)) this.warn(`can't move ${atomDesc(r.atom)} out of a deleted table; it was deleted with it`);
          }
        }
      }
    }
  }

  insertBlocks(seg: ISegment, pos: number, news: Block[]) {
    const prev = seg[pos - 1];
    const next = seg[pos];
    while (news.length && news[0].type === "opaque") {
      const b = news[0] as Block & {type: "opaque"};
      this.warn(`can't create <object kind="${b.kind}">; goog can only keep existing ones`);
      news = news.slice(1);
    }
    if (!news.length) return;
    const b = news[0];
    if (b.type === "table") return this.insertTable(prev, next, b, news.length === 1);
    const stop = news.findIndex((x) => x.type !== "para");
    // A paragraph that only holds objects staying elsewhere would come out empty.
    const paras = ((stop < 0 ? news : news.slice(0, stop)) as Para[]).filter(
      (p) => !p.runs.length || p.runs.some((r) => !("atom" in r) || !this.stuck(r.atom)),
    );
    if (!paras.length) return;
    // New paragraphs copy the one they're split from, bullet included, so
    // split the neighbour that's most like them. On a tie, split off the start
    // of the next one, which leaves the previous paragraph (and its id) alone.
    const like = (a: IBlock | undefined, p: Para) => {
      if (a?.type !== "para") return -1;
      const l = a.block.list;
      return (!!l === !!p.list ? 4 : 0) + (l && p.list && l.ordered === p.list.ordered ? 2 : 0) + (l && p.list && l.level === p.list.level ? 1 : 0) + (a.block.style === p.style ? 0.5 : 0);
    };
    const nextLike = like(next, paras.at(-1)!);
    const prevLike = like(prev, paras[0]);
    const anchor = (nextLike >= 0 && nextLike >= prevLike ? next : prevLike >= 0 ? prev : undefined) as IPara | undefined;
    if (!anchor) return this.warn("can't place new paragraphs here");
    const first = anchor === next ? next.start : prev.end;
    this.out.push({insertText: {location: this.loc(anchor === next ? next.start : prev.end - 1), text: "\n".repeat(paras.length)}});
    for (let k = paras.length - 1; k >= 0; k--) {
      if (anchor.block.list && !paras[k].list) this.out.push({deleteParagraphBullets: {range: this.range(first + k, first + k + 1)}});
    }
    for (let k = paras.length - 1; k >= 0; k--) {
      // It starts as a copy of the anchor's paragraph style; change what differs.
      const fresh: IPara = {type: "para", block: {...anchor.block, runs: []}, start: first + k, end: first + k + 1};
      this.para(fresh, paras[k]);
    }
  }

  insertTable(prev: IBlock | undefined, next: IBlock | undefined, t: Block & {type: "table"}, last: boolean) {
    // Normalization leaves a paragraph before every table.
    if (prev?.type !== "para") return this.warn("can't place a new table here");
    const at = prev.end - 1;
    const rows = t.rows.length;
    const cols = t.rows[0].length;
    this.out.push({insertTable: {rows, columns: cols, location: this.loc(at)}});
    const T = at + 1;
    const end = T + 2 + rows * (1 + 2 * cols);
    // The table brings an empty paragraph after it; drop it unless it's needed.
    if (last && next?.type === "para") this.out.push({deleteContentRange: {range: this.range(end, end + 1)}});
    this.inTable++;
    for (let r = rows - 1; r >= 0; r--) {
      for (let c = cols - 1; c >= 0; c--) {
        const s = T + 3 + r * (1 + 2 * cols) + 2 * c;
        this.segment([{type: "para", block: EMPTY, start: s, end: s + 1}], t.rows[r][c]);
      }
    }
    this.inTable--;
  }

  pair(old: IBlock, nb: Block) {
    if (old.type === "para" && nb.type === "para") this.para(old, nb);
    else if (old.type === "table" && nb.type === "table") {
      this.inTable++;
      this.table(old, nb);
      this.inTable--;
    }
  }

  table(old: ITable, nb: Block & {type: "table"}) {
    const rows = old.cells.length;
    const cols = old.cells[0]?.length ?? 0;
    const rows2 = nb.rows.length;
    const cols2 = nb.rows[0].length;
    const tableStartLocation = this.loc(old.start);
    const cell = (rowIndex: number, columnIndex: number) => ({tableStartLocation, rowIndex, columnIndex});
    const merges = (cells: (CellInfo | undefined)[][] | undefined) => {
      const out: string[] = [];
      cells?.forEach((row, r) => row.forEach((ci, c) => {
        if ((ci?.rowspan ?? 1) > 1 || (ci?.colspan ?? 1) > 1) out.push(`${r},${c},${ci!.rowspan ?? 1},${ci!.colspan ?? 1}`);
      }));
      return out;
    };
    const have = merges(old.block.cells);
    const want = merges(nb.cells);
    const range = (m: string) => {
      const [r, c, rs, cs] = m.split(",").map(Number);
      return {tableCellLocation: cell(r, c), rowSpan: rs, columnSpan: cs};
    };
    if (rows !== rows2 || cols !== cols2) {
      // Merged cells get in the way of reshaping; split them first.
      if (have.length) {
        for (const m of have) this.out.push({unmergeTableCells: {tableRange: range(m)}});
        return;
      }
      return this.reshape(old, nb);
    }
    const unmerge = have.filter((m) => !want.includes(m));
    const merge = want.filter((m) => !have.includes(m));
    if (unmerge.length || merge.length) {
      for (const m of unmerge) this.out.push({unmergeTableCells: {tableRange: range(m)}});
      for (const m of merge) this.out.push({mergeTableCells: {tableRange: range(m)}});
      return;
    }
    for (let r = rows - 1; r >= 0; r--) {
      for (let c = cols - 1; c >= 0; c--) {
        if (nb.cells?.[r]?.[c]?.covered) continue;
        this.segment(old.cells[r][c], nb.rows[r][c]);
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = old.block.cells?.[r]?.[c]?.bg;
        const b = nb.cells?.[r]?.[c]?.bg;
        if (a === b || nb.cells?.[r]?.[c]?.covered) continue;
        this.out.push({
          updateTableCellStyle: {
            tableRange: {tableCellLocation: cell(r, c), rowSpan: 1, columnSpan: 1},
            tableCellStyle: b ? {backgroundColor: rgb(b)} : {},
            fields: "backgroundColor",
          },
        });
      }
    }
  }

  // Adds and removes rows and columns where they differ, lined up by content
  // so one inserted in the middle stays in the middle. Columns go first (their
  // requests address row 0), then rows. Cells get filled next pass.
  reshape(old: ITable, nb: Block & {type: "table"}) {
    const tableStartLocation = this.loc(old.start);
    const cellKey = (c: Block[]) => normalizeTarget(c).map(contentKey).join("\n");
    const a = old.block.rows.map((row) => row.map(cellKey));
    const b = nb.rows.map((row) => row.map(cellKey));
    const cols = (g: string[][]) => g[0].map((_, c) => g.map((row) => row[c]));
    const axes = [
      ["column", alignLines(cols(a), cols(b)), cols(a).length] as const,
      ["row", alignLines(a, b), a.length] as const,
    ];
    for (const [axis, ops, count] of axes) {
      const at = (i: number) => (axis === "row" ? {tableStartLocation, rowIndex: i, columnIndex: 0} : {tableStartLocation, rowIndex: 0, columnIndex: i});
      const ins = axis === "row" ? "insertTableRow" : "insertTableColumn";
      const del = axis === "row" ? "deleteTableRow" : "deleteTableColumn";
      const after = axis === "row" ? "insertBelow" : "insertRight";
      const reqs: {at: number; req: Req}[] = [];
      let i = 0;
      for (const op of ops) {
        if (op.o !== undefined && op.n !== undefined) i++;
        else if (op.o !== undefined) reqs.push({at: i++, req: {[del]: {tableCellLocation: at(op.o)}}});
        else reqs.push({at: i - 0.5, req: {[ins]: i > 0 ? {tableCellLocation: at(i - 1), [after]: true} : {tableCellLocation: at(0), [after]: false}}});
      }
      // Last to first; same-place inserts keep their order since each goes
      // right after the same row.
      reqs.sort((x, y) => y.at - x.at);
      // Never delete every row or column before adding the new ones.
      if (reqs.filter((o) => del in o.req).length >= count) {
        reqs.splice(0, reqs.length, ...reqs.filter((o) => ins in o.req), ...reqs.filter((o) => del in o.req));
      }
      this.out.push(...reqs.map((o) => o.req));
    }
  }

  // Sets paragraph-level style on the paragraph whose newline is at `nl` (a
  // range on the newline can't split a surrogate pair). `fresh` sets
  // everything, for paragraphs that copied another's.
  paraStyle(nl: number, ob: Para, nb: Para, fresh: boolean) {
    const ps: Req = {};
    const fields: string[] = [];
    if (fresh || ob.style !== nb.style) {
      ps.namedStyleType = NAMED_TYPE[nb.style];
      fields.push("namedStyleType");
    }
    if (fresh || (ob.align ?? "left") !== (nb.align ?? "left")) {
      ps.alignment = ALIGN_API[nb.align ?? "left"];
      fields.push("alignment");
    }
    if (fresh || (ob.dir ?? "ltr") !== (nb.dir ?? "ltr")) {
      ps.direction = nb.dir === "rtl" ? "RIGHT_TO_LEFT" : "LEFT_TO_RIGHT";
      fields.push("direction");
    }
    // List items get their indent from the list (the list pass).
    if (!nb.list && (fresh || !!ob.list || (ob.indent ?? 0) !== (nb.indent ?? 0) || (ob.first ?? ob.indent ?? 0) !== (nb.first ?? nb.indent ?? 0))) {
      if (nb.indent) ps.indentStart = {magnitude: nb.indent, unit: "PT"};
      if (nb.first !== undefined || nb.indent) ps.indentFirstLine = {magnitude: nb.first ?? nb.indent, unit: "PT"};
      fields.push("indentStart", "indentFirstLine");
    }
    if (fields.length) {
      this.out.push({updateParagraphStyle: {range: this.range(nl, nl + 1), paragraphStyle: ps, fields: fields.join(",")}});
    }
  }

  para(old: IPara, nb: Para) {
    const ob = old.block;
    const base = old.start;
    type Unit = {tok: string; len: number; run: Run};
    const tokens = new Map<string, string>();
    const tok = (atom: Atom) => {
      const key = `${atom.kind}:${atom.key}`;
      if (!tokens.has(key)) tokens.set(key, String.fromCodePoint(0xf0000 + tokens.size));
      return tokens.get(key)!;
    };
    const units = (runs: Run[]): Unit[] =>
      runs.flatMap((run): Unit[] => {
        if ("text" in run) return [...run.text].map((ch) => ({tok: ch, len: ch.length, run}));
        return [{tok: tok(run.atom), len: run.atom.len ?? 1, run}];
      });
    const oldUnits = units(ob.runs);
    const newUnits = units(nb.runs);
    const here = new Set(ob.runs.flatMap((r) => ("atom" in r ? [r.atom.key] : [])));

    // Walk the diff as keep/delete/insert steps, fixing up what Docs can't do:
    // objects that can't be created are skipped, and ones that can't be moved
    // stay put.
    type Step = {kind: "keep"; o: Unit; n: Unit} | {kind: "del"; o: Unit} | {kind: "ins"; n: Unit; make?: (index: number) => number};
    const steps: Step[] = [];
    for (const seg of cleanup(oldUnits, newUnits)) {
      if (seg.t === "eq") {
        seg.o.forEach((o, k) => {
          const n = seg.n[k];
          const make = "atom" in o.run && "atom" in n.run ? this.rechip(o.run.atom, n.run.atom) : undefined;
          if (make) steps.push({kind: "del", o}, {kind: "ins", n: {...n, len: 1}, make});
          else steps.push({kind: "keep", o, n});
        });
        continue;
      }
      for (const o of seg.o) {
        const atom = "atom" in o.run ? o.run.atom : undefined;
        if (atom && this.stuck(atom)) {
          this.warn(`can't move ${atomDesc(atom)}; it stays where it was`);
          steps.push({kind: "keep", o, n: o});
        } else steps.push({kind: "del", o});
      }
      for (const u of seg.n) {
        if (!("atom" in u.run)) steps.push({kind: "ins", n: u});
        else {
          const make = this.maker(u.run.atom, here);
          if (make) steps.push({kind: "ins", n: {...u, len: 1}, make});
        }
      }
    }

    // Paragraph style first, while the newline is still where it was.
    this.paraStyle(old.end - 1, ob, nb, false);

    // Edits, last to first, in old offsets.
    const groups: {off: number; del: number; ins: Step[]}[] = [];
    let off = 0;
    for (const s of steps) {
      if (s.kind === "keep") {
        off += s.o.len;
        continue;
      }
      let g = groups.at(-1);
      if (!g || g.off + g.del !== off || (s.kind === "del" && g.ins.length)) groups.push((g = {off, del: 0, ins: []}));
      if (s.kind === "del") {
        g.del += s.o.len;
        off += s.o.len;
      } else g.ins.push(s);
    }
    for (const g of groups.reverse()) {
      const at = base + g.off;
      if (g.del) this.out.push({deleteContentRange: {range: this.range(at, at + g.del)}});
      let index = at;
      let text = "";
      const flush = () => {
        if (!text) return;
        this.out.push({insertText: {location: this.loc(index), text}});
        index += text.length;
        text = "";
      };
      for (const s of g.ins) {
        if (s.kind !== "ins") continue;
        if (!s.make) {
          text += s.n.tok;
          continue;
        }
        flush();
        index += s.make(index);
      }
      flush();
    }

    if (nb.runs.some((r) => r.style.ins || r.style.del) || ob.runs.some((r) => r.style.ins || r.style.del)) {
      const sug = (runs: Run[]) => runs.map((r) => ("text" in r ? r.text : "\u{fffc}") + (r.style.ins ? "+" : r.style.del ? "-" : "")).join("");
      if (sug(ob.runs) !== sug(nb.runs)) this.warn("suggestions (<ins>, <del>) can't be made, accepted or rejected from the file; edited text became normal text");
    }

    // Restyle only what's new or changed. A range must not start on text whose
    // link it should clear, or Docs keeps the link: it only unlinks when the
    // range starts on linked text. So ranges break wherever the old style does.
    const spans: {start: number; len: number; style: TextStyle; from: string}[] = [];
    let pos = base;
    for (const s of steps) {
      if (s.kind === "del") continue;
      const was = s.kind === "keep" ? s.o : undefined;
      const style = s.n.run.style;
      if (!was || !styleEq(was.run.style, style)) {
        const from = was ? styleKey(was.run.style) : "new";
        const last = spans.at(-1);
        if (last && last.start + last.len === pos && last.style === style && last.from === from) last.len += s.n.len;
        else spans.push({start: pos, len: s.n.len, style, from});
      }
      pos += s.n.len;
    }
    for (const sp of spans.reverse()) {
      this.out.push({
        updateTextStyle: {range: this.range(sp.start, sp.start + sp.len), textStyle: apiTextStyle(sp.style, this.defaultFont, this.ctx.tabId, this.defaultSize), fields: TEXT_FIELDS},
      });
    }
  }

  // Returns how to put a new object into a paragraph, or undefined (with a
  // warning) when Docs can't.
  maker(atom: Atom, here: Set<string>): ((index: number) => number) | undefined {
    const copy = this.objects.get(atom.key);
    if (atom.kind === "img" && (atom.attrs.src || copy?.uri)) {
      if (!atom.attrs.src) {
        this.warn(`copied ${atomDesc(atom)} to its new place, since Docs can't move or duplicate images; the copy gets a new id, and comments on the image don't carry over`);
      }
      return (index) => {
        const req: Req = {insertInlineImage: {location: this.loc(index), uri: atom.attrs.src ?? copy!.uri}};
        if (!atom.attrs.src && copy?.size) req.insertInlineImage.objectSize = copy.size;
        this.out.push(req);
        this.created.push({
          req,
          apply: (reply) => {
            const id = reply?.insertInlineImage?.objectId;
            if (!id) return;
            const {src: _, ...attrs} = atom.attrs;
            atom.key = id;
            atom.attrs = {...attrs, id};
          },
        });
        return 1;
      };
    }
    if (atom.kind === "pagebreak") {
      if (this.inTable || this.ctx.segmentId) {
        this.warn("<pagebreak> can't go inside a table, header, footer or footnote");
        return undefined;
      }
      return (index) => {
        // The break comes with a newline; remove it to keep one paragraph.
        this.out.push({insertPageBreak: {location: this.loc(index)}});
        this.out.push({deleteContentRange: {range: this.range(index + 1, index + 2)}});
        return 1;
      };
    }
    if (atom.kind === "chip" && !atom.attrs.id) return this.chipMaker(atom);
    if (atom.kind === "footnote" && !atom.attrs.id) {
      if (this.ctx.segmentId) {
        this.warn("a <footnote> can't go inside a header, footer or footnote");
        return undefined;
      }
      return (index) => {
        const req: Req = {createFootnote: {location: this.loc(index)}};
        this.out.push(req);
        const tabId = this.ctx.tabId;
        this.created.push({
          req,
          apply: (reply) => {
            const id = reply?.createFootnote?.footnoteId;
            if (!id) return;
            const text = atom.attrs.text ?? "";
            atom.key = id;
            atom.attrs = {id};
            this.addFootnote(tabId, id, text);
          },
        });
        return 1;
      };
    }
    // One the doc keeps elsewhere already got a "stays where it was" warning.
    if (this.stuck(atom) && !here.has(atom.key)) return undefined;
    if (this.objects.has(atom.key) || this.remoteKeys.has(atom.key) || here.has(atom.key)) {
      this.warn(`can't move or copy ${atomDesc(atom)}; leave it where it was or delete it`);
    } else {
      this.warn(`can't create <${atom.kind}>; only <img src>, <pagebreak>, <footnote>, and <chip> without an id can be added`);
    }
    return undefined;
  }

  // A chip with no id: one to create. The doc gives it an id, which the next
  // pass adopts (see adoptNew).
  chipMaker(atom: Atom): ((index: number) => number) | undefined {
    const a = atom.attrs;
    const need = (attr: string) => {
      this.warn(`a new <chip type="${a.type}"> needs ${attr}="…"`);
      return undefined;
    };
    let reqs: Req[];
    if (a.type === "person") {
      if (!a.email) return need("email");
      reqs = [{insertPerson: {personProperties: {email: a.email, ...(a.name ? {name: a.name} : {})}}}];
    } else if (a.type === "link") {
      if (!a.href) return need("href");
      reqs = [{insertRichLink: {richLinkProperties: {uri: a.href}}}];
    } else if (a.type === "date") {
      const ts = timestamp(a.date);
      if (!ts) return a.date ? (this.warn(`can't read the date "${a.date}"; write it like 2026-10-31`), undefined) : need("date");
      reqs = [{insertDate: {dateElementProperties: {timestamp: ts}}}];
    } else if (a.type === "dropdown") {
      if (!a.value) return need("value");
      const pick = this.dropdownFor(a.value, a.options);
      if (!pick) return undefined;
      reqs = [...pick.reqs, {insertDropdown: {dropdownDefinitionId: pick.def.id, selectedOptionId: pick.option}}];
    } else {
      this.warn(`can't create a <chip type="${a.type ?? ""}">; types are person, link, date, dropdown`);
      return undefined;
    }
    return (index) => {
      const last = reqs.at(-1)!;
      Object.values(last)[0].location = this.loc(index);
      this.out.push(...reqs);
      return 1;
    };
  }

  // A definition with an option named `value`: the one `options` ("a|b|c")
  // describes, made if needed, or else any in the tab that has that option.
  dropdownFor(value: string, options: string | undefined): {def: DropdownDef; option: string; reqs: Req[]} | undefined {
    const tab = this.ctx.tabId ?? "";
    const defs = this.dropdowns.defs.get(tab) ?? [];
    const pickIn = (def: DropdownDef) => def.options.find((o) => o.value === value)?.id;
    if (options) {
      const values = options.split("|").map((v) => v.trim()).filter(Boolean);
      if (!values.includes(value)) values.unshift(value);
      if (values.length < 2) {
        this.warn("a dropdown needs at least 2 options");
        return undefined;
      }
      const same = (d: DropdownDef) => d.options.map((o) => o.value).join("|") === values.join("|");
      const have = defs.find(same) ?? this.dropdowns.made.get(`${tab}|${values.join("|")}`);
      if (have) return {def: have, option: pickIn(have)!, reqs: []};
      const tag = Math.random().toString(36).slice(2, 10);
      const def: DropdownDef = {id: `kix.goog${tag}`, options: values.map((v, k) => ({id: `dropdownItem.goog${tag}${k}`, value: v}))};
      this.dropdowns.made.set(`${tab}|${values.join("|")}`, def);
      const props = {title: "Dropdown", options: def.options.map((o) => ({optionId: o.id, displayValue: o.value}))};
      const req: Req = {createDropdownDefinition: {dropdownDefinition: {dropdownDefinitionId: def.id, dropdownDefinitionProperties: props}}};
      if (this.ctx.tabId) req.createDropdownDefinition.tabId = this.ctx.tabId;
      return {def, option: def.options.find((o) => o.value === value)!.id, reqs: [req]};
    }
    for (const def of defs) {
      const option = pickIn(def);
      if (option) return {def, option, reqs: []};
    }
    this.warn(`no dropdown in the doc has the option "${value}"; add options="${value}|…" to make a new kind of dropdown`);
    return undefined;
  }

  // A chip kept in place whose attributes were edited. Dropdowns get the new
  // value; a person, link or date chip can't be changed, so it's replaced.
  rechip(o: Atom, n: Atom): ((index: number) => number) | undefined {
    if (o.kind !== "chip" || n.kind !== "chip" || !n.attrs.id) return undefined;
    const a = o.attrs;
    const b = n.attrs;
    if (b.type === "dropdown") {
      if (!b.value || b.value === a.value) return undefined;
      const defId = this.dropdowns.of.get(b.id);
      const def = [...this.dropdowns.defs.values()].flat().find((d) => d.id === defId);
      const option = def?.options.find((x) => x.value === b.value);
      if (!option) {
        this.warn(`the dropdown ${b.id} has no option "${b.value}"${def ? `; its options are ${def.options.map((x) => x.value).join(", ")}` : ""}`);
        return undefined;
      }
      const req: Req = {updateDropdownProperties: {dropdownId: b.id, dropdownProperties: {selectedOptionId: option.id}, fields: "selectedOptionId"}};
      if (this.ctx.tabId) req.updateDropdownProperties.tabId = this.ctx.tabId;
      this.out.push(req);
      return undefined;
    }
    const changed =
      b.type === "person" ? (b.email ?? "").toLowerCase() !== (a.email ?? "").toLowerCase() :
      b.type === "link" ? (b.href ?? "") !== (a.href ?? "") :
      b.type === "date" ? timestamp(b.date) !== timestamp(a.date) : false;
    if (!changed || (b.type === "person" && !b.email) || (b.type === "link" && !b.href) || (b.type === "date" && !timestamp(b.date))) return undefined;
    const {id: _, ...rest} = b;
    const fresh: Atom = {kind: "chip", key: atomKey("chip", rest), attrs: rest};
    const make = this.chipMaker(fresh);
    if (!make) return undefined;
    // The new chip has no id until the next pass adopts it.
    n.attrs = rest;
    n.key = fresh.key;
    return make;
  }

  // ---------- list pass ----------

  lists(seg: ISegment, target: Block[]) {
    target = normalizeTarget(target);
    // Content normally matches block for block by now. When something
    // couldn't be made (an object that can't move, say), pair up only the
    // blocks that match, and don't let a list run across the gaps.
    const gap: boolean[] = seg.map(() => false);
    const ka = seg.map((b) => contentKey(b.block));
    const kb = target.map(contentKey);
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) {
      const S: ISegment = [];
      const T: Block[] = [];
      gap.length = 0;
      let i = 0;
      let j = 0;
      let pending = false;
      for (const part of diffArrays(ka, kb)) {
        const n = part.count!;
        if (part.added) j += n;
        else if (part.removed) i += n;
        else {
          for (let k = 0; k < n; k++) {
            S.push(seg[i++]);
            T.push(target[j++]);
            gap.push(pending);
            pending = false;
          }
          continue;
        }
        pending = true;
      }
      seg = S;
      target = T;
    }
    type Item = {at: number; reqs: Req[]};
    const items: Item[] = [];
    for (let i = seg.length - 1; i >= 0; i--) {
      const s = seg[i];
      const t = target[i];
      if (s.type === "table" && t.type === "table" && s.cells.length === t.rows.length) {
        for (let r = s.cells.length - 1; r >= 0; r--) {
          for (let c = s.cells[r].length - 1; c >= 0; c--) {
            if (!t.rows[r][c]) continue;
            const before = this.out.length;
            this.lists(s.cells[r][c], t.rows[r][c]);
            const reqs = this.out.splice(before);
            if (reqs.length) items.push({at: s.cells[r][c][0]?.start ?? s.start, reqs});
          }
        }
      }
    }
    let prevPreset: string | undefined;
    let prevEnd = -1;
    let i = 0;
    while (i < seg.length) {
      const t = target[i];
      const s = seg[i];
      if (t.type !== "para" || s.type !== "para") {
        i++;
        continue;
      }
      if (!t.list) {
        if (s.block.list) {
          items.push({at: s.start, reqs: [{deleteParagraphBullets: {range: this.range(s.end - 1, s.end)}}, this.indent(s.end - 1, s.end, t)]});
        }
        i++;
        continue;
      }
      // A Docs list has one glyph style per nesting level, so a top-level item
      // with a different glyph, or one marked start=, starts a new list.
      const top = t.list;
      let j = i;
      while (j + 1 < seg.length && !gap[j + 1] && target[j + 1].type === "para" && seg[j + 1].type === "para") {
        const next = (target[j + 1] as Para).list;
        if (!next || next.start !== undefined || (next.level <= top.level && (next.ordered !== top.ordered || wantGlyph(next) !== wantGlyph({...top, level: next.level})))) break;
        j++;
      }
      const run = seg.slice(i, j + 1) as IPara[];
      const want = (target.slice(i, j + 1) as Para[]).map((p) => p.list!);
      const preset = pickPreset(want);
      const listId = run[0].listId;
      const prevListId = i > 0 && !gap[i] && seg[i - 1].type === "para" ? (seg[i - 1] as IPara).listId : undefined;
      // Same-preset lists that touch become one in Docs.
      const joined = prevEnd === i - 1 && !gap[i] && prevPreset === preset[0];
      const shaped = run.every((p, k) => p.block.list && p.listId === listId && p.block.list.level === want[k].level);
      const separate = joined || prevListId === undefined || listId !== prevListId;
      const exact = shaped && separate && run.every((p, k) => p.block.list!.ordered === want[k].ordered && wantGlyph(p.block.list!) === wantGlyph(want[k]));
      // What the best preset can do, when the file asks for more.
      const best = shaped && separate && run.every((p, k) => p.block.list!.ordered === preset[1] && wantGlyph(p.block.list!) === presetGlyph(preset, want[k].level));
      const ok = exact || best;
      if (!exact) {
        const bad = want.find((l) => presetGlyph(preset, l.level) !== wantGlyph(l) || l.ordered !== preset[1]);
        if (bad) {
          this.warn(`a list item can't have type="${bad.glyph ?? (bad.ordered ? "1" : "bullet")}" at level ${bad.level + 1} in that list; Docs lists take their glyphs from one preset (${preset[0].toLowerCase()})`);
        }
        if (joined && !(listId !== prevListId && shaped)) this.warn("two lists of the same kind can't sit right next to each other in Docs; they became one list");
      }
      if (top.start !== undefined && top.start !== 1 && run[0].block.list?.start !== top.start) {
        this.warn(`Docs can't set where a list starts counting (start="${top.start}")`);
      }
      // Only some top-level items off (say, a paragraph turned into an item):
      // re-bullet just those, in order, so each joins the list right above it.
      // Joining ignores nesting tabs (live-verified), so items that belong at
      // a deeper level need the whole list rebuilt.
      const good = (p: IPara, k: number) =>
        p.block.list && p.listId === listId && p.block.list.level === want[k].level &&
        (wantGlyph(p.block.list) === wantGlyph(want[k]) || wantGlyph(p.block.list) === presetGlyph(preset, want[k].level));
      const fixable = run.every((p, k) => good(p, k) || want[k].level === 0);
      if (!ok && listId && separate && fixable && good(run[0], 0)) {
        const reqs: Req[] = [];
        run.forEach((p, k) => {
          if (good(p, k)) return;
          const r = this.range(p.start, Math.max(p.end - 1, p.start + 1));
          if (p.block.list) reqs.push({deleteParagraphBullets: {range: r}});
          reqs.push(this.indent(r.startIndex, r.endIndex));
          reqs.push({createParagraphBullets: {range: r, bulletPreset: preset[0]}});
        });
        items.push({at: run[0].start, reqs});
      } else if (!ok) {
        const reqs: Req[] = [];
        const first = run[0];
        const last = run.at(-1)!;
        const whole = this.range(first.start, Math.max(last.end - 1, first.start + 1));
        // Removing bullets leaves their indent behind, which would stack with
        // the tabs that set the new nesting level.
        if (run.some((p) => p.block.list)) reqs.push({deleteParagraphBullets: {range: whole}});
        reqs.push(this.indent(whole.startIndex, whole.endIndex));
        let tabs = 0;
        for (let k = run.length - 1; k >= 0; k--) {
          const level = want[k].level;
          if (level) reqs.push({insertText: {location: this.loc(run[k].start), text: "\t".repeat(level)}});
          tabs += level;
        }
        reqs.push({
          createParagraphBullets: {range: this.range(first.start, Math.max(last.end - 1, first.start + 1) + tabs), bulletPreset: preset[0]},
        });
        items.push({at: first.start, reqs});
      }
      prevPreset = preset[0];
      prevEnd = j;
      i = j + 1;
    }
    items.sort((a, b) => b.at - a.at);
    for (const it of items) this.out.push(...it.reqs);
  }

  indent(start: number, end: number, p?: Para): Req {
    const ps: Req = {};
    if (p?.indent) ps.indentStart = {magnitude: p.indent, unit: "PT"};
    if (p && (p.first !== undefined || p.indent)) ps.indentFirstLine = {magnitude: p.first ?? p.indent, unit: "PT"};
    return {updateParagraphStyle: {range: this.range(start, end), paragraphStyle: ps, fields: "indentStart,indentFirstLine"}};
  }
}

function atomDesc(atom: Atom): string {
  return `<${atom.kind}${atom.attrs.id ? ` id="${atom.attrs.id}"` : ""}>`;
}

// A date chip's date as the API wants it. A bare date is midnight UTC, which
// is how Docs stores a date without a time.
function timestamp(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const t = Date.parse(/^\d{4}-\d\d-\d\d$/.test(date) ? `${date}T00:00:00Z` : date);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().replace(".000Z", "Z");
}

function remoteDropdowns(api: any): Dropdowns {
  const out: Dropdowns = {defs: new Map(), of: new Map(), made: new Map()};
  const tabs: [string, any][] = [];
  const walk = (ts: any[]) => ts.forEach((t) => (tabs.push([t.tabProperties?.tabId ?? "", t.documentTab ?? {}]), walk(t.childTabs ?? [])));
  if (api?.tabs) walk(api.tabs);
  else if (api) tabs.push(["", api]);
  const find = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(find);
    if (node.dropdown?.dropdownId) out.of.set(node.dropdown.dropdownId, node.dropdown.dropdownProperties?.dropdownDefinitionId);
    for (const v of Object.values(node)) if (v && typeof v === "object") find(v);
  };
  tabs.forEach(([id, dt], k) => {
    const defs = Object.values<any>(dt.dropdownDefinitions ?? {}).map((d) => ({
      id: d.dropdownDefinitionId,
      options: (d.dropdownDefinitionProperties?.options ?? []).map((o: any) => ({id: o.optionId, value: o.displayValue})),
    }));
    out.defs.set(id, defs);
    if (k === 0) out.defs.set("", defs);
    find(dt);
  });
  return out;
}

// Chips get no id in the batchUpdate reply, so after a push the new ones in
// `want` (chips without an id) take the ids of the chips the doc has that
// `want` doesn't know, in document order, type by type.
export function adoptNew(want: Doc | Block[], remote: Doc) {
  const atoms = (d: Doc | Block[]): Atom[] => {
    const out: Atom[] = [];
    const walk = (blocks: Block[]) => {
      for (const b of blocks) {
        if (b.type === "para") for (const r of b.runs) if ("atom" in r && r.atom.kind === "chip") out.push(r.atom);
        if (b.type === "table") for (const row of b.rows) for (const c of row) walk(c);
      }
    };
    if (Array.isArray(d)) walk(d);
    else for (const t of d.tabs ?? [{blocks: d.blocks, segments: d.segments}]) {
      walk(t.blocks);
      for (const s of t.segments ?? []) walk(s.blocks);
    }
    return out;
  };
  const mine = atoms(want);
  const fresh = mine.filter((a) => !a.attrs.id);
  if (!fresh.length) return;
  const known = new Set(mine.map((a) => a.attrs.id).filter(Boolean));
  const unknown = atoms(Array.isArray(want) ? remote.blocks : remote).filter((a) => a.attrs.id && !known.has(a.attrs.id));
  for (const a of fresh) {
    const k = unknown.findIndex((u) => u.attrs.type === a.attrs.type);
    if (k < 0) continue;
    const [u] = unknown.splice(k, 1);
    a.attrs = {...u.attrs};
    a.key = u.key;
  }
}

function collectKeys(blocks: Block[], out: Set<string>) {
  for (const b of blocks) {
    if (b.type === "para") for (const r of b.runs) if ("atom" in r) out.add(r.atom.key);
    if (b.type === "table") for (const row of b.rows) for (const c of row) collectKeys(c, out);
  }
}

function remoteObjects(api: any): Map<string, RemoteObj> {
  const out = new Map<string, RemoteObj>();
  const tabs: any[] = [];
  const walk = (ts: any[]) => ts.forEach((t) => (tabs.push(t.documentTab ?? {}), walk(t.childTabs ?? [])));
  if (api?.tabs) walk(api.tabs);
  else if (api) tabs.push(api);
  for (const dt of tabs) {
    for (const [id, obj] of Object.entries<any>(dt.inlineObjects ?? {})) {
      const emb = obj.inlineObjectProperties?.embeddedObject ?? {};
      const uri = emb.imageProperties?.contentUri;
      out.set(id, {uri: emb.embeddedDrawingProperties || emb.linkedContentReference ? undefined : uri, size: emb.size});
    }
  }
  return out;
}

function tabApi(api: any, tabId: string | undefined): any {
  if (!api?.tabs) return api;
  let found: any;
  const walk = (ts: any[]) => ts.forEach((t) => {
    if (!found && (tabId === undefined || t.tabProperties?.tabId === tabId)) found = t.documentTab;
    walk(t.childTabs ?? []);
  });
  walk(api.tabs);
  return found;
}

interface Unit {
  ctx: Ctx;
  footnote?: boolean;
  seg: ISegment;
  target: Block[];
  defaults: Record<string, Defaults>;
}

function units(remote: PlanRemote, target: Doc, warnings: string[], created: Created[]): {units: Unit[]; reqs: Req[]} {
  const out: Unit[] = [];
  const reqs: Req[] = [];
  const warn = (m: string) => warnings.includes(m) || warnings.push(m);
  const name = (kind: string) => (kind === "footnote" ? "footnote text" : kind);
  const segs = (have: RSegment[], want: Segment[], tabId: string | undefined, dt: any) => {
    const defaults = namedDefaults(dt);
    const tab = tabId ? {tabId} : {};
    for (const s of want) {
      // Its footnote mark is gone from the text, and deleting that deletes this
      // too (in the same batch, so don't edit it).
      if (s.kind === "footnote" && !keysOf(target, tabId).has(s.id)) continue;
      const r = s.id ? have.find((x) => x.kind === s.kind && x.id === s.id) : undefined;
      if (r) {
        const fn = s.kind === "footnote";
        out.push({ctx: {segmentId: s.id, ...tab}, seg: r.body, target: s.blocks, defaults: fn ? footnoteDefaults(defaults) : defaults, footnote: fn});
        continue;
      }
      if (s.kind === "footnote" || s.id) {
        warn(`the ${name(s.kind)} ${s.id} doesn't exist in the doc; it can't be created from the file${s.kind === "footnote" ? "" : " (leave out the id to add a new one)"}`);
        continue;
      }
      if (s.attrs?.type) {
        warn(`can't create a ${s.attrs.type}-page ${s.kind}; only the default one`);
        continue;
      }
      if (have.some((x) => x.kind === s.kind && !x.attrs?.type)) {
        warn(`the doc already has a ${s.kind}; edit that one instead of adding another`);
        continue;
      }
      // Created now, filled next pass once it has an id.
      const kind = s.kind === "header" ? "createHeader" : "createFooter";
      const req: Req = {[kind]: {type: "DEFAULT", ...(tabId ? {sectionBreakLocation: {index: 0, tabId}} : {})}};
      reqs.push(req);
      created.push({req, apply: (reply) => (s.id = reply?.[kind]?.[s.kind === "header" ? "headerId" : "footerId"] ?? s.id)});
    }
    for (const r of have) {
      if (want.some((s) => s.kind === r.kind && s.id === r.id)) continue;
      if (r.kind === "footnote") {
        // Deleting the footnote mark in the text deletes this too.
        if (keysOf(target, tabId).has(r.id)) warn(`the footnote text ${r.id} was removed from the file but its footnote is still in the text; delete the <footnote> to remove both`);
        continue;
      }
      const kind = r.kind === "header" ? "deleteHeader" : "deleteFooter";
      reqs.push({[kind]: {[r.kind === "header" ? "headerId" : "footerId"]: r.id, ...tab}});
      warn(`deleted the ${r.kind} ${r.id}, since the file doesn't have it`);
    }
  };
  const bodyOnly = !!(target as any).bodyOnly;
  if (!remote.tabs || !target.tabs) {
    const dt = tabApi(remote.api, undefined);
    out.push({ctx: {}, seg: remote.body, target: target.blocks, defaults: namedDefaults(dt)});
    if (!bodyOnly) segs(remote.segments, target.segments ?? [], undefined, dt);
    if (remote.tabs && !target.tabs && !bodyOnly) warn("the file has no <tab> lines, so only the first tab was pushed");
    if (!remote.tabs && target.tabs && target.tabs.length > 1) addTabs(target.tabs.slice(1));
    return {units: out, reqs};
  }
  function addTabs(tabs: NonNullable<Doc["tabs"]>) {
    for (const t of tabs) {
      if (t.id && remote.tabs?.some((r) => r.id === t.id)) continue;
      if (t.id) {
        warn(`tab ${JSON.stringify(t.title)} (${t.id}) doesn't exist in the doc (leave out the id to add a new tab)`);
        continue;
      }
      const props: Req = {title: t.title};
      if (t.icon) props.iconEmoji = t.icon;
      if (t.parent) props.parentTabId = t.parent;
      const req: Req = {addDocumentTab: {tabProperties: props}};
      reqs.push(req);
      created.push({req, apply: (reply) => (t.id = reply?.addDocumentTab?.tabProperties?.tabId ?? t.id)});
    }
  }
  addTabs(target.tabs);
  for (const t of target.tabs) {
    const r = remote.tabs.find((x) => x.id === t.id);
    if (!r) continue;
    const props: Req = {tabId: t.id};
    const fields: string[] = [];
    if (r.title !== t.title) {
      props.title = t.title;
      fields.push("title");
    }
    if ((r.icon ?? "") !== (t.icon ?? "")) {
      if (t.icon) props.iconEmoji = t.icon;
      fields.push("iconEmoji");
    }
    if (fields.length) reqs.push({updateDocumentTabProperties: {tabProperties: props, fields: fields.join(",")}});
    if ((r.parent ?? "") !== (t.parent ?? "")) warn(`tab ${JSON.stringify(t.title)}: moving tabs under other tabs isn't supported`);
    const dt = tabApi(remote.api, t.id);
    out.push({ctx: {tabId: t.id}, seg: r.body, target: t.blocks, defaults: namedDefaults(dt)});
    segs(r.segments, t.segments ?? [], t.id, dt);
  }
  // Docs needs at least one tab.
  const survives = target.tabs.some((t) => !t.id || remote.tabs!.some((r) => r.id === t.id));
  for (const r of remote.tabs) {
    if (target.tabs.some((t) => t.id === r.id)) continue;
    if (!survives) {
      warn("can't delete every tab");
      break;
    }
    reqs.push({deleteTab: {tabId: r.id}});
    warn(`deleted the tab ${JSON.stringify(r.title)}, since the file doesn't have it`);
  }
  return {units: out, reqs};
}

// Which checklist items are ticked, in order, as a string of 0s and 1s.
function checks(doc: Doc): string {
  let out = "";
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.type === "para" && b.list?.glyph === "check") out += b.list.checked ? "1" : "0";
      if (b.type === "table") for (const row of b.rows) for (const c of row) walk(c);
    }
  };
  for (const t of doc.tabs ?? [{blocks: doc.blocks}]) walk(t.blocks);
  return out;
}

function keysOf(doc: Doc, tabId: string | undefined): Set<string> {
  const out = new Set<string>();
  const tab = tabId && doc.tabs ? doc.tabs.find((t) => t.id === tabId) : undefined;
  collectKeys(tab ? tab.blocks : doc.blocks, out);
  for (const s of (tab ? tab.segments : doc.segments) ?? []) collectKeys(s.blocks, out);
  return out;
}

export function plan(remote: PlanRemote, target: Doc | Block[]): Plan {
  // A bare Block[] is just the body: segments and tabs are left alone.
  const doc: Doc & {bodyOnly?: boolean} = Array.isArray(target) ? {kind: "doc", id: remote.doc.id, blocks: target, bodyOnly: true} : target;
  const warnings: string[] = [];
  const created: Created[] = [];
  const {units: work, reqs: tabReqs} = units(remote, doc, warnings, created);
  if (checks(remote.doc) !== checks(doc) && checks(remote.doc).length === checks(doc).length) {
    warnings.push("ticking or unticking checklist items can't be done through the Docs API; tick them in Docs");
  }
  const keep = new Set<string>();
  for (const u of work) collectKeys(u.target, keep);
  const remoteKeys = new Set<string>();
  for (const b of [remote.doc, ...(remote.doc.tabs ?? [])]) {
    collectKeys(b.blocks, remoteKeys);
    for (const s of b.segments ?? []) collectKeys(s.blocks, remoteKeys);
  }
  const addFootnote = (tabId: string | undefined, id: string, text: string) => {
    const tab = tabId && doc.tabs ? doc.tabs.find((t) => t.id === tabId) : undefined;
    const holder: {segments?: Segment[]} = tab ?? doc;
    (holder.segments ??= []).push({kind: "footnote", id, blocks: [{type: "para", style: "p", runs: text ? [{text, style: {}}] : []}]});
  };
  const shared: Shared = {warnings, created, objects: remoteObjects(remote.api), keep, remoteKeys, dropdowns: remoteDropdowns(remote.api), addFootnote};
  const run = (fn: (p: Planner, u: Unit, target: Block[]) => void): Req[] => {
    const all: Req[] = [];
    for (const u of work) {
      const p = new Planner(shared);
      p.ctx = u.ctx;
      p.defaultFont = u.defaults.NORMAL_TEXT?.font;
      if (u.footnote) p.defaultSize = FOOTNOTE_SIZE;
      fn(p, u, dropDefaults(u.target, u.defaults));
      all.push(...p.out);
    }
    return all;
  };
  const content = [...tabReqs, ...run((p, u, t) => p.segment(u.seg, t))];
  if (content.length) return {pass: "content", requests: content, warnings, created};
  created.length = 0;
  const lists = run((p, u, t) => p.lists(u.seg, t));
  if (lists.length) return {pass: "lists", requests: lists, warnings, created: []};
  return {pass: "done", requests: [], warnings, created: []};
}
