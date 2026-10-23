// Reads and writes the .goog text format. One paragraph per line, HTML-ish tags
// for formatting. See README.md and `goog help format` for the syntax.

import {
  type Align, type Atom, type Block, type CellInfo, type Doc, type ListInfo, type Para, type ParaStyle, type Run,
  type Segment, type Tab, type Table, type TextStyle, DEFAULT_MARK, atomKey, normalizeRuns,
} from "./model.ts";

const PARA_TAGS = new Set(["p", "title", "subtitle", "h1", "h2", "h3", "h4", "h5", "h6", "li"]);
const BLOCK_TAGS = new Set([...PARA_TAGS, "table", "object"]);
// Only at the top level of the file: tab markers and header/footer/footnote text.
const SEGMENT_TAGS: Record<string, Segment["kind"]> = {header: "header", footer: "footer", "footnote-text": "footnote"};
const SEGMENT_TAG: Record<Segment["kind"], string> = {header: "header", footer: "footer", footnote: "footnote-text"};
const TOP_TAGS = new Set(["tab", ...Object.keys(SEGMENT_TAGS)]);
const STYLE_TAGS = new Set(["ins", "del", "a", "mark", "span", "b", "i", "u", "s", "sup", "sub"]);
const ATOM_TAGS = new Set(["img", "hr", "pagebreak", "columnbreak", "footnote", "chip", "equation", "autotext", "obj"]);
const NUMBER_TYPES = new Set(["1", "01", "a", "A", "i", "I"]);
const PLAIN_BULLET_TYPES = new Set(["disc", "bullet", "circle", "square"]);
const DEFAULT_OPAQUE_KEY: Record<string, string> = {"section-break": "section"};
const EMPTY: Para = {type: "para", style: "p", runs: []};

const COLOR_NAMES: Record<string, string> = {
  yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", blue: "#0000ff", pink: "#ff00ff",
  magenta: "#ff00ff", red: "#ff0000", orange: "#ff9900", purple: "#9900ff", gray: "#999999",
  grey: "#999999", black: "#000000", white: "#ffffff",
};

export class FormatError extends Error {
  line: number;
  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

// ---------- writing ----------

// Characters that are invisible or break lines in an editor get written as
// entities so an agent can see (and keep) them. ZWJ and variation selectors
// stay raw: they're part of emoji.
const INVISIBLE = /[\u0000-\u0008\u000c-\u001f\u007f\u00a0\u00ad\u200b\u200e\u200f\u2028\u2029\u2060\ufeff]/g;

export function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(INVISIBLE, (ch) => (ch === "\u00a0" ? "&nbsp;" : `&#x${ch.codePointAt(0)!.toString(16)};`));
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
    .replace(/[\n\r\t\u000b]/g, (ch) => `&#${ch.codePointAt(0)};`);
}

export function attrs(pairs: [string, string | number | boolean | undefined][]): string {
  return pairs
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${escapeAttr(String(v))}"`))
    .join("");
}

type Tag = {name: string; open: string};

function tagsFor(style: TextStyle): Tag[] {
  const tags: Tag[] = [];
  if (style.ins) tags.push({name: "ins", open: "<ins>"});
  if (style.del) tags.push({name: "del", open: "<del>"});
  if (style.href) tags.push({name: "a", open: `<a${attrs([["href", style.href]])}>`});
  if (style.mark) {
    tags.push({name: "mark", open: style.mark === DEFAULT_MARK ? "<mark>" : `<mark${attrs([["color", style.mark]])}>`});
  }
  if (style.color || style.font || style.size || style.weight || style.smallcaps) {
    tags.push({
      name: "span",
      open: `<span${attrs([["color", style.color], ["font", style.font], ["size", style.size], ["weight", style.weight], ["smallcaps", style.smallcaps]])}>`,
    });
  }
  for (const k of ["b", "i", "u", "s", "sup", "sub"] as const) if (style[k]) tags.push({name: k, open: `<${k}>`});
  return tags;
}

function atomHtml(atom: Atom): string {
  return `<${atom.kind}${attrs(Object.entries(atom.attrs))}>`;
}

