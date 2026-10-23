// A stand-in for the Slides API's structural requests, for checking that the
// planner's group, copy, create and delete passes converge. It edits a deck's
// raw API response in place, following these rules, observed live:
// - groupObjects needs at least two top-level objects on one slide, and
//   refuses tables, videos, placeholders and objects already in a group. The
//   group takes the place of its frontmost member, and its members keep their
//   order back to front, whatever order the request lists them in.
// - ungroupObjects only finds top-level groups; the members take its place.
// - deleting a group's member down to one dissolves the group: the last
//   member takes its place.
// - duplicateObject puts the copy at the front of the slide, at the top level,
//   even when the original is inside a group. Ids the request doesn't map are
//   made up.
// - created objects go in at the front.
// - updatePageElementsZOrder only takes top-level objects.
// - a new object's id (created, grouped or copied) can't be one in use.
// Everything else (text, styles, transforms) is left alone; `settle` stops
// once a pass plans none of the requests above.

import {type Deck, parse, serialize} from "../src/slides-format.ts";
import {plan} from "../src/slides-plan.ts";
import {fromApi} from "../src/slides-read.ts";

type Hit = {list: any[]; i: number; page: any; parent?: any};

function find(raw: any, id: string): Hit | undefined {
  for (const page of raw.slides ?? []) {
    const look = (list: any[], parent?: any): Hit | undefined => {
      for (let i = 0; i < list.length; i++) {
        if (list[i].objectId === id) return {list, i, page, parent};
        const k = list[i].elementGroup && look(list[i].elementGroup.children, list[i]);
        if (k) return k;
      }
    };
    const h = look(page.pageElements ?? []);
    if (h) return h;
  }
}

const reject = (k: string, why: string) => {
  throw new Error(`Invalid requests.${k}: ${why}`);
};

// Removes the object at h, dissolving any group that leaves with one member.
function remove(raw: any, h: Hit) {
  h.list.splice(h.i, 1);
  if (h.parent && h.list.length === 1) {
    const up = find(raw, h.parent.objectId)!;
    up.list.splice(up.i, 1, h.list[0]);
  } else if (h.parent && !h.list.length) remove(raw, find(raw, h.parent.objectId)!);
}

let made = 0;

export const STRUCTURAL = ["createShape", "createLine", "createImage", "createVideo", "duplicateObject", "deleteObject", "groupObjects", "ungroupObjects", "updatePageElementsZOrder"];

function used(raw: any, id: string, k: string) {
  if (find(raw, id) || raw.slides.some((s: any) => s.objectId === id)) reject(k, `The object ID (${id}) should be unique among all pages and page elements.`);
}

