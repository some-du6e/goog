// The .goog format for Google Slides: one <slide> per slide, one tag per object
// on it, in z-order (back to front). Shapes, tables and speaker notes hold
// paragraphs written exactly as in a doc. Positions and sizes are in points.
// See `goog help slides`.

import {
  type Token, FormatError, Parser, THEME_COLORS, attrs, blockLines, color, escapeText, num, parseHeader, tokenize, visible,
} from "./format.ts";
import {type Block, type Para, type Run, type Table, type TextStyle, cleanStyle} from "./model.ts";

// Where an object sits. rot is clockwise degrees about its center; x/y is the
// top-left corner before rotating. Unset fields mean "leave it as it is".
export interface Geom {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rot?: number;
  flip?: "h" | "v";
}

interface Common {
  id?: string; // unset for objects the file adds
  alt?: string; // alt text (the API's description)
}

export interface Shape extends Common {
  kind: "shape";
  type: string; // text-box, rectangle, ellipse, … (the API's shapeType, lowercased)
  placeholder?: string; // title, body, … for layout placeholders
  geom: Geom;
  fill?: string; // #rrggbb or a theme color, when the shape has a visible fill
  outline?: string; // the same, when it has a visible outline
  outlineWidth?: number; // points
  text: Block[]; // paragraphs only
}
export interface Image extends Common {
  kind: "image";
  geom: Geom;
  src?: string; // a URL to make (or replace) the picture from; never written by goog
}
export interface Line extends Common {
  kind: "line";
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  arrow?: "start" | "end" | "both";
}
export interface STable extends Common {
  kind: "table";
  geom: Geom; // x and y only
  table: Table;
}
export interface Video extends Common {
  kind: "video";
  geom: Geom;
  youtube?: string;
  drive?: string;
}
export interface Group extends Common {
  kind: "group";
  children: El[];
}
// Charts, word art and anything else goog can keep, move or delete but not edit.
export interface Other extends Common {
  kind: "object";
  type: string;
  geom: Geom;
}
export type El = Shape | Image | Line | STable | Video | Group | Other;

export interface Slide {
  id?: string;
  layout?: string; // layout name (or id when names repeat)
  skip?: boolean; // skipped in the slideshow
  elements: El[];
  notes: Block[]; // speaker notes
}

export interface Layout {
  id: string;
  name: string; // what <slide layout> says
  title?: string; // display name
  placeholders: {type: string; index: number}[];
}

export interface Deck {
  kind: "slides";
  id: string;
  name?: string;
  rev?: string;
  slides: Slide[];
  layouts?: Layout[]; // read from the deck
  layoutNote?: string; // the file's layouts comment, kept as is when there are no layouts
}

// ---------- numbers and names ----------

export const fmt = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};

// TEXT_BOX <-> text-box
export const kebab = (s: string) => s.toLowerCase().replace(/_/g, "-");
export const shout = (s: string) => s.toUpperCase().replace(/-/g, "_");

// ---------- writing ----------

// Text in Slides carries its font, size and color on every run, so the most
// common ones go on the object's tag once and the runs only say how they differ.
const BASE_KEYS = ["font", "size", "color"] as const;
type BaseStyle = Pick<TextStyle, (typeof BASE_KEYS)[number]>;

function textRuns(blocks: Block[]): Run[] {
  const out: Run[] = [];
  for (const b of blocks) {
    if (b.type === "para") out.push(...b.runs);
    if (b.type === "table") for (const row of b.rows) for (const cell of row) out.push(...textRuns(cell));
  }
  return out;
}

function baseOf(blocks: Block[]): BaseStyle {
  const runs = textRuns(blocks).filter((r) => !("text" in r) || r.text.length);
  const base: BaseStyle = {};
  if (!runs.length) return base;
  for (const k of BASE_KEYS) {
    // Only when every run has one: a run inheriting it couldn't be written.
    if (runs.some((r) => r.style[k] === undefined)) continue;
    const counts = new Map<string | number, number>();
    for (const r of runs) counts.set(r.style[k]!, (counts.get(r.style[k]!) ?? 0) + ("text" in r ? r.text.length : 1));
    let best: string | number | undefined;
    for (const [v, n] of counts) if (best === undefined || n > counts.get(best)!) best = v;
    (base as any)[k] = best;
  }
  return base;
}