export function runsHtml(runs: Run[]): string {
  let out = "";
  let stack: Tag[] = [];
  for (const run of runs) {
    const want = tagsFor(run.style);
    let keep = 0;
    while (keep < stack.length && keep < want.length && stack[keep].open === want[keep].open) keep++;
    for (let i = stack.length - 1; i >= keep; i--) out += `</${stack[i].name}>`;
    for (let i = keep; i < want.length; i++) out += want[i].open;
    stack = want;
    out += "text" in run ? escapeText(run.text).replace(/\u000b/g, "<br>") : atomHtml(run.atom);
  }
  for (let i = stack.length - 1; i >= 0; i--) out += `</${stack[i].name}>`;
  return out;
}

function paraAttrs(p: Para): [string, string | number | boolean | undefined][] {
  return [
    ["id", p.id],
    ["align", p.align && p.align !== "left" ? p.align : undefined],
    ["dir", p.dir],
    ["indent", p.indent],
    ["first", p.first],
    ["float", p.float?.length ? p.float.join(" ") : undefined],
  ];
}

// A paragraph can be written as a bare line only if reading the line back
// gives exactly the same paragraph.
function canBeBare(p: Para): boolean {
  if (p.style !== "p" || p.list || paraAttrs(p).some(([, v]) => v !== undefined)) return false;
  if (!p.runs.length) return false;
  const first = p.runs[0];
  const last = p.runs.at(-1)!;
  if ("text" in first && /^\s/.test(first.text)) return false;
  if ("text" in last && /\s$/.test(last.text)) return false;
  return true;
}

function paraTag(p: Para, bare: boolean): string {
  const content = runsHtml(p.runs);
  if (p.list) {
    return `<li${attrs([
      ["level", p.list.level > 0 ? p.list.level + 1 : undefined],
      ["type", p.list.glyph],
      ["start", p.list.start],
      ["checked", p.list.checked ? true : undefined],
      ["style", p.style !== "p" ? p.style : undefined],
      ...paraAttrs(p),
    ])}>${content}</li>`;
  }
  if (bare && canBeBare(p)) {
    // A line of ======= would read as a merge conflict marker.
    return content.replace(/^=/, "&#61;");
  }
  return `<${p.style}${attrs(paraAttrs(p))}>${content}</${p.style}>`;
}

const isPlainEmpty = (b: Block | undefined) =>
  b?.type === "para" && b.style === "p" && !b.list && !b.runs.length && !paraAttrs(b).some(([, v]) => v !== undefined);

// Docs needs a paragraph in some places the file doesn't: a segment (body,
// cell, header…) is never empty, can't start or end with a table, and two
// tables can't touch. A plain empty paragraph there is implied, so the file
// leaves it out and parse() puts it back.
export function isFiller(blocks: Block[], i: number): boolean {
  if (!isPlainEmpty(blocks[i])) return false;
  const prev = blocks[i - 1];
  const next = blocks[i + 1];
  if (blocks.length === 1) return true;
  if (i === 0) return next?.type === "table";
  if (i === blocks.length - 1) return prev?.type === "table";
  return prev?.type === "table" && next?.type === "table";
}

export const visible = (blocks: Block[]) => blocks.filter((_, i) => !isFiller(blocks, i));

export function addFillers(blocks: Block[]): Block[] {
  const empty = (): Para => ({type: "para", style: "p", runs: []});
  const out: Block[] = [];
  blocks.forEach((b, i) => {
    if (b.type === "table" && (i === 0 || blocks[i - 1].type === "table")) out.push(empty());
    out.push(b);
  });
  if (!out.length || out.at(-1)!.type === "table") out.push(empty());
  return out;
}

const isEmptyCell = (blocks: Block[]) => !visible(blocks).length;

function cellHtml(blocks: Block[]): string {
  const shown = visible(blocks);
  if (!shown.length) return "";
  const only = shown.length === 1 ? shown[0] : undefined;
  if (only?.type === "para") return paraTag(only, true);
  return shown.map((b) => blockLines(b, false).join("")).join("");
}

function tdHtml(cell: Block[], ci: CellInfo | undefined): string {
  if (ci?.covered && !ci.bg && !ci.colspan && !ci.rowspan && isEmptyCell(cell)) return "";
  return `<td${attrs([["colspan", ci?.colspan], ["rowspan", ci?.rowspan], ["bg", ci?.bg], ["covered", ci?.covered]])}>${cellHtml(cell)}</td>`;
}

