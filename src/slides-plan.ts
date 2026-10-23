// Plans the Slides API requests that make a deck match a .goog file, one pass
// at a time; slides.ts sends each pass and replans against a fresh read until
// a pass plans nothing.
//
// A pass makes structural changes first (slides and objects created,
// duplicated, deleted, reordered), and edits an object's properties only once
// it exists. A text's content is fixed before its styles, so style ranges are
// always planned against the text as it really is.
//
// Objects are matched by id. goog picks the ids of everything it creates and
// writes them into `want`, so the next pass finds them. A second copy of an
// id (a <slide> block or an object line pasted again) is a duplicate.

import {diffArrays} from "diff";
import type {Block, Para, Run, TextStyle} from "./model.ts";
import {type Deck, type El, type Geom, type Layout, type Slide, fmt, shout} from "./slides-format.ts";
import {
  type RElement, type RemoteDeck, EMU_PER_PT, affineFor, apiTransform, compose, invert, lineAffine,
} from "./slides-read.ts";

export interface SPlan {
  requests: any[];
  warnings: string[];
}

let seq = 0;
export const newId = () => `goog_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const VALID_ID = /^[a-zA-Z0-9_][a-zA-Z0-9_\-:]{4,49}$/;

const OBJ = "￼"; // stands in for an autotext's index units

export function plan(remote: RemoteDeck, want: Deck): SPlan {
  const warnings: string[] = [];
  const warn = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  const first: any[] = []; // slide creates and duplicates
  const elementReqs: any[] = [];
  const last: any[] = []; // slide deletes and moves
  const rslides = new Map(remote.slides.map((s) => [s.id, s]));
  const claimedSlides = new Set<string>();
  const claimedEls = new Set<string>();
  const pending = new Set<Slide>(); // created this pass; their contents wait for the next one

  // An object pasted from elsewhere becomes a new one made from the file.
  const renew = (e: El) => {
    const src = e.id ? remote.els.get(e.id) : undefined;
    if (e.kind === "image" && !e.src && src?.raw.image?.contentUrl) e.src = src.raw.image.contentUrl;
    if (!e.id || src || !VALID_ID.test(e.id)) e.id = newId();
    if (e.kind === "group") e.children.forEach(renew);
  };

  // ---------- slides ----------
  const arrangement = remote.slides.map((s) => s.id);
  for (const s of want.slides) {
    if (s.id && rslides.has(s.id) && !claimedSlides.has(s.id)) {
      claimedSlides.add(s.id);
      continue;
    }
    if (s.id && rslides.has(s.id)) {
      const src = s.id;
      const ids: Record<string, string> = {[src]: (s.id = newId())};
      const remap = (els: El[]) => {
        for (const e of els) {
          if (e.id && remote.els.get(e.id)?.slide === src && !Object.hasOwn(ids, e.id)) ids[e.id] = e.id = newId();
          else renew(e);
          if (e.kind === "group") remap(e.children);
        }
      };
      remap(s.elements);
      first.push({duplicateObject: {objectId: src, objectIds: ids}});
      arrangement.splice(arrangement.indexOf(src) + 1, 0, s.id);
      pending.add(s);
      continue;
    }
    s.id = s.id && VALID_ID.test(s.id) && !remote.els.has(s.id) ? s.id : newId();
    const layout = findLayout(remote.deck.layouts ?? [], s.layout, warn);
    const mappings: any[] = [];
    const used = new Set<string>();
    for (const e of s.elements) {
      renew(e);
      if (e.kind !== "shape" || !e.placeholder) continue;
      const [type, index = "0"] = e.placeholder.split(":");
      const ph = layout?.placeholders.find((p) => p.type === shout(type) && p.index === Number(index) && !used.has(`${p.type}:${p.index}`));
      if (!ph) {
        warn(`layout ${layout?.name ?? "(default)"} has no ${e.placeholder} placeholder; added a plain ${e.type} instead`);
        continue;
      }
      used.add(`${ph.type}:${ph.index}`);
      mappings.push({layoutPlaceholder: {type: ph.type, index: ph.index}, objectId: e.id});
    }
    const req: any = {objectId: s.id};
    if (layout) req.slideLayoutReference = {layoutId: layout.id};
    if (mappings.length) req.placeholderIdMappings = mappings;
    first.push({createSlide: req});
    arrangement.push(s.id);
    pending.add(s);
  }
  for (const rs of remote.slides) {
    if (claimedSlides.has(rs.id)) continue;
    last.push({deleteObject: {objectId: rs.id}});
    arrangement.splice(arrangement.indexOf(rs.id), 1);
  }
  // Slides already in the right relative order stay; each other one moves to
  // just after the slide that comes before it in the file. insertionIndex
  // counts positions before the move, so "after prev" is indexOf(prev) + 1.
  const order = want.slides.map((s) => s.id!);
  const stay = new Set(longestRun(order.map((id) => arrangement.indexOf(id))).map((k) => order[k]));
  order.forEach((id, i) => {
    if (stay.has(id)) return;
    const at = i ? arrangement.indexOf(order[i - 1]) + 1 : 0;
    if (arrangement[at] === id) return;
    last.push({updateSlidesPosition: {slideObjectIds: [id], insertionIndex: at}});
    const before = arrangement[at];
    arrangement.splice(arrangement.indexOf(id), 1);
    arrangement.splice(before === undefined ? arrangement.length : arrangement.indexOf(before), 0, id);
  });

  // ---------- objects on each slide ----------
  for (const s of want.slides) {
    if (pending.has(s)) continue;
    const rs = rslides.get(s.id!)!;
    const reqs: any[] = [];
    const creating: any[] = [];
    const kept: {e: El; r: RElement}[] = [];
    let busy = false; // objects were added: z-order waits for the next pass

    const walk = (els: El[]) => {
      for (const e of els) {
        const r = e.id ? remote.els.get(e.id) : undefined;
        if (r && r.slide === s.id && !claimedEls.has(r.id)) {
          claimedEls.add(r.id);
          kept.push({e, r});
          if (e.kind === "group") walk(e.children);
          continue;
        }
        busy = true;
        if (r && r.slide === s.id) {
          // A second copy on the same slide.
          const ids: Record<string, string> = {};
          const remap = (x: El) => {
            if (x.id && remote.els.has(x.id) && !Object.hasOwn(ids, x.id)) ids[x.id] = x.id = newId();
            else renew(x);
            if (x.kind === "group") x.children.forEach(remap);
          };
          const src = e.id!;
          remap(e);
          creating.push({duplicateObject: {objectId: src, objectIds: ids}});
          continue;
        }
        renew(e);
        if (e.kind === "group") {
          const ready = e.children.every((c) => c.id && remote.els.get(c.id)?.slide === s.id && !remote.els.get(c.id)?.group);
          if (ready && e.children.length >= 2) {
            creating.push({groupObjects: {groupObjectId: e.id, childrenObjectIds: e.children.map((c) => c.id)}});
            for (const c of e.children) claimedEls.add(c.id!);
          } else walk(e.children);
          continue;
        }
        creating.push(...create(e, s.id!, warn));
      }
    };
    walk(s.elements);

    // A group the file dropped but kept some of the children of is ungrouped,
    // not deleted (that would take the children with it). Its children are
    // diffed, and the ones the file dropped deleted, next pass, once they're
    // top-level.
    const keepsChild = (id: string): boolean => [...remote.els.values()].some((c) => c.group === id && (claimedEls.has(c.id) || keepsChild(c.id)));
    const ungrouped = new Set<string>();
    for (const [id, r] of remote.els) {
      if (r.slide !== s.id || claimedEls.has(id)) continue;
      if (r.group && !claimedEls.has(r.group)) continue; // goes with (or waits for) its group
      if (r.raw.elementGroup && keepsChild(id)) {
        ungrouped.add(id);
        reqs.unshift({ungroupObjects: {objectIds: [id]}});
      } else reqs.push({deleteObject: {objectId: id}});
    }
    for (const {e, r} of kept) {
      if (r.group && ungrouped.has(r.group)) busy = true;
      else reqs.push(...diffEl(e, r, warn));
    }

    // z-order: file order is back to front.
    if (!busy) {
      const top = s.elements.map((e) => e.id!).filter((id) => remote.els.get(id)?.slide === s.id && !remote.els.get(id)?.group);
      const now = (rs.raw.pageElements ?? []).map((e: any) => e.objectId).filter((id: string) => top.includes(id));
      const k = top.findIndex((id, i) => now[i] !== id);
      if (k >= 0) for (const id of top.slice(k)) reqs.push({updatePageElementsZOrder: {pageElementObjectIds: [id], operation: "BRING_TO_FRONT"}});
    }

    if (!!s.skip !== !!rs.raw.slideProperties?.isSkipped) {
      reqs.push({updateSlideProperties: {objectId: s.id, slideProperties: {isSkipped: !!s.skip}, fields: "isSkipped"}});
    }
    const rl = remote.deck.slides.find((x) => x.id === s.id)?.layout;
    if (s.layout && rl && s.layout !== rl) warn(`a slide's layout can't be changed through the API (slide ${s.id} stays ${rl})`);

    if (rs.notesId) reqs.push(...textOps({objectId: rs.notesId}, rs.notes, s.notes, warn));
    else if (paras(s.notes).length) warn(`slide ${s.id} has no speaker notes box, so its notes weren't written`);
    elementReqs.push(...creating, ...reqs);
  }

  return {requests: [...first, ...elementReqs, ...last], warnings};
}

