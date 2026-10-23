// Converts a Google Docs API document into the goog model, keeping the index
// ranges the planner needs to edit it.
//
// Accepts both response shapes: the legacy one (body, lists, … at the top,
// first tab only) and includeTabsContent=true (everything under tabs[]).
// Every element the API returns becomes something in the model, so indices
// never drift: element types goog doesn't know become <obj type="…"> atoms or
// <object kind="…"> blocks with their real length.

import type {Atom, Block, CellInfo, Doc, ListInfo, Opaque, Para, ParaStyle, Run, Segment, Tab, TextStyle} from "./model.ts";
import {atomKey, normalizeRuns} from "./model.ts";
import {blockKey} from "./format.ts";

export const LINK_COLOR = "#1155cc";

export interface IPara {
  type: "para";
  block: Para;
  start: number;
  end: number; // includes the trailing newline
  listId?: string;
}
export interface ITable {
  type: "table";
  block: Block & {type: "table"};
  start: number;
  end: number;
  cells: ISegment[][];
}
export interface IOpaque {
  type: "opaque";
  block: Block & {type: "opaque"};
  start: number;
  end: number;
}
export type IBlock = IPara | ITable | IOpaque;
export type ISegment = IBlock[];

// A header, footer or footnote: its own index space, addressed with segmentId = id.
export interface RSegment {
  kind: Segment["kind"];
  id: string;
  attrs?: Record<string, string>;
  body: ISegment;
}

export interface RTab {
  id: string;
  title: string;
  parent?: string;
  icon?: string;
  body: ISegment;
  segments: RSegment[];
}

export interface Remote {
  doc: Doc;
  body: ISegment; // first tab
  segments: RSegment[]; // first tab
  tabs?: RTab[]; // all tabs, only when there's more than one; requests need tabId
}

const NAMED: Record<string, ParaStyle> = {
  NORMAL_TEXT: "p", TITLE: "title", SUBTITLE: "subtitle", HEADING_1: "h1", HEADING_2: "h2",
  HEADING_3: "h3", HEADING_4: "h4", HEADING_5: "h5", HEADING_6: "h6",
};
export const NAMED_TYPE: Record<ParaStyle, string> = Object.fromEntries(
  Object.entries(NAMED).map(([k, v]) => [v, k]),
) as Record<ParaStyle, string>;

const ALIGN: Record<string, Para["align"]> = {CENTER: "center", END: "right", JUSTIFIED: "justify"};

// <li type> values for numbered glyph types.
export const NUMBER_GLYPHS: Record<string, string> = {
  DECIMAL: "1", ZERO_DECIMAL: "01", ALPHA: "a", UPPER_ALPHA: "A", ROMAN: "i", UPPER_ROMAN: "I",
};
// What Docs uses for a plain bulleted list, by nesting level.
export const DEFAULT_BULLETS = ["●", "○", "■"];

export function hex(c: any): string | undefined {
  const rgb = c?.color?.rgbColor;
  if (!rgb) return undefined;
  const h = (v: number | undefined) => Math.round((v ?? 0) * 255).toString(16).padStart(2, "0");
  return `#${h(rgb.red)}${h(rgb.green)}${h(rgb.blue)}`;
}

interface Defaults {
  font?: string;
  size?: number;
  color?: string;
  indentStart?: number;
  indentFirstLine?: number;
}

function namedDefaults(dt: any): Record<string, Defaults> {
  const out: Record<string, Defaults> = {};
  const styles: any[] = dt.namedStyles?.styles ?? [];
  const read = (s: any): Defaults => ({
    font: s?.textStyle?.weightedFontFamily?.fontFamily,
    size: s?.textStyle?.fontSize?.magnitude,
    color: hex(s?.textStyle?.foregroundColor),
    indentStart: s?.paragraphStyle?.indentStart?.magnitude,
    indentFirstLine: s?.paragraphStyle?.indentFirstLine?.magnitude,
  });
  const normal = read(styles.find((s) => s.namedStyleType === "NORMAL_TEXT"));
  for (const s of styles) {
    const own = read(s);
    const merged: Defaults = {};
    for (const k of Object.keys(normal) as (keyof Defaults)[]) (merged as any)[k] = own[k] ?? normal[k];
    out[s.namedStyleType] = merged;
  }
  return out;
}