function opaqueHtml(b: Block & {type: "opaque"}): string {
  const id = b.key === (DEFAULT_OPAQUE_KEY[b.kind] ?? b.kind) ? undefined : b.key;
  return `<object${attrs([["kind", b.kind], ["id", id], ...Object.entries(b.attrs ?? {})])}>`;
}

export function blockLines(b: Block, bare: boolean): string[] {
  if (b.type === "para") return [paraTag(b, bare)];
  if (b.type === "opaque") return [opaqueHtml(b)];
  const rows = b.rows.map((row, r) => "<tr>" + row.map((cell, c) => tdHtml(cell, b.cells?.[r]?.[c])).join("") + "</tr>");
  return bare ? ["<table>", ...rows, "</table>"] : ["<table>" + rows.join("") + "</table>"];
}

export function header(doc: Doc): string {
  // No revision here: goog keeps that itself, so the file only changes when the doc does.
  // "--" can't appear inside an HTML comment, so a title with "-->" stays harmless.
  const name = doc.name ? ` · ${JSON.stringify(doc.name).replace(/--/g, "-\\u002d")}` : "";
  return `<!-- goog doc ${doc.id}${name} -->`;
}

function bodyLines(all: Block[], lines: string[]) {
  const blocks = visible(all);
  blocks.forEach((b, i) => {
    const spaced = b.type === "table" || (b.type === "para" && /^(h\d|title|subtitle)$/.test(b.style));
    if (spaced && i > 0 && lines.at(-1) !== "") lines.push("");
    lines.push(...blockLines(b, true));
    if (spaced && i < blocks.length - 1) lines.push("");
  });
}

function segmentLines(segments: Segment[] | undefined, lines: string[]) {
  for (const s of segments ?? []) {
    if (lines.at(-1) !== "") lines.push("");
    const tag = SEGMENT_TAG[s.kind];
    lines.push(`<${tag}${attrs([["id", s.id], ...Object.entries(s.attrs ?? {})])}>`);
    bodyLines(s.blocks, lines);
    lines.push(`</${tag}>`);
  }
}

export function serialize(doc: Doc): string {
  const lines = [header(doc), ""];
  if (!doc.tabs) {
    bodyLines(doc.blocks, lines);
    segmentLines(doc.segments, lines);
  } else {
    doc.tabs.forEach((t) => {
      if (lines.at(-1) !== "") lines.push("");
      lines.push(`<tab${attrs([["id", t.id], ["title", t.title], ["parent", t.parent], ["icon", t.icon]])}>`, "");
      bodyLines(t.blocks, lines);
      segmentLines(t.segments, lines);
    });
  }
  return lines.join("\n") + "\n";
}

// ---------- reading ----------

export type Token =
  | {t: "text"; text: string; line: number}
  | {t: "open"; name: string; attrs: Record<string, string>; line: number}
  | {t: "close"; name: string; line: number};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (m, e: string) => {
    const low = e.toLowerCase();
    if (low.startsWith("#x")) return String.fromCodePoint(parseInt(low.slice(2), 16));
    if (low.startsWith("#")) return String.fromCodePoint(parseInt(low.slice(1), 10));
    return ({amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0"} as Record<string, string>)[low] ?? m;
  });
}

export function tokenize(src: string, startLine: number): Token[] {
  const tokens: Token[] = [];
  let line = startLine;
  let i = 0;
  const count = (s: string) => {
    for (const ch of s) if (ch === "\n") line++;
  };
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end < 0) throw new FormatError(line, "unclosed <!-- comment");
      count(src.slice(i, end + 3));
      i = end + 3;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/.exec(src.slice(i));
    if (src[i] === "<" && m) {
      const name = m[2].toLowerCase();
      if (m[1]) tokens.push({t: "close", name, line});
      else {
        const at: Record<string, string> = {};
        for (const a of m[3].matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
          at[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "true");
        }
        tokens.push({t: "open", name, attrs: at, line});
      }
      count(m[0]);
      i += m[0].length;
      continue;
    }
    if (src[i] === "<") {
      // A lone "<" is almost always an agent forgetting to escape it.
      throw new FormatError(line, `stray "<" (write &lt; for a literal <)`);
    }
    let j = src.indexOf("<", i);
    if (j < 0) j = src.length;
    const raw = src.slice(i, j);
    tokens.push({t: "text", text: decodeEntities(raw), line});
    count(raw);
    i = j;
  }
  return tokens;
}