// Indexes (into xs) of a longest increasing subsequence of xs.
function longestRun(xs: number[]): number[] {
  const tails: number[] = []; // index of the smallest tail of a run of each length
  const prev: number[] = [];
  xs.forEach((x, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[tails[mid]] < x) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo ? tails[lo - 1] : -1;
    tails[lo] = i;
  });
  const out: number[] = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i]) out.unshift(i);
  return out;
}

function findLayout(layouts: Layout[], name: string | undefined, warn: (w: string) => void): Layout | undefined {
  if (!name) return undefined;
  const l = layouts.find((x) => x.name === name || x.id === name) ?? layouts.find((x) => x.title?.toLowerCase() === name.toLowerCase());
  if (!l) warn(`no layout called "${name}" (see the layouts line at the top of the file); used the default`);
  return l;
}

// ---------- creating ----------

const DEFAULT_BOX = {x: 40, y: 40, w: 300, h: 60};

function fullGeom(g: Geom, def = DEFAULT_BOX) {
  return {...def, ...Object.fromEntries(Object.entries(g).filter(([, v]) => v !== undefined))} as typeof DEFAULT_BOX & Geom;
}

function placed(page: string, g: Geom) {
  const full = fullGeom(g);
  const W = full.w * EMU_PER_PT || EMU_PER_PT;
  const H = full.h * EMU_PER_PT || EMU_PER_PT;
  return {
    pageObjectId: page,
    size: {width: {magnitude: W, unit: "EMU"}, height: {magnitude: H, unit: "EMU"}},
    transform: apiTransform(affineFor(full, W, H)),
  };
}