function withoutBase(blocks: Block[], base: BaseStyle): Block[] {
  const strip = (style: TextStyle) => {
    const s = {...style};
    for (const k of BASE_KEYS) if (s[k] === base[k]) delete s[k];
    return s;
  };
  return blocks.map((b): Block => {
    if (b.type === "para") return {...b, runs: b.runs.map((r) => ({...r, style: strip(r.style)}))};
    if (b.type === "table") return {...b, rows: b.rows.map((row) => row.map((cell) => withoutBase(cell, base)))};
    return b;
  });
}

function withBase(blocks: Block[], base: BaseStyle): Block[] {
  if (!Object.keys(base).length) return blocks;
  const add = (style: TextStyle) => cleanStyle({...base, ...style});
  return blocks.map((b): Block => {
    if (b.type === "para") return {...b, runs: b.runs.map((r) => ({...r, style: add(r.style)}))};
    if (b.type === "table") return {...b, rows: b.rows.map((row) => row.map((cell) => withBase(cell, base)))};
    return b;
  });
}

const baseAttrs = (base: BaseStyle): [string, string | number | undefined][] =>
  BASE_KEYS.map((k) => [k, base[k]]);

const geomAttrs = (g: Geom): [string, string | number | undefined][] => [
  ["x", g.x === undefined ? undefined : fmt(g.x)],
  ["y", g.y === undefined ? undefined : fmt(g.y)],
  ["w", g.w === undefined ? undefined : fmt(g.w)],
  ["h", g.h === undefined ? undefined : fmt(g.h)],
  ["rot", g.rot ? fmt(g.rot) : undefined],
  ["flip", g.flip],
];

const paraLines = (blocks: Block[]) => visible(blocks).flatMap((b) => blockLines(b, true));

function elLines(e: El, out: string[]) {
  const id: [string, string | undefined] = ["id", e.id];
  const alt: [string, string | undefined] = ["alt", e.alt || undefined];
  switch (e.kind) {
    case "shape": {
      const base = baseOf(e.text);
      const open = `<shape${attrs([id, ["type", e.type], ["placeholder", e.placeholder], ...geomAttrs(e.geom), ["fill", e.fill], ["outline", e.outline], ["outline-width", e.outline && e.outlineWidth !== undefined ? fmt(e.outlineWidth) : undefined], ...baseAttrs(base), alt])}>`;
      const lines = paraLines(withoutBase(e.text, base));
      if (!lines.length) out.push(open + "</shape>");
      else out.push(open, ...lines, "</shape>");
      return;
    }
    case "image":
      out.push(`<image${attrs([id, ...geomAttrs(e.geom), ["src", e.src], alt])}>`);
      return;
    case "line":
      out.push(`<line${attrs([id, ["x1", n(e.x1)], ["y1", n(e.y1)], ["x2", n(e.x2)], ["y2", n(e.y2)], ["arrow", e.arrow], alt])}>`);
      return;
    case "table": {
      const base = baseOf([e.table]);
      const rows = blockLines(withoutBase([e.table], base)[0], true).slice(1, -1);
      out.push(`<table${attrs([id, ["x", n(e.geom.x)], ["y", n(e.geom.y)], ...baseAttrs(base), alt])}>`, ...rows, "</table>");
      return;
    }
    case "video":
      out.push(`<video${attrs([id, ...geomAttrs(e.geom), ["youtube", e.youtube], ["drive", e.drive], alt])}>`);
      return;
    case "group":
      out.push(`<group${attrs([id, alt])}>`);
      for (const c of e.children) elLines(c, out);
      out.push("</group>");
      return;
    case "object":
      out.push(`<object${attrs([id, ["type", e.type], ...geomAttrs(e.geom), alt])}>`);
      return;
  }
}

const n = (v: number | undefined) => (v === undefined ? undefined : fmt(v));

// Lists the layouts a new <slide layout="…"> can use.
export function layoutNote(layouts: Layout[]): string | undefined {
  const named = layouts.filter((l) => l.name !== l.id);
  if (!named.length) return undefined;
  const names = named.map((l) => (l.title && kebab(l.title).replace(/ /g, "-") !== l.name ? `${l.name} (${l.title})` : l.name));
  return `<!-- layouts for new slides: ${names.join(", ").replace(/--/g, "- -")} -->`;
}

export function header(deck: Deck): string {
  const name = deck.name ? ` · ${JSON.stringify(deck.name).replace(/--/g, "-\\u002d")}` : "";
  return `<!-- goog slides ${deck.id}${name} -->`;
}