// Slides colors can also name the deck's theme colors.
export const THEME_COLORS = new Set(["dark1", "light1", "dark2", "light2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hyperlink", "followed-hyperlink", "text1", "background1", "text2", "background2"]);

export function color(value: string, line: number, theme = false): string {
  const v = value.trim().toLowerCase();
  if (COLOR_NAMES[v]) return COLOR_NAMES[v];
  if (theme && THEME_COLORS.has(v)) return v;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return "#" + [...v.slice(1)].map((c) => c + c).join("");
  throw new FormatError(line, `bad color "${value}" (use #rrggbb or a name like yellow${theme ? ", or a theme color like dark1 or accent1" : ""})`);
}

export function num(value: string, line: number, what: string, min = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new FormatError(line, `bad ${what} "${value}"`);
  return n;
}

type Open = Extract<Token, {t: "open"}>;

export class Parser {
  tokens: Token[];
  pos = 0;
  theme: boolean; // allow theme color names (Slides)
  constructor(tokens: Token[], theme = false) {
    this.tokens = tokens;
    this.theme = theme;
  }
  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  line(): number {
    return this.peek()?.line ?? this.tokens.at(-1)?.line ?? 1;
  }

  // Parses blocks until `until` closes. Bare text lines become paragraphs. At
  // the top level (until = null) it stops before a <tab> or segment tag.
  blocks(until: string | null): Block[] {
    const out: Block[] = [];
    let bare: Run[] = [];
    let bareLine = this.line();
    let styles: {name: string; style: TextStyle}[] = [];
    const flush = () => {
      if (styles.length) throw new FormatError(bareLine, `<${styles.at(-1)!.name}> is not closed before the end of the line`);
      const runs = normalizeRuns(until === "td" || until === "th" ? trimRuns(bare) : bare);
      const blank = runs.every((r) => "text" in r && !r.text.trim());
      if (!blank) out.push({type: "para", style: "p", runs});
      bare = [];
    };
    while (true) {
      const tok = this.peek();
      if (!tok) {
        if (until) throw new FormatError(this.line(), `<${until}> is not closed`);
        flush();
        return out;
      }
      if (tok.t === "close" && tok.name === until) {
        flush();
        this.pos++;
        return out;
      }
      if (tok.t === "open" && TOP_TAGS.has(tok.name)) {
        if (until !== null) throw new FormatError(tok.line, `<${tok.name}> can only be used at the top level, not inside <${until}>`);
        if (bare.some((r) => !("text" in r) || r.text.trim())) throw new FormatError(tok.line, `<${tok.name}> must start on its own line`);
        bare = [];
        flush();
        return out;
      }
      if (tok.t === "text") {
        this.pos++;
        const parts = tok.text.split("\n");
        parts.forEach((part, k) => {
          if (k > 0) {
            flush();
            bareLine = tok.line + k;
          }
          if (part) bare.push({text: part, style: current(styles)});
        });
        continue;
      }
      if (tok.t === "open" && BLOCK_TAGS.has(tok.name)) {
        if (bare.some((r) => !("text" in r) || r.text.trim())) {
          throw new FormatError(tok.line, `<${tok.name}> must start on its own line`);
        }
        bare = [];
        this.pos++;
        out.push(this.block(tok));
        continue;
      }
      // Inline content of a bare paragraph.
      this.inline(tok, styles, bare);
    }
  }