export function apply(raw: any, requests: any[]) {
  for (const q of requests) {
    const [k, v] = Object.entries(q)[0] as [string, any];
    if (k.startsWith("create")) used(raw, v.objectId, k);
    if (k === "groupObjects") used(raw, v.groupObjectId, k);
    if (k === "duplicateObject") for (const id of Object.values(v.objectIds ?? {}) as string[]) used(raw, id, k);
    switch (k) {
      case "createShape":
      case "createLine":
      case "createImage":
      case "createVideo": {
        const page = raw.slides.find((s: any) => s.objectId === v.elementProperties.pageObjectId);
        const e: any = {objectId: v.objectId, size: v.elementProperties.size, transform: v.elementProperties.transform};
        if (k === "createShape") e.shape = {shapeType: v.shapeType};
        if (k === "createLine") e.line = {lineCategory: v.lineCategory, lineProperties: {}};
        if (k === "createImage") e.image = {contentUrl: v.url};
        if (k === "createVideo") e.video = {source: v.source, id: v.id};
        (page.pageElements ??= []).push(e);
        break;
      }
      case "duplicateObject": {
        const h = find(raw, v.objectId) ?? reject(k, `The object (${v.objectId}) could not be found.`);
        const copy = structuredClone(h.list[h.i]);
        const rename = (x: any) => {
          x.objectId = v.objectIds?.[x.objectId] ?? `SLIDES_API${made++}`;
          x.elementGroup?.children.forEach(rename);
        };
        rename(copy);
        h.page.pageElements.push(copy);
        break;
      }
      case "deleteObject": {
        const h = find(raw, v.objectId);
        if (h) remove(raw, h);
        else if (raw.slides.some((s: any) => s.objectId === v.objectId)) raw.slides = raw.slides.filter((s: any) => s.objectId !== v.objectId);
        else reject(k, `The object (${v.objectId}) could not be found.`);
        break;
      }
      case "groupObjects": {
        if (v.childrenObjectIds.length < 2) reject(k, "At least two page elements should be specified to group.");
        const hits = v.childrenObjectIds.map((id: string) => find(raw, id) ?? reject(k, `The object (${id}) could not be found.`));
        for (const h of hits) {
          const e = h.list[h.i];
          if (h.parent || h.page !== hits[0].page || e.table || e.video || e.shape?.placeholder || e.image?.placeholder) {
            reject(k, `The page element (${e.objectId}) cannot be grouped.`);
          }
        }
        const list: any[] = hits[0].page.pageElements;
        const members = hits.map((h: Hit) => h.list[h.i]).sort((a: any, b: any) => list.indexOf(a) - list.indexOf(b));
        const at = list.indexOf(members.at(-1));
        list.splice(at, 1, {objectId: v.groupObjectId, transform: {scaleX: 1, scaleY: 1, unit: "EMU"}, elementGroup: {children: members}});
        for (const m of members.slice(0, -1)) list.splice(list.indexOf(m), 1);
        break;
      }
      case "ungroupObjects":
        for (const id of v.objectIds) {
          const h = find(raw, id);
          if (!h || h.parent || !h.list[h.i].elementGroup) reject(k, `The object (${id}) could not be found.`);
          h!.list.splice(h!.i, 1, ...h!.list[h!.i].elementGroup.children);
        }
        break;
      case "updatePageElementsZOrder":
        for (const id of v.pageElementObjectIds) {
          const h = find(raw, id) ?? reject(k, `The object (${id}) could not be found.`);
          if (h.parent) reject(k, `The page element (${id}) must not be in a group for this operation.`);
          if (v.operation !== "BRING_TO_FRONT") reject(k, `unsimulated operation ${v.operation}`);
          h.list.push(...h.list.splice(h.i, 1));
        }
        break;
    }
  }
}

// What a slide holds, as nested ids: ["a", {g: ["b", "c"]}].
export function shape(raw: any, slide = 0): any[] {
  const t = (e: any): any => (e.elementGroup ? {[e.objectId]: e.elementGroup.children.map(t)} : e.objectId);
  return (raw.slides[slide].pageElements ?? []).map(t);
}

// Pushes `file` to `raw` the way pushDeck does, pass by pass, until a pass
// plans nothing structural. Throws if Slides would reject a pass, or if it
// doesn't settle.
export function settle(raw: any, file: string, maxPasses = 6): {passes: any[][]; warnings: string[]; text: string} {
  const want: Deck = parse(file);
  const passes: any[][] = [];
  const warnings: string[] = [];
  for (let pass = 0; pass < maxPasses; pass++) {
    const p = plan(fromApi(structuredClone(raw)), want);
    for (const w of p.warnings) if (!warnings.includes(w)) warnings.push(w);
    const moves = p.requests.filter((q) => STRUCTURAL.includes(Object.keys(q)[0]));
    if (!moves.length) return {passes, warnings, text: serialize(fromApi(structuredClone(raw)).deck)};
    passes.push(moves);
    apply(raw, moves);
  }
  throw new Error(`didn't settle in ${maxPasses} passes: ${JSON.stringify(passes.at(-1))}`);
}