export function serialize(deck: Deck): string {
  const lines = [header(deck)];
  const note = deck.layouts ? layoutNote(deck.layouts) : deck.layoutNote;
  if (note) lines.push(note);
  for (const s of deck.slides) {
    lines.push("", `<slide${attrs([["id", s.id], ["layout", s.layout], ["skip", s.skip]])}>`);
    for (const e of s.elements) elLines(e, lines);
    const notes = paraLines(s.notes);
    if (notes.length) {
      const base = baseOf(s.notes);
      lines.push(`<notes${attrs(baseAttrs(base))}>`, ...paraLines(withoutBase(s.notes, base)), "</notes>");
    }
    lines.push("</slide>");
  }
  return lines.join("\n") + "\n";
}

// ---------- reading ----------

const ELEMENT_TAGS = new Set(["shape", "image", "line", "table", "video", "group", "object"]);
const VOID_TAGS = new Set(["image", "line", "video", "object"]);

class SlidesParser {
  p: Parser;
  constructor(tokens: Token[]) {
    this.p = new Parser(tokens, true);
  }
  get tokens() {
    return this.p.tokens;
  }
  peek() {
    return this.p.peek();
  }
  next() {
    return this.p.tokens[this.p.pos++];
  }
  // Skips blank text; anything else that's text is an error here.
  skipBlank(where: string) {
    for (let t = this.peek(); t?.t === "text"; t = this.peek()) {
      if (t.text.trim()) throw new FormatError(t.line, `text "${t.text.trim().slice(0, 30)}" isn't inside anything; ${where}`);
      this.p.pos++;
    }
  }

  deck(): Slide[] {
    const slides: Slide[] = [];
    while (true) {
      this.skipBlank("put it in a <shape> on a <slide>");
      const t = this.next();
      if (!t) return slides;
      if (t.t === "open" && t.name === "slide") {
        slides.push(this.slide(t));
        continue;
      }
      throw new FormatError(t.line, t.t === "open" && ELEMENT_TAGS.has(t.name) ? `<${t.name}> has to be inside a <slide>` : `expected <slide>, found ${desc(t)}`);
    }
  }

  slide(open: Extract<Token, {t: "open"}>): Slide {
    const a = open.attrs;
    const s: Slide = {elements: [], notes: []};
    if (a.id) s.id = a.id;
    if (a.layout) s.layout = a.layout;
    if (a.skip !== undefined && a.skip !== "false") s.skip = true;
    s.elements = this.elements("slide", open.line, s);
    return s;
  }

  // Elements until </until>. A slide also takes <notes>.
  elements(until: string, line: number, slide?: Slide): El[] {
    const out: El[] = [];
    while (true) {
      this.skipBlank("put text in a <shape>");
      const t = this.next();
      if (!t) throw new FormatError(line, `<${until}> on line ${line} is not closed`);
      if (t.t === "close") {
        if (t.name === until) return out;
        if (VOID_TAGS.has(t.name)) continue; // a harmless </image>
        throw new FormatError(t.line, `</${t.name}> doesn't match the open <${until}> from line ${line}`);
      }
      if (t.t !== "open") continue;
      if (t.name === "notes" && slide) {
        slide.notes = this.text("notes", t);
        continue;
      }
      if (t.name === "slide") throw new FormatError(t.line, `<slide> starts before the <${until}> from line ${line} is closed`);
      if (!ELEMENT_TAGS.has(t.name)) throw new FormatError(t.line, `unknown tag <${t.name}> on a slide (objects: shape image line table video group object)`);
      out.push(this.element(t));
    }
  }

