// Converts a Slides API presentation into the goog model, keeping what the
// planner needs to edit it: each object's raw size and its group's transform.
//
// Geometry: the API gives every object a size (Slides normalizes it, often to
// 3000000 EMU square) and an affine transform that does the real sizing. goog
// shows the result: the box's top-left corner, width and height in points,
// and a clockwise rotation about its center.

import type {Atom, Block, CellInfo, Para, Run, Table, TextStyle} from "./model.ts";
import {normalizeRuns} from "./model.ts";
import {type Deck, type El, type Geom, type Layout, type Slide, kebab} from "./slides-format.ts";

export const EMU_PER_PT = 12700;

// x' = a·x + c·y + tx, y' = b·x + d·y + ty (EMU)
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}
export const IDENTITY: Affine = {a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0};

export function compose(p: Affine, q: Affine): Affine {
  return {
    a: p.a * q.a + p.c * q.b,
    b: p.b * q.a + p.d * q.b,
    c: p.a * q.c + p.c * q.d,
    d: p.b * q.c + p.d * q.d,
    tx: p.a * q.tx + p.c * q.ty + p.tx,
    ty: p.b * q.tx + p.d * q.ty + p.ty,
  };
}

export function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    tx: (m.c * m.ty - m.d * m.tx) / det,
    ty: (m.b * m.tx - m.a * m.ty) / det,
  };
}

const emu = (dim: any): number => (dim?.magnitude ? dim.magnitude * (dim.unit === "PT" ? EMU_PER_PT : 1) : 0);

// Missing fields are zero (proto defaults); a missing transform is the identity.
export function affineOf(t: any): Affine {
  if (!t) return {...IDENTITY};
  const k = t.unit === "PT" ? EMU_PER_PT : 1;
  return {a: t.scaleX ?? 0, b: t.shearY ?? 0, c: t.shearX ?? 0, d: t.scaleY ?? 0, tx: (t.translateX ?? 0) * k, ty: (t.translateY ?? 0) * k};
}

export const apiTransform = (m: Affine) => ({
  scaleX: m.a, shearY: m.b, shearX: m.c, scaleY: m.d, translateX: m.tx, translateY: m.ty, unit: "EMU",
});

// The transform as a box: rotation, then an optional mirror, then size.
export function geomOf(m: Affine, W: number, H: number): Geom {
  const det = m.a * m.d - m.b * m.c;
  let sx = Math.hypot(m.a, m.b);
  let theta = Math.atan2(m.b, m.a);
  let sy = sx ? det / sx : Math.hypot(m.c, m.d);
  if (det < 0) {
    // Mirrored: show it as flip="v" or flip="h", whichever needs less rotation.
    const alt = theta > 0 ? theta - Math.PI : theta + Math.PI;
    if (Math.abs(alt) < Math.abs(theta) - 1e-9) {
      theta = alt;
      sx = -sx;
      sy = -sy;
    }
  }
  const cx = m.tx + (m.a * W) / 2 + (m.c * H) / 2;
  const cy = m.ty + (m.b * W) / 2 + (m.d * H) / 2;
  const w = Math.abs(sx) * W;
  const h = Math.abs(sy) * H;
  const g: Geom = {x: (cx - w / 2) / EMU_PER_PT, y: (cy - h / 2) / EMU_PER_PT, w: w / EMU_PER_PT, h: h / EMU_PER_PT};
  const rot = (theta * 180) / Math.PI;
  if (Math.abs(rot) >= 0.005) g.rot = rot;
  if (sx < 0) g.flip = "h";
  else if (sy < 0) g.flip = "v";
  return g;
}

// The transform that draws a W×H object (EMU) as box g (points).
export function affineFor(g: Required<Pick<Geom, "x" | "y" | "w" | "h">> & Geom, W: number, H: number): Affine {
  const theta = ((g.rot ?? 0) * Math.PI) / 180;
  const sx = ((g.w * EMU_PER_PT) / W) * (g.flip === "h" ? -1 : 1);
  const sy = ((g.h * EMU_PER_PT) / H) * (g.flip === "v" ? -1 : 1);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const m = {a: sx * cos, b: sx * sin, c: -sy * sin, d: sy * cos, tx: 0, ty: 0};
  const cx = (g.x + g.w / 2) * EMU_PER_PT;
  const cy = (g.y + g.h / 2) * EMU_PER_PT;
  m.tx = cx - (m.a * W) / 2 - (m.c * H) / 2;
  m.ty = cy - (m.b * W) / 2 - (m.d * H) / 2;
  return m;
}