// Docs sets footnote text in 10pt, so that's what goes without saying there.
export const FOOTNOTE_SIZE = 10;
export function footnoteDefaults<T extends {size?: number}>(defaults: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(defaults).map(([k, d]) => [k, {...d, size: FOOTNOTE_SIZE}]));
}

// Per-tab reading context.
interface Ctx {
  dt: any; // the documentTab (or the legacy document)
  tabId?: string;
  defaults: Record<string, Defaults>;
  headings: Set<string>; // heading ids some link points at
  footnoteOrder: string[];
}

function linkHref(link: any, ctx: Ctx): string | undefined {
  if (link.url) return link.url;
  const otherTab = (t: string | undefined) => (t && t !== ctx.tabId ? `&tab=${t}` : "");
  const heading = link.heading?.id ?? link.headingId;
  if (heading) return `#heading=${heading}${otherTab(link.heading?.tabId)}`;
  const bookmark = link.bookmark?.id ?? link.bookmarkId;
  if (bookmark) return `#bookmark=${bookmark}${otherTab(link.bookmark?.tabId)}`;
  if (link.tabId) return `#tab=${link.tabId}`;
  return undefined;
}

function textStyle(el: any, defaults: Defaults, ctx: Ctx): TextStyle {
  const ts = el?.textStyle;
  const s: TextStyle = {};
  if (el?.suggestedInsertionIds?.length) s.ins = true;
  if (el?.suggestedDeletionIds?.length) s.del = true;
  if (ts?.bold) s.b = true;
  if (ts?.italic) s.i = true;
  if (ts?.underline) s.u = true;
  if (ts?.strikethrough) s.s = true;
  if (ts?.smallCaps) s.smallcaps = true;
  if (ts?.baselineOffset === "SUPERSCRIPT") s.sup = true;
  if (ts?.baselineOffset === "SUBSCRIPT") s.sub = true;
  if (ts?.link) {
    const href = linkHref(ts.link, ctx);
    if (href) s.href = href;
  }
  const mark = hex(ts?.backgroundColor);
  if (mark) s.mark = mark;
  const color = hex(ts?.foregroundColor);
  if (color && color !== (defaults.color ?? "#000000")) s.color = color;
  const font = ts?.weightedFontFamily?.fontFamily;
  if (font && font !== defaults.font) s.font = font;
  const weight = ts?.weightedFontFamily?.weight;
  if (weight && weight !== 400) s.weight = weight;
  const size = ts?.fontSize?.magnitude;
  if (size && size !== defaults.size) s.size = size;
  // Docs styles links blue and underlined; that's implied by <a>.
  if (s.href && s.color === LINK_COLOR && s.u) {
    delete s.color;
    delete s.u;
  }
  return s;
}

const kebab = (s: string) => s.toLowerCase().replace(/_/g, "-");

function atom(kind: Atom["kind"], attrs: Record<string, string | undefined>, len: number): Atom {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== "") clean[k] = v;
  return {kind, key: atomKey(kind, clean), attrs: clean, len};
}