  // The whole file: tabs (when there are any), each with a body and segments.
  top(): Tab[] {
    const tabs: Tab[] = [];
    let cur: Tab = {id: "", title: "", blocks: []};
    let started = false; // saw a <tab>
    while (true) {
      cur.blocks.push(...this.blocks(null));
      const tok = this.peek();
      if (!tok) break;
      if (tok.t !== "open") throw new FormatError(tok.line, "unexpected token");
      this.pos++;
      if (tok.name === "tab") {
        if (!started) {
          if (cur.blocks.length || cur.segments?.length) throw new FormatError(tok.line, `content before the first <tab> belongs to no tab; move it below a <tab> line`);
        } else tabs.push(cur);
        started = true;
        const a = tok.attrs;
        if (!a.id) throw new FormatError(tok.line, `<tab> needs an id (new tabs can't be created from the file yet)`);
        cur = {id: a.id, title: a.title ?? "", blocks: []};
        if (a.parent) cur.parent = a.parent;
        if (a.icon) cur.icon = a.icon;
        continue;
      }
      const kind = SEGMENT_TAGS[tok.name];
      const {id, ...rest} = tok.attrs;
      if (!id) throw new FormatError(tok.line, `<${tok.name}> needs the id it was pulled with`);
      const seg: Segment = {kind, id, blocks: addFillers(this.blocks(tok.name))};
      if (Object.keys(rest).length) seg.attrs = rest;
      (cur.segments ??= []).push(seg);
    }
    tabs.push(cur);
    for (const t of tabs) t.blocks = addFillers(t.blocks);
    return started ? tabs : [cur];
  }

  block(tok: Open): Block {
    if (tok.name === "table") return this.table(tok.line);
    if (tok.name === "object") {
      const {kind = "object", id, ...rest} = tok.attrs;
      const b: Block = {type: "opaque", kind, key: id ?? DEFAULT_OPAQUE_KEY[kind] ?? kind};
      if (Object.keys(rest).length) b.attrs = rest;
      return b;
    }
    const runs: Run[] = [];
    const styles: {name: string; style: TextStyle}[] = [];
    while (true) {
      const t = this.peek();
      if (!t) throw new FormatError(tok.line, `<${tok.name}> is not closed`);
      if (t.t === "close" && t.name === tok.name && !styles.length) {
        this.pos++;
        break;
      }
      if (t.t === "text" && t.text.includes("\n")) {
        throw new FormatError(t.line, `<${tok.name}> has to stay on one line (use <br> for a line break inside it)`);
      }
      if (t.t === "open" && (BLOCK_TAGS.has(t.name) || TOP_TAGS.has(t.name))) throw new FormatError(t.line, `<${t.name}> can't go inside <${tok.name}>`);
      this.inline(t, styles, runs);
    }
    const a = tok.attrs;
    const para: Para = {type: "para", style: "p", runs: normalizeRuns(runs)};
    if (a.id) para.id = a.id;
    if (a.align) {
      if (!["left", "center", "right", "justify"].includes(a.align)) throw new FormatError(tok.line, `align must be left, center, right or justify`);
      if (a.align !== "left") para.align = a.align as Align;
    }
    if (a.dir) {
      if (a.dir !== "rtl" && a.dir !== "ltr") throw new FormatError(tok.line, `dir must be rtl or ltr`);
      if (a.dir === "rtl") para.dir = "rtl";
    }
    if (a.float) para.float = a.float.split(/\s+/).filter(Boolean);
    if (tok.name === "li") {
      const level = a.level ? Number(a.level) : 1;
      if (!Number.isInteger(level) || level < 1 || level > 9) throw new FormatError(tok.line, `li level must be 1-9`);
      const list: ListInfo = {ordered: false, level: level - 1};
      if (a.type && !PLAIN_BULLET_TYPES.has(a.type)) {
        list.glyph = a.type;
        list.ordered = NUMBER_TYPES.has(a.type);
      }
      if (a.start) list.start = num(a.start, tok.line, "li start");
      if (a.checked !== undefined) list.checked = true;
      para.list = list;
      if (a.style) {
        if (!PARA_TAGS.has(a.style) || a.style === "li") throw new FormatError(tok.line, `bad li style "${a.style}"`);
        para.style = a.style as ParaStyle;
      }
    } else {
      para.style = tok.name as ParaStyle;
      if (a.indent) para.indent = num(a.indent, tok.line, "indent") || undefined;
      if (a.first) {
        const first = num(a.first, tok.line, "first", -Infinity);
        if (first !== (para.indent ?? 0)) para.first = first;
      }
    }
    return para;
  }