// A line runs from its box's (0,0) to (W,H).
export function lineEnds(m: Affine, W: number, H: number) {
  return {
    x1: m.tx / EMU_PER_PT,
    y1: m.ty / EMU_PER_PT,
    x2: (m.a * W + m.c * H + m.tx) / EMU_PER_PT,
    y2: (m.b * W + m.d * H + m.ty) / EMU_PER_PT,
  };
}

// The transform that draws a W×H line from (x1,y1) to (x2,y2) (points): a
// rotation and uniform scale, so it's never degenerate.
export function lineAffine(x1: number, y1: number, x2: number, y2: number, W: number, H: number): Affine {
  const dx = (x2 - x1) * EMU_PER_PT;
  const dy = (y2 - y1) * EMU_PER_PT;
  const len = Math.hypot(W, H);
  const k = Math.hypot(dx, dy) / len || 1e-6;
  const phi = Math.atan2(dy, dx) - Math.atan2(H, W);
  return {a: k * Math.cos(phi), b: k * Math.sin(phi), c: -k * Math.sin(phi), d: k * Math.cos(phi), tx: x1 * EMU_PER_PT, ty: y1 * EMU_PER_PT};
}

// ---------- colors and text ----------

function rgbHex(rgb: any): string {
  const h = (v: number | undefined) => Math.round((v ?? 0) * 255).toString(16).padStart(2, "0");
  return `#${h(rgb.red)}${h(rgb.green)}${h(rgb.blue)}`;
}

// An OpaqueColor: {rgbColor} or {themeColor}.
export function opaque(c: any): string | undefined {
  if (c?.rgbColor) return rgbHex(c.rgbColor);
  if (c?.themeColor) return kebab(c.themeColor);
  return undefined;
}

const ALIGN: Record<string, Para["align"]> = {CENTER: "center", END: "right", JUSTIFIED: "justify"};

export function linkHref(link: any): string | undefined {
  if (!link) return undefined;
  if (link.url) return link.url;
  if (link.pageObjectId) return `#slide=${link.pageObjectId}`;
  if (link.slideIndex !== undefined) return `#slide-index=${link.slideIndex}`;
  if (link.relativeLink) return `#${kebab(link.relativeLink)}`;
  return undefined;
}

export function textStyle(st: any): TextStyle {
  const s: TextStyle = {};
  if (!st) return s;
  if (st.bold) s.b = true;
  if (st.italic) s.i = true;
  if (st.underline) s.u = true;
  if (st.strikethrough) s.s = true;
  if (st.smallCaps) s.smallcaps = true;
  if (st.baselineOffset === "SUPERSCRIPT") s.sup = true;
  if (st.baselineOffset === "SUBSCRIPT") s.sub = true;
  const href = linkHref(st.link);
  if (href) s.href = href;
  const mark = opaque(st.backgroundColor?.opaqueColor);
  if (mark) s.mark = mark;
  const color = opaque(st.foregroundColor?.opaqueColor);
  if (color) s.color = color;
  const font = st.weightedFontFamily?.fontFamily ?? st.fontFamily;
  if (font) s.font = font;
  const weight = st.weightedFontFamily?.weight;
  if (weight && weight !== 400 && !(weight === 700 && s.b)) s.weight = weight;
  if (st.fontSize?.magnitude) s.size = st.fontSize.magnitude;
  // Slides colors and underlines links itself; that's implied by <a>.
  if (s.href && s.color === "hyperlink") {
    delete s.color;
    delete s.u;
  }
  return s;
}

const ORDERED = /^\(?[0-9a-zA-Z]{1,6}[.)]?$/;

// The paragraphs of a shape's, cell's or notes' text. An empty text is [].
export function readText(text: any): Block[] {
  const paras: Para[] = [];
  let cur: Para | undefined;
  const open = (marker?: any) => {
    cur = {type: "para", style: "p", runs: []};
    const st = marker?.style;
    const align = ALIGN[st?.alignment];
    if (align) cur.align = align;
    if (st?.direction === "RIGHT_TO_LEFT") cur.dir = "rtl";
    const bullet = marker?.bullet;
    if (bullet) {
      const ordered = ORDERED.test((bullet.glyph ?? "").trim());
      cur.list = {ordered, level: bullet.nestingLevel ?? 0};
      if (ordered) cur.list.glyph = "1";
    }
    paras.push(cur);
    return cur;
  };
  for (const te of text?.textElements ?? []) {
    if (te.paragraphMarker) {
      open(te.paragraphMarker);
      continue;
    }
    const p = cur ?? open();
    const style = textStyle((te.textRun ?? te.autoText)?.style);
    if (te.textRun) {
      const content: string = te.textRun.content ?? "";
      const body = content.endsWith("\n") ? content.slice(0, -1) : content;
      if (body) p.runs.push({text: body, style});
    } else if (te.autoText) {
      const len = (te.endIndex ?? 0) - (te.startIndex ?? 0);
      const atom: Atom = {kind: "autotext", key: `autotext:${kebab(te.autoText.type ?? "")}`, attrs: {type: kebab(te.autoText.type ?? "")}, len};
      p.runs.push({atom, style} as Run);
    }
  }
  for (const p of paras) p.runs = normalizeRuns(p.runs);
  if (paras.length === 1 && !paras[0].runs.length && !paras[0].list) return [];
  return paras;
}