function atomFor(pe: any, ctx: Ctx): Atom {
  const len = (pe.endIndex ?? 0) - (pe.startIndex ?? 0);
  if (pe.inlineObjectElement) {
    const id = pe.inlineObjectElement.inlineObjectId;
    const emb = ctx.dt.inlineObjects?.[id]?.inlineObjectProperties?.embeddedObject ?? {};
    const type = emb.linkedContentReference?.sheetsChartReference ? "chart" : emb.embeddedDrawingProperties ? "drawing" : undefined;
    return atom("img", {id, type, alt: emb.description || emb.title}, len);
  }
  if (pe.horizontalRule) return atom("hr", {}, len);
  if (pe.pageBreak) return atom("pagebreak", {}, len);
  if (pe.columnBreak) return atom("columnbreak", {}, len);
  if (pe.equation) return atom("equation", {}, len);
  if (pe.autoText) return atom("autotext", {type: kebab(pe.autoText.type ?? "")}, len);
  if (pe.footnoteReference) {
    const id = pe.footnoteReference.footnoteId;
    if (!ctx.footnoteOrder.includes(id)) ctx.footnoteOrder.push(id);
    return atom("footnote", {id, n: pe.footnoteReference.footnoteNumber}, len);
  }
  if (pe.person) {
    const p = pe.person.personProperties ?? {};
    return atom("chip", {type: "person", id: pe.person.personId ?? p.email, name: p.name, email: p.email}, len);
  }
  if (pe.richLink) {
    const p = pe.richLink.richLinkProperties ?? {};
    return atom("chip", {type: "link", id: pe.richLink.richLinkId ?? p.uri, title: p.title, href: p.uri}, len);
  }
  if (pe.dateElement) {
    const p = pe.dateElement.dateElementProperties ?? {};
    return atom("chip", {type: "date", id: pe.dateElement.dateId, text: p.displayText, date: p.timestamp}, len);
  }
  if (pe.dropdown) {
    const p = pe.dropdown.dropdownProperties ?? {};
    return atom("chip", {type: "dropdown", id: pe.dropdown.dropdownId, value: p.displayValue}, len);
  }
  const type = Object.keys(pe).find((k) => k !== "startIndex" && k !== "endIndex") ?? "unknown";
  return atom("obj", {type}, len);
}

interface ListState {
  seen: Set<string>;
  prevListId?: string; // listId of the block right before, if it's a list item
}

// The glyph a list shows at one level: ordered + the number style, or a
// bullet symbol, "none" or "check".
function levelGlyph(levels: any[], level: number): {ordered: boolean; glyph?: string} {
  const lvl = levels[level] ?? {};
  const num = NUMBER_GLYPHS[lvl.glyphType];
  if (num && !lvl.glyphSymbol) return {ordered: true, glyph: num};
  if (lvl.glyphSymbol) return {ordered: false, glyph: lvl.glyphSymbol !== DEFAULT_BULLETS[level % 3] ? lvl.glyphSymbol : undefined};
  if (lvl.glyphType === "NONE") return {ordered: false, glyph: "none"};
  // That's how the API reports a checklist (BULLET_CHECKBOX).
  if ((lvl.glyphType === undefined || lvl.glyphType === "GLYPH_TYPE_UNSPECIFIED") && levels.length) return {ordered: false, glyph: "check"};
  return {ordered: false};
}

function listInfo(p: any, ctx: Ctx, state: ListState): ListInfo {
  const listId: string = p.bullet.listId;
  const level: number = p.bullet.nestingLevel ?? 0;
  const levelsOf = (id: string): any[] => ctx.dt.lists?.[id]?.listProperties?.nestingLevels ?? [];
  const levels = levelsOf(listId);
  const info: ListInfo = {level, ...levelGlyph(levels, level)};
  if (info.glyph === undefined) delete info.glyph;
  if (!state.seen.has(listId)) {
    state.seen.add(listId);
    const start = levels[0]?.startNumber ?? 1;
    // A list right after another one only needs start= to stay separate when
    // both look the same at the top level; otherwise the glyphs split them.
    const key = (id: string) => JSON.stringify(levelGlyph(levelsOf(id), 0));
    const touching = state.prevListId && state.prevListId !== listId && key(state.prevListId) === key(listId);
    if (start !== 1 || touching) info.start = start;
  }
  return info;
}