function create(e: El, page: string, warn: (w: string) => void): any[] {
  switch (e.kind) {
    case "shape": {
      const out: any[] = [{createShape: {objectId: e.id, shapeType: shout(e.type), elementProperties: placed(page, e.geom)}}];
      // Its text goes in now; styles follow next pass.
      const text = flat(paras(e.text), []).slice(0, -1).replaceAll(OBJ, "");
      if (text) out.push({insertText: {objectId: e.id, insertionIndex: 0, text}});
      return out;
    }
    case "image":
      if (!e.src) {
        warn(`a new <image> needs src="https://…" (a picture anyone can open); skipped it`);
        return [];
      }
      const src = e.src;
      delete e.src;
      return [{createImage: {objectId: e.id, url: src, elementProperties: placed(page, e.geom)}}];
    case "line": {
      if ([e.x1, e.y1, e.x2, e.y2].some((v) => v === undefined)) {
        warn(`a new <line> needs x1, y1, x2 and y2; skipped it`);
        return [];
      }
      const dx = (e.x2! - e.x1!) * EMU_PER_PT;
      const dy = (e.y2! - e.y1!) * EMU_PER_PT;
      return [{createLine: {objectId: e.id, lineCategory: "STRAIGHT", elementProperties: {
        pageObjectId: page,
        size: {width: {magnitude: Math.abs(dx), unit: "EMU"}, height: {magnitude: Math.abs(dy), unit: "EMU"}},
        transform: {scaleX: Math.sign(dx) || 1, scaleY: Math.sign(dy) || 1, translateX: e.x1! * EMU_PER_PT, translateY: e.y1! * EMU_PER_PT, unit: "EMU"},
      }}}];
    }
    case "table": {
      const g = fullGeom(e.geom);
      return [{createTable: {objectId: e.id, rows: e.table.rows.length, columns: e.table.rows[0]?.length ?? 1, elementProperties: {
        pageObjectId: page, transform: {scaleX: 1, scaleY: 1, translateX: g.x * EMU_PER_PT, translateY: g.y * EMU_PER_PT, unit: "EMU"},
      }}}];
    }
    case "video":
      if (!e.youtube && !e.drive) {
        warn(`a new <video> needs youtube="VIDEO_ID" or drive="FILE_ID"; skipped it`);
        return [];
      }
      return [{createVideo: {objectId: e.id, source: e.youtube ? "YOUTUBE" : "DRIVE", id: e.youtube ?? e.drive, elementProperties: placed(page, e.geom)}}];
    case "object":
      warn(`goog can't make a new <object type="${e.type}">; skipped it`);
      return [];
    case "group":
      return [];
  }
}