function fillOf(fill: any): string | undefined {
  if (!fill || (fill.propertyState && fill.propertyState !== "RENDERED")) return undefined;
  return opaque(fill.solidFill?.color);
}

// ---------- the deck ----------

// One object goog can address, with what the planner needs to change it.
export interface RElement {
  id: string;
  slide: string;
  raw: any;
  el: El;
  W: number; // raw size, EMU
  H: number;
  parent: Affine; // the group's absolute transform (identity at the top level)
  abs: Affine;
  group?: string; // id of the enclosing group
}

export interface RSlide {
  id: string;
  raw: any;
  notesId?: string; // the speaker notes shape (may not exist yet)
  notes: Block[];
}

export interface RemoteDeck {
  deck: Deck;
  raw: any;
  slides: RSlide[];
  els: Map<string, RElement>;
}

export function fromApi(raw: any): RemoteDeck {
  // Placeholders may leave out their size or transform and take the layout's.
  const inherited = new Map<string, any>();
  const index = (els: any[] = []) => {
    for (const e of els) {
      inherited.set(e.objectId, e);
      index(e.elementGroup?.children);
    }
  };
  for (const page of [...(raw.layouts ?? []), ...(raw.masters ?? [])]) index(page.pageElements);
  const sizeOf = (e: any, depth = 0): any => e.size ?? (depth < 4 ? sizeOf(inherited.get(e.shape?.placeholder?.parentObjectId) ?? {}, depth + 1) : undefined);
  const transformOf = (e: any, depth = 0): any =>
    e.transform ?? (depth < 4 ? transformOf(inherited.get(e.shape?.placeholder?.parentObjectId) ?? {}, depth + 1) : undefined);

  // Layouts are named like title-and-body. Decks often carry several masters
  // with the same layout names; the master most slides use gets the plain
  // names, and the rest are written by id.
  const used = new Map<string, number>();
  const masterOf = new Map<string, string>();
  for (const l of raw.layouts ?? []) masterOf.set(l.objectId, l.layoutProperties?.masterObjectId ?? "");
  for (const s of raw.slides ?? []) {
    const m = masterOf.get(s.slideProperties?.layoutObjectId) ?? "";
    used.set(m, (used.get(m) ?? 0) + 1);
  }
  const ranked = [...(raw.layouts ?? [])].sort((x, y) => (used.get(masterOf.get(y.objectId)!) ?? 0) - (used.get(masterOf.get(x.objectId)!) ?? 0));
  const taken = new Set<string>();
  const layoutName = new Map<string, string>();
  for (const l of ranked) {
    const nm = l.layoutProperties?.name ? kebab(l.layoutProperties.name) : "";
    const name = nm && !taken.has(nm) ? nm : l.objectId;
    taken.add(name);
    layoutName.set(l.objectId, name);
  }
  const layouts: Layout[] = [];
  for (const l of raw.layouts ?? []) {
    const placeholders: Layout["placeholders"] = [];
    for (const e of l.pageElements ?? []) {
      const ph = e.shape?.placeholder;
      if (ph?.type) placeholders.push({type: ph.type, index: ph.index ?? 0});
    }
    const layout: Layout = {id: l.objectId, name: layoutName.get(l.objectId)!, placeholders};
    if (l.layoutProperties?.displayName) layout.title = l.layoutProperties.displayName;
    layouts.push(layout);
  }

  const els = new Map<string, RElement>();
  const read = (e: any, slide: string, parent: Affine, group?: string): El => {
    const W = emu(sizeOf(e)?.width);
    const H = emu(sizeOf(e)?.height);
    const abs = compose(parent, affineOf(transformOf(e)));
    const common: {id: string; alt?: string} = {id: e.objectId};
    if (e.description) common.alt = e.description;
    const geom = () => geomOf(abs, W || 1, H || 1);
    let el: El;
    if (e.shape) {
      const s = e.shape;
      el = {...common, kind: "shape", type: kebab(s.shapeType ?? "TEXT_BOX"), geom: geom(), text: readText(s.text)};
      if (s.placeholder?.type) el.placeholder = kebab(s.placeholder.type) + (s.placeholder.index ? `:${s.placeholder.index}` : "");
      const fill = fillOf(s.shapeProperties?.shapeBackgroundFill);
      if (fill) el.fill = fill;
      // An inherited outline is the layout's business; goog leaves it alone.
      const o = s.shapeProperties?.outline;
      const outline = o?.propertyState === "INHERIT" ? undefined : fillOf(o?.outlineFill && {...o.outlineFill, propertyState: o.propertyState});
      if (outline) {
        el.outline = outline;
        const w = o.weight?.magnitude ?? 9525;
        el.outlineWidth = o.weight?.unit === "PT" ? w : w / EMU_PER_PT;
      }
    } else if (e.image) {
      el = {...common, kind: "image", geom: geom()};
    } else if (e.line) {
      const lp = e.line.lineProperties ?? {};
      const start = lp.startArrow && lp.startArrow !== "NONE";
      const end = lp.endArrow && lp.endArrow !== "NONE";
      el = {...common, kind: "line", ...lineEnds(abs, W, H)};
      if (start || end) el.arrow = start && end ? "both" : start ? "start" : "end";
    } else if (e.table) {
      el = {...common, kind: "table", geom: {x: abs.tx / EMU_PER_PT, y: abs.ty / EMU_PER_PT}, table: readTable(e.table)};
    } else if (e.video) {
      el = {...common, kind: "video", geom: geom()};
      if (e.video.source === "YOUTUBE") el.youtube = e.video.id;
      else if (e.video.id) el.drive = e.video.id;
    } else if (e.elementGroup) {
      el = {...common, kind: "group", children: (e.elementGroup.children ?? []).map((c: any) => read(c, slide, abs, e.objectId))};
    } else {
      const type = Object.keys(e).find((k) => !["objectId", "size", "transform", "title", "description"].includes(k)) ?? "object";
      el = {...common, kind: "object", type: kebab(type.replace(/[A-Z]/g, (c) => "_" + c)), geom: geom()};
    }
    els.set(e.objectId, {id: e.objectId, slide, raw: e, el, W, H, parent, abs, group});
    return el;
  };

  const slides: Slide[] = [];
  const rslides: RSlide[] = [];
  for (const s of raw.slides ?? []) {
    const slide: Slide = {id: s.objectId, elements: (s.pageElements ?? []).map((e: any) => read(e, s.objectId, IDENTITY)), notes: []};
    const layout = s.slideProperties?.layoutObjectId;
    if (layout) slide.layout = layoutName.get(layout) ?? layout;
    if (s.slideProperties?.isSkipped) slide.skip = true;
    const np = s.slideProperties?.notesPage;
    const notesId = np?.notesProperties?.speakerNotesObjectId;
    const notesShape = (np?.pageElements ?? []).find((e: any) => e.objectId === notesId);
    slide.notes = readText(notesShape?.shape?.text);
    slides.push(slide);
    rslides.push({id: s.objectId, raw: s, notesId, notes: slide.notes});
  }
  const deck: Deck = {kind: "slides", id: raw.presentationId, slides, layouts};
  if (raw.title) deck.name = raw.title;
  if (raw.revisionId) deck.rev = raw.revisionId;
  return {deck, raw, slides: rslides, els};
}

