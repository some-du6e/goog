// The in-memory shape of a document, shared by the .goog format and every backend.

export type ParaStyle = "p" | "title" | "subtitle" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
export type Align = "left" | "center" | "right" | "justify";

export interface TextStyle {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  sup?: boolean;
  sub?: boolean;
  href?: string;
  mark?: string; // highlight color, #rrggbb
  color?: string; // text color, #rrggbb
  font?: string;
  size?: number; // points
  weight?: number; // font weight when not 400 (bold is `b`, not weight 700)
  smallcaps?: boolean;
  // Suggestions (read in SUGGESTIONS_INLINE mode). goog can't create, accept or
  // reject them; they're shown so suggested text isn't mistaken for real text.
  ins?: boolean; // suggested insertion
  del?: boolean; // suggested deletion
}

// Things inside a paragraph that aren't plain text. `key` identifies the object
// across pulls so the diff can tell whether it was kept, moved, or deleted.
// Kinds: img (attrs id, alt, type=drawing|chart), hr, pagebreak, columnbreak,
// footnote (id, n; the text is a "footnote" Segment), chip (type=person|link|
// date|dropdown), equation, autotext (type=page-number|page-count), and obj for
// any element type goog doesn't know yet (attrs type=<API field name>).
export interface Atom {
  kind: "img" | "hr" | "pagebreak" | "columnbreak" | "footnote" | "chip" | "equation" | "autotext" | "obj";
  key: string;
  attrs: Record<string, string>;
  len?: number; // index units it occupies in the remote doc, when read from one
}

export type Run = {text: string; style: TextStyle} | {atom: Atom; style: TextStyle};

export interface ListInfo {
  ordered: boolean;
  level: number; // 0-based
  // The glyph at this level, as written in `<li type>`: 1 01 a A i I for
  // numbers; check, none, or a bullet character for bullets. Unset means the
  // default for an unordered list at this level (● ○ ■).
  glyph?: string;
  // Set on the first item of a list that starts a new list right after
  // another one, or doesn't start at 1. It's the list's level-0 start number.
  start?: number;
  // A ticked checklist item. Read from Drive's markdown export, since the Docs
  // API doesn't say; it can't be changed through the API either.
  checked?: boolean;
}

export interface Para {
  type: "para";
  style: ParaStyle;
  align?: Align; // relative to the writing direction: left is "start"
  dir?: "rtl";
  indent?: number; // indentStart in points, for non-list paragraphs
  first?: number; // indentFirstLine in points, when it differs from indent
  id?: string; // heading id, only kept when a link in the doc points at it
  float?: string[]; // ids of positioned (floating) objects anchored here
  list?: ListInfo;
  runs: Run[];
}

export interface CellInfo {
  colspan?: number;
  rowspan?: number;
  bg?: string; // #rrggbb
  // Hidden under a merged neighbour. The cell still exists in Docs (and in
  // `rows`), but the file leaves it out the way HTML does.
  covered?: boolean;
}

export interface Table {
  type: "table";
  rows: Block[][][]; // rows -> cells -> blocks; always the full grid
  cells?: (CellInfo | undefined)[][]; // same shape as rows, when any cell has info
}

// Blocks goog can't edit but must keep, like a table of contents or a section
// break. `attrs` carries read-only details, like a section break's type.
export interface Opaque {
  type: "opaque";
  kind: string;
  key: string;
  attrs?: Record<string, string>;
}

export type Block = Para | Table | Opaque;

// A header, footer, or footnote's text. Each is its own Docs segment
// (segmentId = id), edited with the same requests as the body.
export interface Segment {
  kind: "header" | "footer" | "footnote";
  id: string;
  attrs?: Record<string, string>; // header/footer: type=first|even when not the default
  blocks: Block[];
}

export interface Tab {
  id: string;
  title: string;
  parent?: string; // parent tab id, for child tabs
  icon?: string; // emoji
  blocks: Block[];
  segments?: Segment[];
}

export interface Doc {
  kind: "doc";
  id: string;
  name?: string;
  rev?: string;
  blocks: Block[]; // the first tab's body
  segments?: Segment[]; // the first tab's headers, footers and footnotes
  // Every tab in document order (children right after their parent), only
  // when the doc has more than one. tabs[0].blocks is `blocks`.
  tabs?: Tab[];
}

export const DEFAULT_MARK = "#ffff00";

export const STYLE_KEYS = [
  "ins", "del", "href", "mark", "color", "font", "size", "weight", "smallcaps", "b", "i", "u", "s", "sup", "sub",
] as const;

export function sameStyle(a: TextStyle, b: TextStyle): boolean {
  return STYLE_KEYS.every((k) => (a[k] ?? undefined) === (b[k] ?? undefined));
}

export function cleanStyle(style: TextStyle): TextStyle {
  const out: TextStyle = {};
  for (const k of STYLE_KEYS) {
    const v = style[k];
    if (v !== undefined && v !== false && v !== "") (out as any)[k] = v;
  }
  return out;
}

// Merges adjacent text runs that share a style and drops empty ones.
export function normalizeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    const style = cleanStyle(run.style);
    if ("text" in run) {
      if (!run.text) continue;
      const last = out.at(-1);
      if (last && "text" in last && sameStyle(last.style, style)) last.text += run.text;
      else out.push({text: run.text, style});
    } else {
      out.push({atom: run.atom, style});
    }
  }
  return out;
}

export function paraText(p: Para): string {
  return p.runs.map((r) => ("text" in r ? r.text : "￼")).join("");
}

// How an atom is identified across pulls. Objects with an id use it; new
// images use their src; the rest (hr, page breaks, equations, …) are
// interchangeable, so they're keyed by kind.
export function atomKey(kind: Atom["kind"], attrs: Record<string, string>): string {
  if (attrs.id) return attrs.id;
  if (attrs.src) return `src:${attrs.src}`;
  if (kind === "obj" || kind === "autotext") return attrs.type ? `${kind}:${attrs.type}` : kind;
  // New ones, keyed by what they'll be made from so two of them don't look alike.
  if (kind === "chip") return `chip:${attrs.type}:${attrs.email ?? attrs.href ?? attrs.date ?? attrs.value ?? ""}`;
  if (kind === "footnote") return `footnote:${attrs.text ?? ""}`;
  return kind;
}
