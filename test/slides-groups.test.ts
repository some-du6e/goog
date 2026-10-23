// Groups, end to end: each edit is pushed through the Slides sim
// (test/slides-sim.ts) until it settles, and the deck it leaves is checked.

import assert from "node:assert/strict";
import test from "node:test";
import {serialize} from "../src/slides-format.ts";
import {fromApi} from "../src/slides-read.ts";
import {settle, shape} from "./slides-sim.ts";

const box = (id: string, extra: any = {}) => ({
  objectId: id,
  size: {width: {magnitude: 3000000, unit: "EMU"}, height: {magnitude: 3000000, unit: "EMU"}},
  transform: {scaleX: 0.2, scaleY: 0.2, translateX: 127000, translateY: 127000, unit: "EMU"},
  shape: {shapeType: "RECTANGLE"},
  ...extra,
});
const group = (id: string, ...children: any[]) => ({objectId: id, transform: {scaleX: 1, scaleY: 1, unit: "EMU"}, elementGroup: {children}});
const deck = (...pageElements: any[]) => ({
  presentationId: "deck",
  pageSize: {width: {magnitude: 9144000, unit: "EMU"}, height: {magnitude: 5143500, unit: "EMU"}},
  slides: [{objectId: "slide1", pageElements}],
});
const table = (id: string) => ({objectId: id, transform: box(id).transform, table: {rows: 1, columns: 1, tableRows: [{tableCells: [{}]}]}});
const text = (raw: any) => serialize(fromApi(structuredClone(raw)).deck);
// A shape's lines in the file, by id.
const lines = (raw: any, id: string) => text(raw).split("\n").find((l) => l.includes(`id="${id}"`))!;
const file = (...body: string[]) => ["<!-- goog slides deck -->", "", '<slide id="slide1">', ...body, "</slide>", ""].join("\n");
// The slide's objects as nested ids, with the ones goog made called "new".
const now = (raw: any) => JSON.parse(JSON.stringify(shape(raw)).replace(/goog_[a-z0-9]+/g, "new"));
const kinds = (passes: any[][]) => passes.map((p) => p.map((q) => Object.keys(q)[0]));

test("groups: wrapping objects in a new <group> groups them in one pass", () => {
  const raw = deck(box("aaaaa"), box("bbbbb"), box("ccccc"));
  const r = settle(raw, file("<group>", lines(raw, "aaaaa"), lines(raw, "bbbbb"), "</group>", lines(raw, "ccccc")));
  assert.deepEqual(kinds(r.passes), [["groupObjects"]]);
  assert.deepEqual(now(raw), [{new: ["aaaaa", "bbbbb"]}, "ccccc"]);
});

test("groups: wrapping an existing group keeps what's inside it", () => {
  const raw = deck(group("ggggg", box("aaaaa"), box("bbbbb")), box("ccccc"));
  const t = text(raw).replace('<group id="ggggg"', "<group>\n$&").replace(/(<shape id="ccccc"[^\n]*)/, "$1\n</group>");
  settle(raw, t);
  assert.deepEqual(now(raw), [{new: [{ggggg: ["aaaaa", "bbbbb"]}, "ccccc"]}]);
});

test("groups: an object moved into a group that's also being wrapped isn't deleted", () => {
  const raw = deck(group("ggggg", box("aaaaa"), box("bbbbb")), box("xxxxx"), box("yyyyy"));
  const t = file("<group>", '<group id="ggggg">', lines(raw, "aaaaa"), lines(raw, "bbbbb"), lines(raw, "xxxxx"), "</group>", lines(raw, "yyyyy"), "</group>");
  const r = settle(raw, t);
  assert.ok(!r.passes.flat().some((q) => q.deleteObject), JSON.stringify(r.passes));
  assert.deepEqual(now(raw), [{new: [{ggggg: ["aaaaa", "bbbbb", "xxxxx"]}, "yyyyy"]}]);
});