function readTable(t: any): Table {
  const R = t.rows ?? t.tableRows?.length ?? 0;
  const C = t.columns ?? t.tableColumns?.length ?? 0;
  const rows: Block[][][] = [];
  const info: (CellInfo | undefined)[][] = [];
  const covered = new Set<string>();
  let any = false;
  for (let r = 0; r < R; r++) {
    rows.push([]);
    info.push([]);
    const cells: any[] = t.tableRows?.[r]?.tableCells ?? [];
    for (let c = 0; c < C; c++) {
      const cell = cells.find((x) => (x.location?.rowIndex ?? r) === r && (x.location?.columnIndex ?? 0) === c) ?? cells[c];
      rows[r].push(readText(cell?.text));
      const ci: CellInfo = {};
      if ((cell?.columnSpan ?? 1) > 1) ci.colspan = cell.columnSpan;
      if ((cell?.rowSpan ?? 1) > 1) ci.rowspan = cell.rowSpan;
      const bg = fillOf(cell?.tableCellProperties?.tableCellBackgroundFill);
      if (bg) ci.bg = bg;
      if (covered.has(`${r},${c}`)) ci.covered = true;
      for (let dr = 0; dr < (ci.rowspan ?? 1); dr++) for (let dc = 0; dc < (ci.colspan ?? 1); dc++) if (dr || dc) covered.add(`${r + dr},${c + dc}`);
      const keep = Object.keys(ci).length ? ci : undefined;
      info[r].push(keep);
      if (keep) any = true;
    }
  }
  const table: Table = {type: "table", rows};
  if (any) table.cells = info;
  return table;
}