// ---------- changing ----------

function apiColor(c: string): any {
  if (!c.startsWith("#")) return {themeColor: shout(c)};
  const v = (i: number) => parseInt(c.slice(i, i + 2), 16) / 255;
  return {rgbColor: {red: v(1), green: v(3), blue: v(5)}};
}

// Slides keeps a transform's scale to 4 decimals, about 0.02pt on a typical
// object, so a position that close is already where the file says.
const NEAR = 0.05;
const near = (a: number | undefined, b: number | undefined) => Math.abs((a ?? 0) - (b ?? 0)) < NEAR;

// Angles a turn apart are the same: a file's rot="240" reads back as -120.
const nearAngle = (a: number | undefined, b: number | undefined) => {
  const d = Math.abs((((a ?? 0) - (b ?? 0)) % 360 + 360) % 360);
  return Math.min(d, 360 - d) < NEAR;
};

const sameGeom = (a: Geom, b: Geom) =>
  near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h) && nearAngle(a.rot, b.rot) && (a.flip ?? "") === (b.flip ?? "");

// The box the file asks for: unset fields stay as they are, but a box given in
// full drops a rotation or flip it no longer mentions.
function wantedGeom(g: Geom, cur: Geom): Geom {
  const out: Geom = {...cur};
  for (const k of ["x", "y", "w", "h", "rot", "flip"] as const) if (g[k] !== undefined) (out as any)[k] = g[k];
  if (g.x !== undefined && g.y !== undefined && g.w !== undefined && g.h !== undefined) {
    if (g.rot === undefined) delete out.rot;
    if (g.flip === undefined) delete out.flip;
  }
  return out;
}

function moveTo(r: RElement, abs: ReturnType<typeof compose>) {
  return {updatePageElementTransform: {objectId: r.id, applyMode: "ABSOLUTE", transform: apiTransform(compose(invert(r.parent), abs))}};
}