function para(el: any, ctx: Ctx, state: ListState): IPara {
  const p = el.paragraph;
  const ps = p.paragraphStyle ?? {};
  const named = ps.namedStyleType ?? "NORMAL_TEXT";
  const d = ctx.defaults[named] ?? {};
  const runs: Run[] = [];
  for (const pe of p.elements ?? []) {
    if (pe.textRun) {
      runs.push({text: pe.textRun.content ?? "", style: textStyle(pe.textRun, d, ctx)});
      continue;
    }
    const inner = Object.values(pe).find((v: any) => v && typeof v === "object") as any;
    runs.push({atom: atomFor(pe, ctx), style: textStyle(inner, d, ctx)});
  }
  // The paragraph's own newline isn't content.
  for (let k = runs.length - 1; k >= 0; k--) {
    const r = runs[k];
    if ("text" in r && r.text.endsWith("\n")) {
      r.text = r.text.slice(0, -1);
      break;
    }
    if ("text" in r && r.text === "") continue;
    break;
  }
  const block: Para = {type: "para", style: NAMED[named] ?? "p", runs: normalizeRuns(runs)};
  const align = ALIGN[ps.alignment];
  if (align) block.align = align;
  if (ps.direction === "RIGHT_TO_LEFT") block.dir = "rtl";
  if (ps.headingId && ctx.headings.has(ps.headingId)) block.id = ps.headingId;
  if (p.positionedObjectIds?.length) block.float = [...p.positionedObjectIds];
  let listId: string | undefined;
  if (p.bullet) {
    listId = p.bullet.listId;
    block.list = listInfo(p, ctx, state);
  } else {
    // List paragraphs get their indent from the list; others show it.
    const start = ps.indentStart?.magnitude ?? (ps.indentStart ? 0 : d.indentStart ?? 0);
    const first = ps.indentFirstLine?.magnitude ?? (ps.indentFirstLine ? 0 : d.indentFirstLine ?? 0);
    if (start) block.indent = start;
    if (first !== start) block.first = first;
  }
  state.prevListId = listId;
  return {type: "para", block, start: el.startIndex ?? 0, end: el.endIndex, listId};
}

function opaque(kind: string, key: string, el: any, attrs?: Record<string, string>): IOpaque {
  const block: Opaque = {type: "opaque", kind, key};
  if (attrs && Object.keys(attrs).length) block.attrs = attrs;
  return {type: "opaque", block, start: el.startIndex ?? 0, end: el.endIndex};
}

function table(el: any, ctx: Ctx): ITable {
  const apiRows: any[] = el.table.tableRows ?? [];
  const cells: ISegment[][] = apiRows.map((row) => (row.tableCells ?? []).map((cell: any) => segment(cell.content ?? [], ctx, false)));
  const info: (CellInfo | undefined)[][] = apiRows.map((row) => (row.tableCells ?? []).map(() => undefined));
  let any = false;
  apiRows.forEach((row, r) => {
    (row.tableCells ?? []).forEach((cell: any, c: number) => {
      const s = cell.tableCellStyle ?? {};
      const ci: CellInfo = {};
      if ((s.columnSpan ?? 1) > 1) ci.colspan = s.columnSpan;
      if ((s.rowSpan ?? 1) > 1) ci.rowspan = s.rowSpan;
      const bg = hex(s.backgroundColor);
      if (bg) ci.bg = bg;
      if (Object.keys(ci).length) {
        info[r][c] = {...info[r][c], ...ci};
        any = true;
      }
      for (let dr = 0; dr < (ci.rowspan ?? 1); dr++) {
        for (let dc = 0; dc < (ci.colspan ?? 1); dc++) {
          const row = info[r + dr];
          if ((dr || dc) && row && c + dc < row.length) row[c + dc] = {...row[c + dc], covered: true};
        }
      }
    });
  });
  const block: ITable["block"] = {type: "table", rows: cells.map((r) => r.map((c) => c.map((b) => b.block)))};
  if (any) block.cells = info;
  return {type: "table", block, start: el.startIndex, end: el.endIndex, cells};
}