  table(line: number): Table {
    type Cell = {blocks: Block[]; info: CellInfo; line: number};
    const parsed: Cell[][] = [];
    while (true) {
      const t = this.peek();
      if (!t) throw new FormatError(line, "<table> is not closed");
      this.pos++;
      if (t.t === "text" && !t.text.trim()) continue;
      if (t.t === "close" && t.name === "table") break;
      if (t.t === "open" && t.name === "tr") {
        const cells: Cell[] = [];
        while (true) {
          const c = this.peek();
          if (!c) throw new FormatError(t.line, "<tr> is not closed");
          this.pos++;
          if (c.t === "text" && !c.text.trim()) continue;
          if (c.t === "close" && c.name === "tr") break;
          if (c.t === "open" && (c.name === "td" || c.name === "th")) {
            const blocks = this.blocks(c.name);
            const info: CellInfo = {};
            if (c.attrs.colspan) info.colspan = num(c.attrs.colspan, c.line, "colspan", 1);
            if (c.attrs.rowspan) info.rowspan = num(c.attrs.rowspan, c.line, "rowspan", 1);
            if (info.colspan === 1) delete info.colspan;
            if (info.rowspan === 1) delete info.rowspan;
            if (c.attrs.bg) info.bg = color(c.attrs.bg, c.line, this.theme);
            if (c.attrs.covered) info.covered = true;
            cells.push({blocks: addFillers(blocks), info, line: c.line});
            continue;
          }
          throw new FormatError(c.line, `expected <td> inside <tr>`);
        }
        parsed.push(cells);
        continue;
      }
      throw new FormatError(t.line, `expected <tr> inside <table>`);
    }
    if (!parsed.length || !parsed[0].length) throw new FormatError(line, "a table needs at least one row and cell");
    // Lay cells out on the grid. Cells hidden by a colspan/rowspan are left out
    // of the file (unless written as <td covered>) and come back empty.
    const grid: (Cell | undefined)[][] = parsed.map(() => []);
    const hidden: boolean[][] = parsed.map(() => []);
    parsed.forEach((cells, r) => {
      let c = 0;
      for (const cell of cells) {
        if (cell.info.covered) {
          while (!(hidden[r][c] && !grid[r][c])) {
            if (c > 1000) throw new FormatError(cell.line, `<td covered> isn't under a merged cell`);
            c++;
          }
        } else while (hidden[r][c]) c++;
        grid[r][c] = cell;
        if (!cell.info.covered) {
          for (let dr = 0; dr < (cell.info.rowspan ?? 1); dr++) {
            for (let dc = 0; dc < (cell.info.colspan ?? 1); dc++) {
              if (!dr && !dc) continue;
              if (r + dr >= parsed.length) throw new FormatError(cell.line, `rowspan runs past the last row`);
              hidden[r + dr][c + dc] = true;
            }
          }
        }
        c++;
      }
    });
    const widths = grid.map((row, r) => Math.max(row.length, hidden[r].length));
    const width = widths[0];
    widths.forEach((w, k) => {
      if (w !== width) throw new FormatError(line, `table row ${k + 1} has ${w} cells, row 1 has ${width} (counting colspan/rowspan)`);
    });
    const rows: Block[][][] = [];
    const info: (CellInfo | undefined)[][] = [];
    let any = false;
    for (let r = 0; r < grid.length; r++) {
      rows.push([]);
      info.push([]);
      for (let c = 0; c < width; c++) {
        const cell = grid[r][c];
        if (hidden[r][c] && cell && !cell.info.covered) throw new FormatError(cell.line, `cells overlap: a merged cell already covers this one`);
        const ci: CellInfo | undefined = cell && Object.keys(cell.info).length ? {...cell.info} : hidden[r][c] ? {covered: true} : undefined;
        if (!cell && !hidden[r][c]) throw new FormatError(line, `table row ${r + 1} is missing a cell`);
        rows[r].push(cell ? cell.blocks : [{...EMPTY, runs: []}]);
        info[r].push(ci);
        if (ci) any = true;
      }
    }
    const t: Table = {type: "table", rows};
    if (any) t.cells = info;
    return t;
  }