test("groups: objects move into and out of an existing group", () => {
  // Out: c leaves the group for the top level.
  let raw = deck(group("ggggg", box("aaaaa"), box("bbbbb"), box("ccccc")));
  settle(raw, file('<group id="ggggg">', lines(raw, "aaaaa"), lines(raw, "bbbbb"), "</group>", lines(raw, "ccccc")));
  assert.deepEqual(now(raw), [{ggggg: ["aaaaa", "bbbbb"]}, "ccccc"]);
  // In: an existing object and a new one join the group.
  raw = deck(group("ggggg", box("aaaaa"), box("bbbbb")), box("ccccc"));
  settle(raw, file('<group id="ggggg">', lines(raw, "aaaaa"), lines(raw, "bbbbb"), lines(raw, "ccccc"), '<shape type="rectangle" x="1" y="1" w="10" h="10"></shape>', "</group>"));
  assert.deepEqual(now(raw), [{ggggg: ["aaaaa", "bbbbb", "ccccc", "new"]}]);
  // A new group inside an existing one.
  raw = deck(group("ggggg", box("aaaaa"), box("bbbbb"), box("ccccc")));
  settle(raw, file('<group id="ggggg">', "<group>", lines(raw, "aaaaa"), lines(raw, "bbbbb"), "</group>", lines(raw, "ccccc"), "</group>"));
  assert.deepEqual(now(raw), [{ggggg: [{new: ["aaaaa", "bbbbb"]}, "ccccc"]}]);
});

test("groups: a group inside another group can't change, and says so", () => {
  const raw = deck(group("qqqqq", group("ggggg", box("aaaaa"), box("bbbbb"), box("ccccc")), box("ddddd")));
  const before = now(raw);
  const r = settle(raw, file('<group id="qqqqq">', '<group id="ggggg">', "<group>", lines(raw, "aaaaa"), lines(raw, "bbbbb"), "</group>", lines(raw, "ccccc"), "</group>", lines(raw, "ddddd"), "</group>"));
  assert.deepEqual(r.passes, []);
  assert.deepEqual(now(raw), before);
  assert.match(r.warnings.join("\n"), /ggggg is inside another group/);
  assert.match(r.warnings.join("\n"), /new <group> .* inside another group/);
  // Nor can one two levels down be ungrouped.
  const deep = deck(group("qqqqq", group("ooooo", group("ggggg", box("aaaaa"), box("bbbbb")), box("ccccc")), box("ddddd")));
  const d = settle(deep, text(deep).replace(/<group id="ggggg"[^\n]*\n/, "").replace("</group>\n", ""));
  assert.deepEqual(d.passes, []);
  assert.match(d.warnings.join("\n"), /ggggg is inside another group, and Slides can only change or ungroup a top-level group/);
});

test("groups: dropping a group's wrapper ungroups it, even inside another group", () => {
  let raw = deck(group("ggggg", box("aaaaa"), box("bbbbb")), box("ccccc"));
  let r = settle(raw, text(raw).replace(/<group id="ggggg"[^\n]*\n/, "").replace("</group>\n", ""));
  assert.deepEqual(kinds(r.passes), [["ungroupObjects"]]);
  assert.deepEqual(now(raw), ["aaaaa", "bbbbb", "ccccc"]);
  // The outer group is ungrouped and made again around the inner one's members.
  raw = deck(group("ooooo", group("ggggg", box("aaaaa"), box("bbbbb")), box("ccccc")));
  r = settle(raw, text(raw).replace(/<group id="ggggg"[^\n]*\n/, "").replace("</group>\n", ""));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(now(raw), [{ooooo: ["aaaaa", "bbbbb", "ccccc"]}]);
  // Dropping the whole group deletes it, members and all.
  raw = deck(group("ggggg", box("aaaaa"), box("bbbbb")), box("ccccc"));
  r = settle(raw, file(lines(raw, "ccccc")));
  assert.deepEqual(r.passes, [[{deleteObject: {objectId: "ggggg"}}]]);
});