function segment(content: any[], ctx: Ctx, isBody: boolean): ISegment {
  const out: ISegment = [];
  const state: ListState = {seen: new Set()};
  content.forEach((el, k) => {
    if (el.paragraph) {
      out.push(para(el, ctx, state));
      return;
    }
    state.prevListId = undefined;
    if (el.table) out.push(table(el, ctx));
    else if (el.sectionBreak) {
      // Every body starts with one; it isn't content.
      if (isBody && k === 0) return;
      const ss = el.sectionBreak.sectionStyle ?? {};
      const attrs: Record<string, string> = {};
      if (ss.sectionType) attrs.type = kebab(ss.sectionType);
      if ((ss.columnProperties?.length ?? 0) > 1) attrs.columns = String(ss.columnProperties.length);
      out.push(opaque("section-break", "section", el, attrs));
    } else if (el.tableOfContents) out.push(opaque("toc", "toc", el));
    else {
      const kind = Object.keys(el).find((x) => x !== "startIndex" && x !== "endIndex") ?? "unknown";
      out.push(opaque(kind, kind, el));
    }
  });
  return out;
}

function collectHeadingLinks(node: any, out: Set<string>) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) collectHeadingLinks(x, out);
    return;
  }
  const link = node.link;
  if (link && typeof link === "object") {
    const h = link.heading?.id ?? link.headingId;
    if (h) out.add(h);
  }
  for (const v of Object.values(node)) if (v && typeof v === "object") collectHeadingLinks(v, out);
}

function readTab(dt: any, tabId: string | undefined, headings: Set<string>): {body: ISegment; segments: RSegment[]} {
  const ctx: Ctx = {dt, tabId, defaults: namedDefaults(dt), headings, footnoteOrder: []};
  const body = segment(dt.body?.content ?? [], ctx, true);
  const segments: RSegment[] = [];
  const ds = dt.documentStyle ?? {};
  for (const kind of ["header", "footer"] as const) {
    const all: Record<string, any> = dt[kind + "s"] ?? {};
    const Kind = kind === "header" ? "Header" : "Footer";
    const roles: [string, string | undefined][] = [
      [ds[`default${Kind}Id`], undefined],
      [ds[`firstPage${Kind}Id`], "first"],
      [ds[`evenPage${Kind}Id`], "even"],
    ];
    const ids = [...new Set([...roles.map(([id]) => id).filter((id) => id && all[id]), ...Object.keys(all)])];
    for (const id of ids) {
      const role = roles.find(([r]) => r === id)?.[1];
      segments.push({kind, id, attrs: role ? {type: role} : undefined, body: segment(all[id].content ?? [], ctx, false)});
    }
  }
  const notes: Record<string, any> = dt.footnotes ?? {};
  // Footnotes referenced from headers/footers are read above too, so order last.
  for (const id of [...new Set([...ctx.footnoteOrder, ...Object.keys(notes)])]) {
    if (notes[id]) segments.push({kind: "footnote", id, body: segment(notes[id].content ?? [], {...ctx, defaults: footnoteDefaults(ctx.defaults)}, false)});
  }
  for (const s of segments) if (!s.attrs) delete s.attrs;
  return {body, segments};
}

const toSegment = (s: RSegment): Segment => {
  const out: Segment = {kind: s.kind, id: s.id, blocks: s.body.map((b) => b.block)};
  if (s.attrs) out.attrs = s.attrs;
  return out;
};