  element(t: Extract<Token, {t: "open"}>): El {
    const a = t.attrs;
    const common: Common = {};
    if (a.id) common.id = a.id;
    if (a.alt) common.alt = a.alt;
    const geom = (): Geom => {
      const g: Geom = {};
      for (const k of ["x", "y", "w", "h"] as const) if (a[k] !== undefined) g[k] = num(a[k], t.line, `${t.name} ${k}`, -Infinity);
      if (a.rot !== undefined) {
        const r = num(a.rot, t.line, "rot", -Infinity);
        if (r) g.rot = r;
      }
      if (a.flip) {
        if (a.flip !== "h" && a.flip !== "v") throw new FormatError(t.line, `flip must be h or v`);
        g.flip = a.flip;
      }
      return g;
    };
    switch (t.name) {
      case "shape": {
        const text = this.text("shape", t);
        const s: Shape = {...common, kind: "shape", type: a.type ? kebab(a.type) : "text-box", geom: geom(), text};
        if (a.placeholder) s.placeholder = kebab(a.placeholder);
        if (a.fill) s.fill = color(a.fill, t.line, true);
        if (a.outline && a.outline !== "none") s.outline = color(a.outline, t.line, true);
        if (a["outline-width"] !== undefined) {
          if (!s.outline) throw new FormatError(t.line, `outline-width needs an outline color too`);
          s.outlineWidth = num(a["outline-width"], t.line, "outline-width", 0);
        }
        return s;
      }
      case "image": {
        const e: Image = {...common, kind: "image", geom: geom()};
        if (a.src) e.src = a.src;
        return e;
      }
      case "line": {
        const e: Line = {...common, kind: "line"};
        for (const k of ["x1", "y1", "x2", "y2"] as const) if (a[k] !== undefined) e[k] = num(a[k], t.line, `line ${k}`, -Infinity);
        if (a.arrow) {
          if (!["start", "end", "both", "none"].includes(a.arrow)) throw new FormatError(t.line, `arrow must be start, end, both or none`);
          if (a.arrow !== "none") e.arrow = a.arrow as Line["arrow"];
        }
        return e;
      }
      case "table": {
        const table = this.p.table(t.line);
        const base = this.baseFrom(a, t.line);
        checkText([table], t.line, "table");
        return {...common, kind: "table", geom: geom(), table: withBase([table], base)[0] as Table};
      }
      case "video": {
        const e: Video = {...common, kind: "video", geom: geom()};
        if (a.youtube) e.youtube = a.youtube;
        if (a.drive) e.drive = a.drive;
        return e;
      }
      case "group":
        return {...common, kind: "group", children: this.elements("group", t.line)};
      default:
        return {...common, kind: "object", type: a.type ?? "object", geom: geom()};
    }
  }

  baseFrom(a: Record<string, string>, line: number): BaseStyle {
    const base: BaseStyle = {};
    if (a.font) base.font = a.font;
    if (a.size) {
      const s = parseFloat(a.size);
      if (!(s > 0)) throw new FormatError(line, `bad size "${a.size}"`);
      base.size = s;
    }
    if (a.color) base.color = color(a.color, line, true);
    return base;
  }

  // Paragraphs up to </name>.
  text(name: string, t: Extract<Token, {t: "open"}>): Block[] {
    // A missing </shape> would otherwise surface as a puzzling error about the next tag.
    for (let i = this.p.pos; i < this.tokens.length; i++) {
      const k = this.tokens[i];
      if (k.t === "close" && k.name === name) break;
      if (k.t === "open" && (ELEMENT_TAGS.has(k.name) || k.name === "slide" || k.name === "notes")) {
        throw new FormatError(t.line, `<${name}> on line ${t.line} is not closed before the <${k.name}> on line ${k.line}; end its text with </${name}>`);
      }
    }
    const blocks = this.p.blocks(name);
    checkText(blocks, t.line, name);
    return withBase(blocks, this.baseFrom(t.attrs, t.line));
  }
}

const desc = (t: Token) => (t.t === "text" ? `text "${t.text.trim().slice(0, 30)}"` : t.t === "open" ? `<${t.name}>` : `</${t.name}>`);

// Slides text is plain paragraphs and bullets: no headings, tables or images.
function checkText(blocks: Block[], line: number, where: string) {
  for (const b of blocks) {
    if (b.type === "opaque") throw new FormatError(line, `<object> can't go inside <${where}>`);
    if (b.type === "table") {
      if (where !== "table") throw new FormatError(line, `a table can't go inside <${where}>; put a <table> on the slide instead`);
      for (const row of b.rows) for (const cell of row) checkText(cell, line, "td");
      continue;
    }
    if (b.style !== "p") throw new FormatError(line, `Slides text has no <${b.style}>; use <p> with <span size="…"> or <b>`);
    for (const r of b.runs) {
      if ("atom" in r && r.atom.kind !== "autotext") throw new FormatError(line, `<${r.atom.kind}> can't go in Slides text; put an <image> on the slide instead`);
    }
  }
}

export function parse(src: string): Deck {
  const head = parseHeader(src);
  if (!head || head.kind !== "slides") throw new FormatError(1, `the first line must be the goog header, like <!-- goog slides DECK_ID -->`);
  if (/^(<{7}|={7}|>{7})/m.test(src)) {
    const line = src.split("\n").findIndex((l) => /^(<{7}|={7}|>{7})/.test(l)) + 1;
    throw new FormatError(line, "the file still has merge conflict markers; resolve them first");
  }
  const deck: Deck = {kind: "slides", id: head.id, slides: new SlidesParser(tokenize(src, 1)).deck()};
  if (head.name !== undefined) deck.name = head.name;
  const note = /^[^\n]*\n(<!-- layouts [^\n]*-->)$/m.exec(src);
  if (note) deck.layoutNote = note[1];
  return deck;
}

export {THEME_COLORS, escapeText};