test("groups: a group dropped to one member dissolves, with a warning", () => {
  const raw = deck(group("ggggg", box("aaaaa"), box("bbbbb")), box("ccccc"));
  const r = settle(raw, file('<group id="ggggg">', lines(raw, "aaaaa"), "</group>", lines(raw, "ccccc")));
  assert.deepEqual(now(raw), ["aaaaa", "ccccc"]);
  assert.match(r.warnings.join(), /needs at least two objects/);
});

test("groups: a group that can't be made doesn't hold up the slide's z-order", () => {
  const raw = deck(box("aaaaa"), box("bbbbb"), box("ccccc"));
  const r = settle(raw, file(lines(raw, "ccccc"), lines(raw, "bbbbb"), "<group>", lines(raw, "aaaaa"), "</group>"));
  assert.match(r.warnings.join(), /needs at least two objects/);
  assert.deepEqual(now(raw), ["ccccc", "bbbbb", "aaaaa"]);
});

test("groups: tables, videos and placeholders (even pictures) aren't grouped", () => {
  const pic = {objectId: "ppppp", size: box("x").size, transform: box("x").transform, image: {contentUrl: "https://x", placeholder: {type: "PICTURE"}}};
  for (const odd of [pic, box("ppppp", {shape: {shapeType: "TEXT_BOX", placeholder: {type: "TITLE"}}})]) {
    const raw = deck(odd, box("aaaaa"), box("bbbbb"));
    const t = text(raw).split("\n");
    const at = t.findIndex((l) => l.includes('id="ppppp"'));
    const end = t.findIndex((l, i) => i >= at && /<\/shape>|<image /.test(l));
    t.splice(end + 1, 0, lines(raw, "aaaaa"), "</group>");
    t.splice(at, 0, "<group>");
    const r = settle(raw, t.join("\n").replace(/(<\/group>\n)<shape id="aaaaa"[^\n]*\n/, "$1"));
    assert.deepEqual(r.passes, []);
    assert.match(r.warnings.join(), /can't hold tables, videos or layout placeholders/);
  }
});

test("groups: a new group pasted twice makes two groups", () => {
  const raw = deck(box("aaaaa"), box("bbbbb"));
  const g = ["<group>", lines(raw, "aaaaa"), lines(raw, "bbbbb"), "</group>"];
  settle(raw, file(...g, ...g));
  const out = now(raw);
  assert.equal(out.length, 2);
  for (const x of out) assert.equal(Object.values(x as object)[0].length, 2);
});

test("groups: a change a group can't take leaves the group as it is", () => {
  // A table moved in, or a new image goog can't make.
  for (const extra of [(t: string) => /<table id="ttttt"[\s\S]*?<\/table>/.exec(t)![0], () => '<image x="1" y="1" w="10" h="10">']) {
    const raw = deck(group("ggggg", box("aaaaa"), box("bbbbb")), table("ttttt"));
    const t = text(raw);
    const r = settle(raw, t.replace(/<table id="ttttt"[\s\S]*?<\/table>\n/, "").replace("</group>", `${extra(t)}\n</group>`));
    assert.ok(!r.passes.flat().some((q) => q.ungroupObjects), JSON.stringify(r.passes));
    assert.deepEqual(now(raw)[0], {ggggg: ["aaaaa", "bbbbb"]});
    assert.match(r.warnings.join(), /the group ggggg can't change/);
  }
  // An object moved into a group two levels down stays where it was, and so
  // does everything around it.
  const raw = deck(group("qqqqq", group("ggggg", group("hhhhh", box("aaaaa"), box("bbbbb")), box("ccccc")), box("ddddd"), box("eeeee")));
  const before = now(raw);
  const t = text(raw).replace(/(<shape id="ddddd"[^\n]*\n)/, "").replace(/(<shape id="bbbbb"[^\n]*)/, `$1\n${lines(raw, "ddddd")}`);
  const r = settle(raw, t);
  assert.deepEqual(r.passes, []);
  assert.deepEqual(now(raw), before);
  assert.match(r.warnings.join(), /hhhhh is inside another group/);
});

test("groups: members are stacked in the file's order", () => {
  let raw = deck(group("ggggg", box("aaaaa"), box("bbbbb")));
  settle(raw, file('<group id="ggggg">', lines(raw, "bbbbb"), lines(raw, "aaaaa"), "</group>"));
  assert.deepEqual(now(raw), [{ggggg: ["bbbbb", "aaaaa"]}]);
  raw = deck(box("aaaaa"), box("bbbbb"), box("ccccc"));
  settle(raw, file("<group>", lines(raw, "bbbbb"), lines(raw, "aaaaa"), "</group>", lines(raw, "ccccc")));
  assert.deepEqual(now(raw), [{new: ["bbbbb", "aaaaa"]}, "ccccc"]);
});

test("groups: a new group that can't be made gives its members to the group around it", () => {
  // Deleting one of two members dissolves the inner group; the outer one stays.
  let raw = deck(group("qqqqq", group("ggggg", box("aaaaa"), box("bbbbb")), box("ccccc")));
  let r = settle(raw, text(raw).replace(/<shape id="bbbbb"[^\n]*\n/, ""));
  assert.deepEqual(now(raw), [{qqqqq: ["aaaaa", "ccccc"]}]);
  assert.match(r.warnings.join(), /needs at least two objects/);
  raw = deck(box("aaaaa"), box("bbbbb"));
  r = settle(raw, file("<group>", "<group>", lines(raw, "aaaaa"), "</group>", lines(raw, "bbbbb"), "</group>"));
  assert.deepEqual(now(raw), [{new: ["aaaaa", "bbbbb"]}]);
});

test("groups: pasting an existing group again copies it without a warning", () => {
  const raw = deck(group("ggggg", box("aaaaa"), box("bbbbb")));
  const g = text(raw).split("\n").slice(3, -2);
  const r = settle(raw, file(...g, ...g));
  assert.deepEqual(r.warnings, []);
  assert.equal(now(raw).length, 2);
});

test("groups: ids the file repeats, or that the deck uses, aren't reused", () => {
  const raw = deck(box("aaaaa"), box("bbbbb"), box("ccccc"), box("ddddd"));
  const g = (a: string, b: string, id: string) => [`<group id="${id}">`, lines(raw, a), lines(raw, b), "</group>"];
  settle(raw, file(...g("aaaaa", "bbbbb", "mygroup"), ...g("ccccc", "ddddd", "mygroup"), '<shape id="myshape" type="rectangle"></shape>', '<shape id="myshape" type="rectangle"></shape>', '<shape id="slide1" type="rectangle"></shape>'));
  assert.equal(now(raw).length, 5);
});

test("an <object> moved to another slide stays where it is", () => {
  const raw: any = deck(box("aaaaa"), {objectId: "chart", transform: box("x").transform, size: box("x").size, sheetsChart: {spreadsheetId: "s", chartId: 1}});
  raw.slides.push({objectId: "slide2", pageElements: []});
  const t = text(raw);
  const chart = lines(raw, "chart");
  const r = settle(raw, t.replace(chart + "\n", "").replace('<slide id="slide2">', `<slide id="slide2">\n${chart}`));
  assert.deepEqual(now(raw), ["aaaaa", "chart"]);
  assert.match(r.warnings.join(), /can't move an <object> \(chart\)/);
});

test("z-order: moving one object to the front is one request", () => {
  const ids = ["aaaaa", "bbbbb", "ccccc", "ddddd", "eeeee"];
  const raw = deck(...ids.map((id) => box(id)));
  const r = settle(raw, file(...ids.slice(1).map((id) => lines(raw, id)), lines(raw, "aaaaa")));
  assert.deepEqual(r.passes, [[{updatePageElementsZOrder: {pageElementObjectIds: ["aaaaa"], operation: "BRING_TO_FRONT"}}]]);
  assert.deepEqual(now(raw), [...ids.slice(1), "aaaaa"]);
});