function diffEl(e: El, r: RElement, warn: (w: string) => void): any[] {
  const out: any[] = [];
  const cur = r.el;
  if (cur.kind !== e.kind) {
    warn(`${r.id} is a ${cur.kind} in the deck; an object can't change kind (delete it and add a new one without an id)`);
    return out;
  }
  if ((e.alt ?? "") !== (cur.alt ?? "")) out.push({updatePageElementAltText: {objectId: r.id, description: e.alt ?? ""}});
  if ("geom" in e && "geom" in cur && e.kind !== "table") {
    const g = wantedGeom(e.geom, cur.geom);
    if (!sameGeom(g, cur.geom)) out.push(moveTo(r, affineFor(g as any, r.W || 1, r.H || 1)));
  }
  switch (e.kind) {
    case "shape": {
      const c = cur as typeof e;
      if (e.type !== c.type) warn(`${r.id}: a shape's type can't be changed (it stays ${c.type})`);
      if (e.fill !== c.fill) {
        out.push({updateShapeProperties: {objectId: r.id, ...(e.fill
          ? {shapeProperties: {shapeBackgroundFill: {propertyState: "RENDERED", solidFill: {color: apiColor(e.fill), alpha: 1}}}, fields: "shapeBackgroundFill.propertyState,shapeBackgroundFill.solidFill.color,shapeBackgroundFill.solidFill.alpha"}
          : {shapeProperties: {shapeBackgroundFill: {propertyState: "NOT_RENDERED"}}, fields: "shapeBackgroundFill.propertyState"})}});
      }
      if (e.outline !== c.outline || (e.outline && e.outlineWidth !== undefined && !near(e.outlineWidth, c.outlineWidth))) {
        out.push({updateShapeProperties: {objectId: r.id, ...(e.outline
          ? {shapeProperties: {outline: {propertyState: "RENDERED", outlineFill: {solidFill: {color: apiColor(e.outline), alpha: 1}}, weight: {magnitude: e.outlineWidth ?? c.outlineWidth ?? 1, unit: "PT"}}}, fields: "outline.propertyState,outline.outlineFill.solidFill.color,outline.outlineFill.solidFill.alpha,outline.weight"}
          : {shapeProperties: {outline: {propertyState: "NOT_RENDERED"}}, fields: "outline.propertyState"})}});
      }
      out.push(...textOps({objectId: r.id}, c.text, e.text, warn));
      break;
    }
    case "image":
      if (e.src) {
        out.push({replaceImage: {imageObjectId: r.id, url: e.src, imageReplaceMethod: "CENTER_CROP"}});
        delete e.src;
      }
      break;
    case "line": {
      const c = cur as typeof e;
      const ends = {x1: e.x1 ?? c.x1!, y1: e.y1 ?? c.y1!, x2: e.x2 ?? c.x2!, y2: e.y2 ?? c.y2!};
      if ((["x1", "y1", "x2", "y2"] as const).some((k) => !near(ends[k], c[k]))) {
        out.push(moveTo(r, lineAffine(ends.x1, ends.y1, ends.x2, ends.y2, r.W || EMU_PER_PT, r.H || EMU_PER_PT)));
      }
      if ((e.arrow ?? "") !== (c.arrow ?? "")) {
        const lp = r.raw.line?.lineProperties ?? {};
        const has = (side: "start" | "end") => e.arrow === side || e.arrow === "both";
        const keep = (cur: string | undefined) => (cur && cur !== "NONE" ? cur : "FILL_ARROW");
        out.push({updateLineProperties: {objectId: r.id, lineProperties: {
          startArrow: has("start") ? keep(lp.startArrow) : "NONE",
          endArrow: has("end") ? keep(lp.endArrow) : "NONE",
        }, fields: "startArrow,endArrow"}});
      }
      break;
    }
    case "table":
      out.push(...tableOps(e, r, warn));
      break;
  }
  return out;
}