  inline(t: Token, styles: {name: string; style: TextStyle}[], runs: Run[]) {
    this.pos++;
    if (t.t === "text") {
      runs.push({text: t.text, style: current(styles)});
      return;
    }
    if (t.t === "close") {
      const top = styles.at(-1);
      if (!top || top.name !== t.name) {
        throw new FormatError(t.line, top ? `</${t.name}> doesn't match the open <${top.name}>` : `</${t.name}> was never opened`);
      }
      styles.pop();
      return;
    }
    if (t.name === "br") {
      runs.push({text: "\u000b", style: current(styles)});
      return;
    }
    if (ATOM_TAGS.has(t.name)) {
      const kind = t.name as Atom["kind"];
      runs.push({atom: {kind, key: atomKey(kind, t.attrs), attrs: {...t.attrs}}, style: current(styles)});
      return;
    }
    if (!STYLE_TAGS.has(t.name)) {
      throw new FormatError(t.line, `unknown tag <${t.name}> (inline tags: b i u s sup sub mark span a br img)`);
    }
    const style = {...current(styles)};
    const a = t.attrs;
    if (t.name === "a") {
      if (!a.href) throw new FormatError(t.line, `<a> needs an href`);
      style.href = a.href;
    } else if (t.name === "mark") style.mark = a.color ? color(a.color, t.line, this.theme) : DEFAULT_MARK;
    else if (t.name === "span") {
      if (a.color) style.color = color(a.color, t.line, this.theme);
      if (a.font) style.font = a.font;
      if (a.size) {
        const n = parseFloat(a.size);
        if (!(n > 0)) throw new FormatError(t.line, `bad size "${a.size}"`);
        style.size = n;
      }
      if (a.weight) {
        const w = Number(a.weight);
        if (!Number.isInteger(w) || w < 100 || w > 900 || w % 100) throw new FormatError(t.line, `weight must be 100-900 in steps of 100`);
        if (w === 400) delete style.weight;
        else style.weight = w;
      }
      if (a.smallcaps) style.smallcaps = a.smallcaps !== "false";
    } else style[t.name as "b"] = true;
    if (t.name === "sup") delete style.sub;
    if (t.name === "sub") delete style.sup;
    styles.push({name: t.name, style});
  }
}

function current(styles: {style: TextStyle}[]): TextStyle {
  return styles.at(-1)?.style ?? {};
}

function trimRuns(runs: Run[]): Run[] {
  const out = runs.map((r) => ({...r}));
  const first = out.find((r) => "text" in r);
  if (first && "text" in first && out[0] === first) first.text = first.text.trimStart();
  const last = out.at(-1);
  if (last && "text" in last) last.text = last.text.trimEnd();
  return out;
}

export interface Header {
  kind: "doc" | "slides";
  id: string;
  rev?: string;
  name?: string; // the `· "Name"` part, if present
}

export function parseHeader(src: string): Header | null {
  const m = /^<!--\s*goog\s+(doc|slides)\s+(\S+)(?:\s+rev\s+(\S+))?/.exec(src);
  if (!m) return null;
  const h: Header = {kind: m[1] as Header["kind"], id: m[2], rev: m[3]};
  const nm = /^<!--[^\n]*?\u00b7\s*("(?:[^"\\\n]|\\.)*")/.exec(src);
  if (nm) {
    try {
      h.name = JSON.parse(nm[1]);
    } catch {
      // not a valid JSON string; ignore the name
    }
  }
  return h;
}

// The line (from 1) of the first merge conflict marker, or 0 if there's none.
export function markerLine(text: string): number {
  return text.split("\n").findIndex((l) => /^(<{7}|={7}|>{7})( |$)/.test(l)) + 1;
}

export function parse(src: string): Doc {
  const head = parseHeader(src);
  if (!head) throw new FormatError(1, `the first line must be the goog header, like <!-- goog doc DOC_ID -->`);
  const marker = markerLine(src);
  if (marker) {
    throw new FormatError(marker, "the file still has merge conflict markers; resolve them first (a literal line of ======= is written &#61;======)");
  }
  const tabs = new Parser(tokenize(src, 1)).top();
  const doc: Doc = {kind: "doc", id: head.id, rev: head.rev, blocks: tabs[0].blocks};
  if (head.name !== undefined) doc.name = head.name;
  if (tabs[0].segments?.length) doc.segments = tabs[0].segments;
  if (tabs[0].id) doc.tabs = tabs;
  return doc;
}

// A canonical string for comparing blocks.
export function blockKey(b: Block): string {
  return blockLines(b, false).join("\n");
}