export function fromApi(api: any): Remote {
  const headings = new Set<string>();
  collectHeadingLinks(api, headings);
  // Flatten tabs depth first, children right after their parent.
  const flat: any[] = [];
  const walk = (tabs: any[]) => {
    for (const t of tabs) {
      flat.push(t);
      walk(t.childTabs ?? []);
    }
  };
  walk(api.tabs ?? []);
  const sources = flat.length && !api.body ? flat.map((t) => ({props: t.tabProperties ?? {}, dt: t.documentTab ?? {}})) : [{props: {}, dt: api}];
  const read = sources.map(({props, dt}) => {
    const r = readTab(dt, props.tabId, headings);
    const tab: RTab = {id: props.tabId ?? "", title: props.title ?? "", body: r.body, segments: r.segments};
    if (props.parentTabId) tab.parent = props.parentTabId;
    if (props.iconEmoji) tab.icon = props.iconEmoji;
    return tab;
  });
  const first = read[0];
  const doc: Doc = {kind: "doc", id: api.documentId, name: api.title, rev: api.revisionId, blocks: first.body.map((b) => b.block)};
  if (first.segments.length) doc.segments = first.segments.map(toSegment);
  const remote: Remote = {doc, body: first.body, segments: first.segments};
  if (read.length > 1) {
    remote.tabs = read;
    doc.tabs = read.map((t) => {
      const tab: Tab = {id: t.id, title: t.title, blocks: t.body.map((b) => b.block)};
      if (t.parent) tab.parent = t.parent;
      if (t.icon) tab.icon = t.icon;
      if (t.segments.length) tab.segments = t.segments.map(toSegment);
      return tab;
    });
    doc.tabs[0].blocks = doc.blocks;
  }
  return remote;
}

// Differences between a target doc and the remote that the body planner
// doesn't push: tabs after the first, and headers/footers/footnote text. The
// sync layer should show these as warnings instead of dropping them quietly.
export function unplannedChanges(remote: Remote, target: Doc): string[] {
  const out: string[] = [];
  const key = (blocks: Block[]) => blocks.map(blockKey).join("\n");
  const segKey = (segs: Segment[] | undefined) =>
    new Map((segs ?? []).map((s) => [`${s.kind}:${s.id}`, key(s.blocks)]));
  const compareSegs = (have: Segment[] | undefined, want: Segment[] | undefined, where: string) => {
    const a = segKey(have);
    const b = segKey(want);
    for (const [k, v] of b) {
      const [kind, id] = k.split(":");
      if (!a.has(k)) out.push(`${where}${kind} ${id} doesn't exist in the doc; it can't be created from the file`);
      else if (a.get(k) !== v) out.push(`${where}edits to the ${kind === "footnote" ? "footnote text" : kind} ${id} aren't pushed yet`);
    }
    for (const k of a.keys()) if (!b.has(k)) out.push(`${where}the ${k.replace(":", " ")} was removed from the file; goog doesn't delete it`);
  };
  compareSegs(remote.doc.segments, target.segments, "");
  const have = remote.doc.tabs ?? [];
  const want = target.tabs ?? [];
  if (have.length > 1 || want.length > 1) {
    const byId = new Map(have.map((t) => [t.id, t]));
    for (const [k, t] of want.entries()) {
      const r = byId.get(t.id);
      if (!r) {
        out.push(`tab ${JSON.stringify(t.title)} (${t.id}) doesn't exist in the doc; new tabs can't be created from the file`);
        continue;
      }
      const where = `tab ${JSON.stringify(r.title)}: `;
      if (r.title !== t.title || r.parent !== t.parent || r.icon !== t.icon) out.push(`${where}tab title, icon or nesting changes aren't pushed`);
      if (k > 0 && key(r.blocks) !== key(t.blocks)) out.push(`${where}edits outside the first tab aren't pushed yet`);
      if (k > 0) compareSegs(r.segments, t.segments, where);
    }
    for (const r of have) if (!want.some((t) => t.id === r.id)) out.push(`tab ${JSON.stringify(r.title)} was removed from the file; goog doesn't delete tabs`);
  }
  return out;
}