function tableOps(e: El & {kind: "table"}, r: RElement, warn: (w: string) => void): any[] {
  const out: any[] = [];
  const cur = (r.el as typeof e);
  const g = e.geom;
  if ((g.x !== undefined && !near(g.x, cur.geom.x)) || (g.y !== undefined && !near(g.y, cur.geom.y))) {
    out.push(moveTo(r, {...r.abs, tx: (g.x ?? cur.geom.x!) * EMU_PER_PT, ty: (g.y ?? cur.geom.y!) * EMU_PER_PT}));
  }
  const have = cur.table.rows;
  const want = e.table.rows;
  const id = r.id;
  // Rows: matched by content, so a row added or removed in the middle keeps the others.
  const key = (row: Block[][]) => JSON.stringify(row.map((c) => flat(paras(c), [])));
  let changed = false;
  if (have.length !== want.length) {
    changed = true;
    const ops: any[][] = [];
    let at = 0;
    for (const part of diffArrays(have.map(key), want.map(key))) {
      if (part.removed) {
        const dels: any[] = [];
        for (let k = part.count! - 1; k >= 0; k--) dels.push({deleteTableRow: {tableObjectId: id, cellLocation: {rowIndex: at + k}}});
        ops.push(dels);
        at += part.count!;
      } else if (part.added) {
        ops.push([at > 0
          ? {insertTableRows: {tableObjectId: id, cellLocation: {rowIndex: at - 1}, insertBelow: true, number: part.count}}
          : {insertTableRows: {tableObjectId: id, cellLocation: {rowIndex: 0}, insertBelow: false, number: part.count}}]);
      } else at += part.count!;
    }
    // Back to front, so earlier row indexes stay put.
    out.push(...ops.reverse().flat());
  }
  const C0 = have[0]?.length ?? 0;
  const C1 = want[0]?.length ?? 0;
  if (!changed && C1 > C0) {
    changed = true;
    out.push({insertTableColumns: {tableObjectId: id, cellLocation: {rowIndex: 0, columnIndex: C0 - 1}, insertRight: true, number: C1 - C0}});
  } else if (!changed && C1 < C0) {
    changed = true;
    for (let c = C0 - 1; c >= C1; c--) out.push({deleteTableColumn: {tableObjectId: id, cellLocation: {rowIndex: 0, columnIndex: c}}});
  }
  if (changed) return out; // cells next pass, once the grid matches
  for (let ri = 0; ri < want.length; ri++) {
    for (let ci = 0; ci < C1; ci++) {
      const wi = e.table.cells?.[ri]?.[ci];
      const hi = cur.table.cells?.[ri]?.[ci];
      if ((wi?.colspan ?? 1) !== (hi?.colspan ?? 1) || (wi?.rowspan ?? 1) !== (hi?.rowspan ?? 1)) {
        warn(`merging or splitting table cells isn't supported yet (table ${id})`);
      }
      if (hi?.covered) continue;
      if ((wi?.bg ?? "") !== (hi?.bg ?? "")) {
        const range = {location: {rowIndex: ri, columnIndex: ci}, rowSpan: 1, columnSpan: 1};
        out.push({updateTableCellProperties: {objectId: id, tableRange: range, ...(wi?.bg
          ? {tableCellProperties: {tableCellBackgroundFill: {propertyState: "RENDERED", solidFill: {color: apiColor(wi.bg), alpha: 1}}}, fields: "tableCellBackgroundFill.propertyState,tableCellBackgroundFill.solidFill.color,tableCellBackgroundFill.solidFill.alpha"}
          : {tableCellProperties: {tableCellBackgroundFill: {propertyState: "NOT_RENDERED"}}, fields: "tableCellBackgroundFill.propertyState"})}});
      }
      out.push(...textOps({objectId: id, cellLocation: {rowIndex: ri, columnIndex: ci}}, have[ri][ci], want[ri][ci], warn));
    }
  }
  return out;
}

// ---------- text ----------

type Where = {objectId: string; cellLocation?: {rowIndex: number; columnIndex: number}};

// Paragraphs, with an empty text as none at all (that's how the API returns it).
function paras(blocks: Block[]): Para[] {
  const ps = blocks.filter((b): b is Para => b.type === "para");
  if (ps.length === 1 && !ps[0].runs.length && !ps[0].list) return [];
  return ps;
}

const atomLens = (have: Para[]) => {
  const m = new Map<string, number>();
  for (const p of have) for (const r of p.runs) if ("atom" in r && r.atom.len) m.set(r.atom.key, r.atom.len);
  return m;
};

const runLen = (r: Run, lens: Map<string, number>) => ("text" in r ? r.text.length : r.atom.len ?? lens.get(r.atom.key) ?? 0);

// The text as the API indexes it: every paragraph ends in \n.
function flat(ps: Para[], have: Para[]): string {
  const lens = atomLens(have);
  return ps.map((p) => p.runs.map((r) => ("text" in r ? r.text : OBJ.repeat(runLen(r, lens)))).join("") + "\n").join("");
}

// Words, spaces and single other characters: diffing these keeps edits to
// whole words, so unchanged words keep their styling.
const tokens = (s: string) => s.match(/[\p{L}\p{N}_]+|\s+|[\s\S]/gu) ?? [];

