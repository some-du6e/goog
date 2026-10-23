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
import {type Deck, type El, type Geom, type Layout, type Slide, shout} from "./slides-format.ts";
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

  // Every id in the deck, and each one handed out this pass: Slides refuses
  // a new object whose id is taken.
  const taken = new Set<string>();
  const ids = (x: any) => {
    if (Array.isArray(x)) x.forEach(ids);
    else if (x && typeof x === "object") {
      if (typeof x.objectId === "string") taken.add(x.objectId);
      Object.values(x).forEach(ids);
    }
  };
  ids(remote.raw);
  const fresh = (id: string | undefined) => {
    const out = id && VALID_ID.test(id) && !taken.has(id) ? id : newId();
    taken.add(out);
    return out;
  };

  // An object pasted from elsewhere becomes a new one made from the file.
  const renew = (e: El) => {
    const src = e.id ? remote.els.get(e.id) : undefined;
    if (e.kind === "image" && !e.src && src?.raw.image?.contentUrl) e.src = src.raw.image.contentUrl;
    e.id = fresh(e.id);
    if (e.kind === "group") e.children.forEach(renew);
  };

  const kidsOf = new Map<string, RElement[]>();
  const bySlide = new Map<string, RElement[]>();
  const add = (m: Map<string, RElement[]>, k: string, r: RElement) => (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  for (const r of remote.els.values()) {
    if (r.group) add(kidsOf, r.group, r);
    add(bySlide, r.slide, r);
  }
  // An object's id and the ids of everything inside it.
  const subtree = (id: string): string[] => [id, ...(kidsOf.get(id) ?? []).flatMap((c) => subtree(c.id))];

  // goog can't make an <object> (a chart, say), so one the file moves to
  // another slide stays where it is.
  const stuckObjects = new Set<string>();
  const objects = (els: El[], slide?: string) => {
    for (const e of els) {
      if (e.kind === "group") objects(e.children, slide);
      const r = e.kind === "object" && e.id ? remote.els.get(e.id) : undefined;
      if (r && r.slide !== slide) stuckObjects.add(r.id);
    }
  };
  for (const s of want.slides) objects(s.elements, s.id);

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
    s.id = fresh(s.id);
    const layout = findLayout(remote.deck.layouts ?? [], s.layout, warn);
    const mappings: any[] = [];
    const used = new Set<string>();
    for (const e of s.elements) {
      renew(e);
      const inside = (x: El): boolean => x.kind === "group" && x.children.some((c) => (c.kind === "shape" && !!c.placeholder) || inside(c));
      if (inside(e)) warn(`a layout placeholder can't go in a <group>; slide ${s.id}'s grouped one is a plain shape`);
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
    const kept = (bySlide.get(rs.id) ?? []).find((r) => stuckObjects.has(r.id));
    if (kept) {
      warn(`slide ${rs.id} holds an <object> (${kept.id}) the file moved to another slide, which Slides can't do; the slide was kept`);
      continue;
    }
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
  // A slide's objects go in two steps: match the file's objects to the deck's
  // (kept, copied or new), then decide what happens to each group, since that
  // depends on where all of a group's members ended up.
  for (const s of want.slides) {
    if (pending.has(s)) continue;
    const rs = rslides.get(s.id!)!;
    const reqs: any[] = [];
    const creating: any[] = [];
    const grouping: any[] = [];
    let busy = false; // objects were added, copied, grouped or ungrouped: z-order waits for the next pass

    // copy: the deck object a pasted copy is made from. made: a new object's
    // create was planned (goog can't make some, like an <image> without src).
    interface Node {e: El; r?: RElement; copy?: RElement; made?: boolean; kids: Node[]}
    const kept: Node[] = [];
    const match = (els: El[]): Node[] =>
      els.map((e): Node => {
        const r = e.id ? remote.els.get(e.id) : undefined;
        if (r && r.slide === s.id && !claimedEls.has(r.id)) {
          claimedEls.add(r.id);
          const n = {e, r, kids: e.kind === "group" ? match(e.children) : []};
          kept.push(n);
          return n;
        }
        if (r && r.slide === s.id) {
          // A second copy on the same slide. Slides puts a copy at the top
          // level, even of an object inside a group. A copy of a group that
          // holds objects from outside it is a new group instead.
          const inside = new Set(subtree(r.id));
          const foreign = (x: El): boolean => x.kind === "group" && x.children.some((c) => (c.id && remote.els.has(c.id) && !inside.has(c.id)) || foreign(c));
          if (!foreign(e)) {
            const ids: Record<string, string> = {};
            const remap = (x: El) => {
              if (x.id && inside.has(x.id) && !Object.hasOwn(ids, x.id)) ids[x.id] = x.id = fresh(undefined);
              else renew(x);
              if (x.kind === "group") x.children.forEach(remap);
            };
            const src = e.id!;
            remap(e);
            creating.push({duplicateObject: {objectId: src, objectIds: ids}});
            busy = true;
            return {e, copy: r, kids: []};
          }
        }
        if (r && r.slide !== s.id && e.kind === "object") return {e, kids: []}; // stays on its own slide; see `stuckObjects`
        if (e.kind === "group") {
          // Only the group is new: its members keep their ids, so ones that
          // already exist are grouped rather than made again.
          e.id = fresh(e.id);
          return {e, kids: match(e.children)};
        }
        renew(e);
        const made = create(e, s.id!, warn);
        if (made.length) busy = true;
        creating.push(...made);
        return {e, kids: [], made: made.length > 0};
      });
    const tree = match(s.elements);
    const order = new Map<string, number>((rs.raw.pageElements ?? []).map((e: any, i: number) => [e.objectId, i]));

    // Slides can't add an object to a group or take one out, so a changed
    // top-level group is ungrouped and made again from the file next pass, if
    // it can be. Each group the file changed or dropped gets one fate:
    // ungroup it now, wait for the group around it to be ungrouped, or leave
    // it as it is (stuck).
    const fate = new Map<string, "ungroup" | "wait" | "stuck">();
    const why = new Map<string, string>(); // why a group is stuck
    const dissolving = new Set<string>(); // Slides dissolves a group left with one member
    const leaving = (id: string) => dissolving.has(id) || fate.get(id) === "ungroup" || fate.get(id) === "wait";
    const isNew = (n: Node) => !n.r && !n.copy && n.e.kind === "group";
    // A new group that can't be made leaves its members where they are.
    const members = (n: Node, home?: string): Node[] => n.kids.flatMap((k) => (isNew(k) && blocked(k, home) ? members(k, home) : [k]));
    // Why `n` can't be made (or, for an existing group `home`, made again),
    // if it can't. Members from inside `home` are fine: ungrouping it frees them.
    const within = (id: string | undefined, home?: string): boolean => !!id && !!home && (id === home || within(remote.els.get(id)?.group, home));
    const memo = new Map<string, string | undefined>(); // blocked(), per node and home, for this round's fates
    const nodeKey = new Map<Node, number>();
    const blocked = (n: Node, home?: string): string | undefined => {
      const key = `${nodeKey.get(n) ?? nodeKey.set(n, nodeKey.size).get(n)} ${home ?? ""}`;
      if (!memo.has(key)) memo.set(key, blocking(n, home));
      return memo.get(key);
    };
    const blocking = (n: Node, home?: string): string | undefined => {
      const kids = members(n, home);
      const src = (k: Node) => k.r ?? k.copy;
      if (kids.some((k) => (src(k) ? !groupable(src(k)!) : k.e.kind === "table" || k.e.kind === "video"))) return "can't hold tables, videos or layout placeholders";
      if (kids.length < 2) return TOO_FEW;
      if (kids.some((k) => k.r?.group && !within(k.r.group, home) && !leaving(k.r.group))) return "can't take objects that are inside another group";
      if (kids.some((k) => !src(k) && !isNew(k) && !k.made)) return "holds an object goog couldn't make";
    };
    const frozen = new Map<string, string>(); // objects a stuck group would have taken or let go (by group): left where they are
    const changes = (n: Node) => {
      const have: string[] = (n.r!.raw.elementGroup.children ?? []).map((c: any) => c.objectId);
      const mine = members(n, n.r!.id).map((k) => k.e.id!);
      const haveSet = new Set(have);
      const mineSet = new Set(mine);
      const moved = [...mine.filter((id) => !haveSet.has(id)), ...have.filter((id) => claimedEls.has(id) && !mineSet.has(id))].filter((id) => (frozen.get(id) ?? n.r!.id) === n.r!.id);
      // Slides keeps members in their stacking order, so the order changes by regrouping too.
      const common = mine.filter((id) => haveSet.has(id));
      const now = have.filter((id) => mineSet.has(id));
      return {moved, changed: moved.length > 0 || common.some((id, i) => now[i] !== id)};
    };
    const mine = bySlide.get(s.id!) ?? [];
    const staying = (id: string): boolean => claimedEls.has(id) || stuckObjects.has(id) || keepsChild(id);
    const keepsChild = (id: string): boolean => (kidsOf.get(id) ?? []).some((c) => staying(c.id));
    const groups: {r: RElement; n?: Node}[] = [];
    for (const n of kept) {
      if (!n.r!.raw.elementGroup) continue;
      if ((kidsOf.get(n.r!.id) ?? []).filter((c) => staying(c.id)).length < 2) dissolving.add(n.r!.id);
      else groups.push({r: n.r!, n});
    }
    // A group the file dropped but kept some of the members of is ungrouped,
    // not deleted (that would take the members with it).
    for (const r of mine) if (!claimedEls.has(r.id) && r.raw.elementGroup && keepsChild(r.id)) groups.push({r});
    // Every group starts out leaving, and each round decides every group from
    // the last round's fates; a group only stops leaving, so this settles on
    // the most that can be done (two groups swapping members both regroup).
    for (const {r} of groups) fate.set(r.id, r.group ? "wait" : "ungroup");
    for (let round = 0; round <= groups.length + 1; round++) {
      const was = JSON.stringify([...fate, ...frozen]);
      const now = new Map<string, "ungroup" | "wait" | "stuck">();
      const next = new Map<string, string>();
      memo.clear();
      for (const {r, n} of groups) {
        const c = n && changes(n);
        if (c && !c.changed) continue;
        // One member left is no group at all, so it's fine to take apart.
        const reason = n && blocked(n, r.id);
        const real = reason && reason !== TOO_FEW ? reason : undefined;
        const nested = r.group && !leaving(r.group);
        if (nested || real) {
          now.set(r.id, "stuck");
          why.set(r.id, nested ? `the group ${r.id} is inside another group, and Slides can only change or ungroup a top-level group; it was left as it is` : `the group ${r.id} can't change: a group ${real}; it was left as it is`);
          for (const id of c?.moved ?? []) next.set(id, r.id);
        } else now.set(r.id, r.group ? "wait" : "ungroup");
      }
      fate.clear();
      for (const [id, f] of now) fate.set(id, f);
      frozen.clear();
      for (const [id, g] of next) frozen.set(id, g);
      if (JSON.stringify([...fate, ...frozen]) === was) break;
    }
    memo.clear();
    for (const [id, f] of fate) {
      if (f === "ungroup") reqs.push({ungroupObjects: {objectIds: [id]}});
      if (f === "stuck") warn(why.get(id)!);
    }
    if (dissolving.size || [...fate.values()].some((f) => f !== "stuck")) busy = true;

    // What the file dropped is deleted. Members of a dropped group that's
    // ungrouped wait until they're top-level.
    for (const r of mine) {
      if (claimedEls.has(r.id) || fate.has(r.id) || (r.group && !claimedEls.has(r.group))) continue;
      if (stuckObjects.has(r.id)) warn(`Slides can't move an <object> (${r.id}) to another slide; it stays on slide ${s.id}`);
      else reqs.push({deleteObject: {objectId: r.id}});
    }

    // New groups. One is made once all its members exist at the top level;
    // until then they're made, copied or ungrouped above.
    const moving = new Set<string>(); // going into a new group: diffed next pass
    const visit = (nodes: Node[]) => {
      for (const n of nodes) {
        visit(n.kids);
        if (!isNew(n)) continue;
        const reason = blocked(n);
        if (reason) {
          warn(`slide ${s.id}'s new <group> wasn't made: a group ${reason}`);
          continue;
        }
        const kids = members(n);
        if (!kids.every((k) => k.r && !k.r.group && !leaving(k.r.id))) continue;
        // Members keep their stacking order, so the file's goes in first.
        const at = kids.map((k) => order.get(k.r!.id)!);
        if (at.some((x, i) => i && x < at[i - 1])) {
          for (const k of kids) grouping.push({updatePageElementsZOrder: {pageElementObjectIds: [k.r!.id], operation: "BRING_TO_FRONT"}});
        }
        grouping.push({groupObjects: {groupObjectId: n.e.id, childrenObjectIds: kids.map((k) => k.r!.id)}});
        for (const k of kids) for (const id of subtree(k.r!.id)) moving.add(id);
        busy = true;
      }
    };
    visit(tree);

    for (const {e, r} of kept) {
      // Ungrouping and grouping move what's inside; it's diffed next pass.
      if (moving.has(r!.id) || leaving(r!.id) || (r!.group && leaving(r!.group))) busy = true;
      else reqs.push(...diffEl(e, r!, warn));
    }

    // z-order: file order is back to front. The objects at the back that are
    // already in order stay; the rest are brought to the front in order.
    if (!busy) {
      const flat = (nodes: Node[]): string[] => nodes.flatMap((n) => (n.r ? (n.r.group ? [] : [n.r.id]) : isNew(n) ? flat(n.kids) : []));
      const top = flat(tree);
      let k = 1;
      while (k < top.length && order.get(top[k])! > order.get(top[k - 1])!) k++;
      for (const id of top.slice(k)) reqs.push({updatePageElementsZOrder: {pageElementObjectIds: [id], operation: "BRING_TO_FRONT"}});
    }

    if (!!s.skip !== !!rs.raw.slideProperties?.isSkipped) {
      reqs.push({updateSlideProperties: {objectId: s.id, slideProperties: {isSkipped: !!s.skip}, fields: "isSkipped"}});
    }
    const rl = remote.deck.slides.find((x) => x.id === s.id)?.layout;
    if (s.layout && rl && s.layout !== rl) warn(`a slide's layout can't be changed through the API (slide ${s.id} stays ${rl})`);

    if (rs.notesId) reqs.push(...textOps({objectId: rs.notesId}, rs.notes, s.notes, warn));
    else if (paras(s.notes).length) warn(`slide ${s.id} has no speaker notes box, so its notes weren't written`);
    elementReqs.push(...creating, ...reqs, ...grouping);
  }

  return {requests: [...first, ...elementReqs, ...last], warnings};
}

const TOO_FEW = "needs at least two objects";

// What groupObjects takes: Slides refuses tables, videos and placeholders.
const groupable = (r: RElement) => !(r.raw.table || r.raw.video || r.raw.shape?.placeholder || r.raw.image?.placeholder);

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