function textOps(at: Where, haveBlocks: Block[], wantBlocks: Block[], warn: (w: string) => void): any[] {
  const have = paras(haveBlocks);
  const want = paras(wantBlocks);
  const hs = flat(have, have);
  const ws = flat(want, have);
  if (hs === ws) return styleOps(at, have, want);
  if (!ws) return [{deleteText: {...at, textRange: {type: "ALL"}}}];
  const clean = (s: string) => {
    if (!s.includes(OBJ)) return s;
    warn("slide numbers and other automatic text can't be added or moved; left them out");
    return s.replaceAll(OBJ, "");
  };
  if (!hs) {
    const text = clean(ws.slice(0, -1));
    return text ? [{insertText: {...at, insertionIndex: 0, text}}] : [];
  }
  // The final newline can't be deleted, so it's never part of an edit.
  const hunks: {at: number; del: number; ins: string}[] = [];
  let pos = 0;
  for (const part of diffArrays(tokens(hs.slice(0, -1)), tokens(ws.slice(0, -1)))) {
    const text = part.value.join("");
    const prev = hunks.at(-1);
    if (part.removed) {
      if (prev && prev.at + prev.del === pos && !prev.ins) prev.del += text.length;
      else hunks.push({at: pos, del: text.length, ins: ""});
      pos += text.length;
    } else if (part.added) {
      if (prev && prev.at + prev.del === pos) prev.ins += text;
      else hunks.push({at: pos, del: 0, ins: text});
    } else pos += text.length;
  }
  const out: any[] = [];
  for (const h of hunks.reverse()) {
    if (h.del) out.push({deleteText: {...at, textRange: {type: "FIXED_RANGE", startIndex: h.at, endIndex: h.at + h.del}}});
    const ins = clean(h.ins);
    if (ins) out.push({insertText: {...at, insertionIndex: h.at, text: ins}});
  }
  return out;
}

// API field name -> whether two styles differ in it.
const FIELDS: [string, (s: TextStyle) => unknown][] = [
  ["bold", (s) => !!s.b],
  ["italic", (s) => !!s.i],
  ["underline", (s) => !!s.u],
  ["strikethrough", (s) => !!s.s],
  ["smallCaps", (s) => !!s.smallcaps],
  ["baselineOffset", (s) => (s.sup ? "SUPERSCRIPT" : s.sub ? "SUBSCRIPT" : "NONE")],
  ["link", (s) => s.href],
  ["backgroundColor", (s) => s.mark],
  ["foregroundColor", (s) => s.color],
  ["weightedFontFamily", (s) => (s.font ? `${s.font}/${s.weight ?? 400}` : undefined)],
  ["fontSize", (s) => s.size],
];

function linkOf(href: string): any {
  let m = /^#slide=(.+)$/.exec(href);
  if (m) return {pageObjectId: m[1]};
  m = /^#slide-index=(\d+)$/.exec(href);
  if (m) return {slideIndex: Number(m[1])};
  m = /^#(next-slide|previous-slide|first-slide|last-slide)$/.exec(href);
  if (m) return {relativeLink: shout(m[1])};
  return {url: href};
}

// The API style for the given fields; a field left out of `style` but named
// in `fields` goes back to what the placeholder or theme says.
function apiStyle(s: TextStyle, fields: string[]): any {
  const out: any = {};
  for (const f of fields) {
    if (f === "bold") out.bold = !!s.b;
    if (f === "italic") out.italic = !!s.i;
    if (f === "underline") out.underline = !!s.u;
    if (f === "strikethrough") out.strikethrough = !!s.s;
    if (f === "smallCaps") out.smallCaps = !!s.smallcaps;
    if (f === "baselineOffset") out.baselineOffset = s.sup ? "SUPERSCRIPT" : s.sub ? "SUBSCRIPT" : "NONE";
    if (f === "link" && s.href) out.link = linkOf(s.href);
    if (f === "backgroundColor" && s.mark) out.backgroundColor = {opaqueColor: apiColor(s.mark)};
    if (f === "foregroundColor" && s.color) out.foregroundColor = {opaqueColor: apiColor(s.color)};
    if (f === "weightedFontFamily" && s.font) out.weightedFontFamily = {fontFamily: s.font, weight: s.weight ?? 400};
    if (f === "fontSize" && s.size) out.fontSize = {magnitude: s.size, unit: "PT"};
  }
  return out;
}

const API_ALIGN: Record<string, string> = {center: "CENTER", right: "END", justify: "JUSTIFIED"};

// Per index unit: the run style, or null for a paragraph's newline.
function unitStyles(ps: Para[], lens: Map<string, number>): (TextStyle | null)[] {
  const out: (TextStyle | null)[] = [];
  for (const p of ps) {
    for (const r of p.runs) for (let i = 0; i < runLen(r, lens); i++) out.push(r.style);
    out.push(null);
  }
  return out;
}

function styleOps(at: Where, have: Para[], want: Para[]): any[] {
  const out: any[] = [];
  const lens = atomLens(have);
  const hu = unitStyles(have, lens);
  const wu = unitStyles(want, lens);
  let run: {start: number; key: string; fields: string[]; style: TextStyle} | undefined;
  const flush = (end: number) => {
    if (run) out.push({updateTextStyle: {...at, textRange: {type: "FIXED_RANGE", startIndex: run.start, endIndex: end}, style: apiStyle(run.style, run.fields), fields: run.fields.join(",")}});
    run = undefined;
  };
  for (let i = 0; i <= hu.length; i++) {
    const h = hu[i];
    const w = wu[i];
    const fields = h && w ? FIELDS.filter(([, f]) => f(h) !== f(w)).map(([n]) => n) : [];
    const key = fields.length ? fields.join(",") + JSON.stringify(fields.map((f) => FIELDS.find(([n]) => n === f)![1](w!))) : "";
    if (run && run.key !== key) flush(i);
    if (key && !run) run = {start: i, key, fields, style: w!};
  }
  flush(hu.length);

  // Paragraph alignment and bullets, by paragraph.
  const starts: number[] = [];
  let p0 = 0;
  for (const p of have) {
    starts.push(p0);
    p0 += p.runs.reduce((n, r) => n + runLen(r, lens), 0) + 1;
  }
  starts.push(p0);
  // Paragraphs from..to; the API's text ends before the final newline, and
  // an empty last paragraph is addressed from its start.
  const paraRange = (from: number, to: number, extra = 0): any => {
    const end = (to === have.length - 1 ? starts[to + 1] - 1 : starts[to + 1]) + extra;
    return end > starts[from] ? {type: "FIXED_RANGE", startIndex: starts[from], endIndex: end} : {type: "FROM_START_INDEX", startIndex: starts[from]};
  };
  have.forEach((h, k) => {
    const w = want[k];
    if ((h.align ?? "") !== (w.align ?? "")) {
      out.push({updateParagraphStyle: {...at, textRange: paraRange(k, k), style: {alignment: API_ALIGN[w.align ?? ""] ?? "START"}, fields: "alignment"}});
    }
  });
  const kind = (p: Para) => (p.list ? (p.list.ordered ? "1" : "•") : "");
  const listKey = (p: Para) => (p.list ? `${kind(p)}${p.list.level}` : "");
  // Runs of paragraphs whose bullets change, back to front: making bullets
  // inserts tabs for the nesting level, which moves everything after them.
  const groups: {from: number; to: number}[] = [];
  have.forEach((h, k) => {
    if (listKey(h) === listKey(want[k])) return;
    const g = groups.at(-1);
    if (g && g.to === k - 1 && kind(want[g.from]) === kind(want[k])) g.to = k;
    else groups.push({from: k, to: k});
  });
  for (const g of groups.reverse()) {
    if (have.slice(g.from, g.to + 1).some((p) => p.list)) out.push({deleteParagraphBullets: {...at, textRange: paraRange(g.from, g.to)}});
    const k = kind(want[g.from]);
    if (!k) continue;
    let added = 0;
    for (let i = g.to; i >= g.from; i--) {
      const level = want[i].list!.level;
      if (!level) continue;
      out.push({insertText: {...at, insertionIndex: starts[i], text: "\t".repeat(level)}});
      added += level;
    }
    out.push({createParagraphBullets: {...at, textRange: paraRange(g.from, g.to, added), bulletPreset: k === "1" ? "NUMBERED_DIGIT_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE"}});
  }
  return out;
}
