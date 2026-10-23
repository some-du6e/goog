// Groups, end to end: each edit is pushed through the Slides sim
// (test/slides-sim.ts) until it settles, and the deck it leaves is checked.

import assert from "node:assert/strict";
import test from "node:test";
import {parse, serialize} from "../src/slides-format.ts";
import {plan} from "../src/slides-plan.ts";
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

test("groups: a group inside another changes by rebuilding the groups around it", () => {
  // A new group inside a nested group.
  let raw = deck(group("qqqqq", group("ggggg", box("aaaaa"), box("bbbbb"), box("ccccc")), box("ddddd")));
  let r = settle(raw, file('<group id="qqqqq">', '<group id="ggggg">', "<group>", lines(raw, "aaaaa"), lines(raw, "bbbbb"), "</group>", lines(raw, "ccccc"), "</group>", lines(raw, "ddddd"), "</group>"));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(now(raw), [{qqqqq: [{ggggg: [{new: ["aaaaa", "bbbbb"]}, "ccccc"]}, "ddddd"]}]);
  // A group two levels down dropped.
  raw = deck(group("qqqqq", group("ooooo", group("ggggg", box("aaaaa"), box("bbbbb")), box("ccccc")), box("ddddd")));
  r = settle(raw, text(raw).replace(/<group id="ggggg"[^\n]*\n/, "").replace("</group>\n", ""));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(now(raw), [{qqqqq: [{ooooo: ["aaaaa", "bbbbb", "ccccc"]}, "ddddd"]}]);
  // Restacking inside a nested group.
  raw = deck(group("qqqqq", group("ggggg", box("aaaaa"), box("bbbbb")), box("ccccc")));
  r = settle(raw, file('<group id="qqqqq">', '<group id="ggggg">', lines(raw, "bbbbb"), lines(raw, "aaaaa"), "</group>", lines(raw, "ccccc"), "</group>"));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(now(raw), [{qqqqq: [{ggggg: ["bbbbb", "aaaaa"]}, "ccccc"]}]);
  // A group that can't change keeps the groups inside it as they are, and says so.
  raw = deck(group("qqqqq", group("ggggg", box("aaaaa"), box("bbbbb")), box("ccccc")), table("ttttt"));
  const t = text(raw);
  const tb = /<table id="ttttt"[\s\S]*?<\/table>/.exec(t)![0];
  r = settle(raw, t.replace(tb + "\n", "").replace(/(<shape id="ccccc"[^\n]*)/, `$1\n${tb}`).replace(/(<shape id="aaaaa"[^\n]*\n)(<shape id="bbbbb"[^\n]*\n)/, "$2$1"));
  assert.deepEqual(now(raw), [{qqqqq: [{ggggg: ["aaaaa", "bbbbb"]}, "ccccc"]}, "ttttt"]);
  assert.match(r.warnings.join("\n"), /qqqqq can't change/);
  assert.match(r.warnings.join("\n"), /ggggg is inside qqqqq, which can't change/);
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
  // An object moved into a group two levels down gets there.
  const raw = deck(group("qqqqq", group("ggggg", group("hhhhh", box("aaaaa"), box("bbbbb")), box("ccccc")), box("ddddd"), box("eeeee")));
  const t = text(raw).replace(/(<shape id="ddddd"[^\n]*\n)/, "").replace(/(<shape id="bbbbb"[^\n]*)/, `$1\n${lines(raw, "ddddd")}`);
  const r = settle(raw, t);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(now(raw), [{qqqqq: [{ggggg: [{hhhhh: ["aaaaa", "bbbbb", "ddddd"]}, "ccccc"]}, "eeeee"]}]);
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

test("an <object> moved out of its group or off a deleted slide isn't deleted", () => {
  const chart = () => ({objectId: "chart", transform: box("x").transform, size: box("x").size, sheetsChart: {spreadsheetId: "s", chartId: 1}});
  // Its group (with a box) moves to slide 2.
  let raw: any = deck(group("ggggg", chart(), box("aaaaa")), box("zzzzz"));
  raw.slides.push({objectId: "slide2", pageElements: [box("yyyyy")]});
  let t = text(raw);
  const block = /<group id="ggggg"[\s\S]*?<\/group>\n/.exec(t)![0];
  let r = settle(raw, t.replace(block, "").replace(/(<slide id="slide2">\n)/, `$1${block}`));
  assert.ok(shape(raw).flat(2).some((x: any) => x === "chart" || JSON.stringify(x).includes("chart")), JSON.stringify(shape(raw)));
  assert.match(r.warnings.join(), /can't move an <object> \(chart\)/);
  // Its slide is deleted.
  raw = deck(chart(), box("aaaaa"));
  raw.slides.push({objectId: "slide2", pageElements: [box("yyyyy")]});
  t = text(raw);
  const line = lines(raw, "chart");
  r = settle(raw, t.replace(/<slide id="slide1">[\s\S]*?<\/slide>\n\n?/, "").replace(/(<slide id="slide2">\n)/, `$1${line}\n`));
  assert.equal(raw.slides.length, 2);
  assert.match(r.warnings.join(), /the slide was kept/);
});

test("groups: a group that can't change doesn't hold up the slide's z-order", () => {
  const raw = deck(group("ggggg", box("aaaaa"), box("bbbbb")), table("ttttt"), box("ccccc"));
  const t = text(raw);
  const tb = /<table id="ttttt"[\s\S]*?<\/table>/.exec(t)![0];
  const c = lines(raw, "ccccc");
  const r = settle(raw, t.replace(tb + "\n", "").replace(c + "\n", "").replace('<group id="ggggg"', `${c}\n<group id="ggggg"`).replace("</group>", `${tb}\n</group>`));
  assert.match(r.warnings.join(), /ggggg can't change/);
  const order = now(raw).map((x: any) => (typeof x === "string" ? x : Object.keys(x)[0]));
  assert.ok(order.indexOf("ccccc") < order.indexOf("ggggg"), JSON.stringify(order));
});

test("groups: two groups swap members, and a nested pair losing one member dissolves", () => {
  let raw = deck(group("g0000", box("aaaaa"), box("bbbbb")), group("g1111", box("ccccc"), box("ddddd")));
  let r = settle(raw, file('<group id="g0000">', lines(raw, "aaaaa"), lines(raw, "ccccc"), "</group>", '<group id="g1111">', lines(raw, "bbbbb"), lines(raw, "ddddd"), "</group>"));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(now(raw), [{g0000: ["aaaaa", "ccccc"]}, {g1111: ["bbbbb", "ddddd"]}]);
  raw = deck(group("qqqqq", group("ggggg", box("aaaaa"), box("bbbbb")), box("eeeee")));
  r = settle(raw, file('<group id="qqqqq">', '<group id="ggggg">', lines(raw, "aaaaa"), "</group>", lines(raw, "bbbbb"), lines(raw, "eeeee"), "</group>"));
  assert.deepEqual(now(raw), [{qqqqq: ["aaaaa", "bbbbb", "eeeee"]}]);
});

test("groups: more changes a group can't take, and what's kept around them", () => {
  // A new table inside a group: the group stays.
  let raw: any = deck(group("ggggg", box("aaaaa"), box("bbbbb")));
  let r = settle(raw, text(raw).replace("</group>", '<table x="1" y="1">\n<tr><td></td></tr>\n</table>\n</group>'));
  assert.ok(!r.passes.flat().some((q) => q.ungroupObjects));
  assert.match(r.warnings.join(), /ggggg can't change/);
  // A pasted copy of a group that also holds another object makes a new
  // group, and the other object isn't remade.
  raw = deck(group("ggggg", box("aaaaa"), box("bbbbb")), box("ccccc"));
  const g = text(raw).split("\n").slice(3, 7);
  r = settle(raw, file(...g, ...g.slice(0, 3), lines(raw, "ccccc"), "</group>"));
  assert.ok(!r.passes.flat().some((q) => q.deleteObject), JSON.stringify(r.passes));
  assert.ok(JSON.stringify(shape(raw)).includes('"ccccc"'));
  // A chart moved to another slide out of a group: no "can't make" warning,
  // and the rest of the group still gets its edits.
  raw = deck(group("ggggg", {objectId: "chart", transform: box("x").transform, size: box("x").size, sheetsChart: {spreadsheetId: "s", chartId: 1}}, box("aaaaa")));
  raw.slides.push({objectId: "slide2", pageElements: []});
  const t = text(raw);
  const chart = lines(raw, "chart");
  r = settle(raw, t.replace(chart + "\n", "").replace('<slide id="slide2">', `<slide id="slide2">\n${chart}`));
  assert.doesNotMatch(r.warnings.join(), /can't make a new/);
});

test("groups: each round of fates is decided afresh", () => {
  // G takes c from H while H gets a table: H is stuck, so G can't take c either.
  const raw = deck(group("ggggg", box("aaaaa"), box("bbbbb")), group("hhhhh", box("ccccc"), box("ddddd"), box("eeeee")));
  const r = settle(raw, file('<group id="ggggg">', lines(raw, "bbbbb"), lines(raw, "aaaaa"), lines(raw, "ccccc"), "</group>", '<group id="hhhhh">', lines(raw, "ddddd"), lines(raw, "eeeee"), '<table x="1" y="1">', "<tr><td></td></tr>", "</table>", "</group>"));
  assert.deepEqual(now(raw), [{ggggg: ["aaaaa", "bbbbb"]}, {hhhhh: ["ccccc", "ddddd", "eeeee"]}]);
  assert.match(r.warnings.join(), /ggggg can't change/);
  assert.match(r.warnings.join(), /hhhhh can't change/);
});

test("groups: a group stuck inside a stuck parent stays stuck, whatever else is on the slide", () => {
  // P holds a table, so G (inside it) can't change; b's move still goes out.
  for (const extra of [[], [group("hhhhh", box("ccccc"), box("ddddd"))]]) {
    const raw = deck(group("ppppp", group("ggggg", box("aaaaa"), box("bbbbb")), table("ttttt")), ...extra);
    const L = text(raw).split("\n");
    const a = L.findIndex((l) => l.includes('id="aaaaa"'));
    [L[a], L[a + 1]] = [L[a + 1].replace('x="10"', 'x="99"'), L[a]];
    const p = plan(fromApi(structuredClone(raw)), parse(L.join("\n")));
    assert.ok(p.requests.some((q) => q.updatePageElementTransform?.objectId === "bbbbb"), JSON.stringify(p.requests));
    assert.match(p.warnings.join(), /ggggg is inside ppppp/);
  }
});

test("groups: deeply nested new groups plan quickly", {timeout: 10_000}, () => {
  const raw = deck(box("aaaaa"));
  const depth = 30;
  const t = file(...Array(depth).fill("<group>"), lines(raw, "aaaaa"), '<table x="1" y="1">', "<tr><td></td></tr>", "</table>", ...Array(depth).fill("</group>"));
  const start = performance.now();
  settle(raw, t);
  assert.ok(performance.now() - start < 2000, `${Math.round(performance.now() - start)}ms`);
});

test("new ids are valid and unused anywhere in the deck", () => {
  const raw: any = deck(box("aaaaa"), box("bbbbb"));
  raw.layouts = [{objectId: "p_lay", pageElements: [{objectId: "lay_title"}]}];
  const r = settle(raw, file('<group id="g1">', lines(raw, "aaaaa"), lines(raw, "bbbbb"), "</group>", '<shape id="lay_title" type="rectangle"></shape>', '<shape id="p_lay" type="ellipse"></shape>'));
  assert.equal(r.passes.length > 0, true);
  assert.equal(now(raw).length, 3);
});

test("a placeholder added to an existing slide says it's a plain shape", () => {
  const raw = deck(box("aaaaa"));
  const r = settle(raw, file(lines(raw, "aaaaa"), '<shape type="text-box" placeholder="title"></shape>'));
  assert.match(r.warnings.join(), /can only be added with a new <slide>/);
});

test("an <object> moved onto a new or pasted slide stays where it is", () => {
  const chart = {objectId: "chart", transform: box("x").transform, size: box("x").size, sheetsChart: {spreadsheetId: "s", chartId: 1}};
  for (const where of ["new", "pasted"]) {
    const raw: any = deck(box("aaaaa"), structuredClone(chart));
    raw.slides.push({objectId: "slide2", pageElements: [box("yyyyy")]});
    const t = text(raw);
    const line = lines(raw, "chart");
    const slide2 = /<slide id="slide2">[\s\S]*?<\/slide>\n/.exec(t)![0];
    const extra = where === "new" ? `<slide>\n${line}\n</slide>\n` : slide2.replace("</slide>", `${line}\n</slide>`);
    const r = settle(raw, t.replace(line + "\n", "") + "\n" + extra);
    assert.ok(JSON.stringify(raw.slides[0].pageElements).includes('"chart"'), where);
    assert.match(r.warnings.join(), /can't move an <object> \(chart\)/, where);
  }
});

test("an <object> pasted onto another slide while kept on its own says it isn't copied", () => {
  const raw: any = deck(box("aaaaa"), {objectId: "chart", transform: box("x").transform, size: box("x").size, sheetsChart: {spreadsheetId: "s", chartId: 1}});
  raw.slides.push({objectId: "slide2", pageElements: [box("bbbbb")]});
  const r = settle(raw, text(raw).replace(/(<shape id="bbbbb"[^\n]*)/, `$1\n${lines(raw, "chart")}`));
  assert.match(r.warnings.join(), /can't copy an <object> \(chart\)/);
});

test("a placeholder a new slide's layout lacks gets one warning", () => {
  const raw: any = deck(box("aaaaa"));
  raw.layouts = [{objectId: "lay1", layoutProperties: {name: "BLANK", displayName: "Blank"}, pageElements: []}];
  const r = settle(raw, text(raw) + '\n<slide layout="BLANK">\n<shape type="text-box" placeholder="title">\nHi\n</shape>\n<group>\n<shape type="text-box" placeholder="body"></shape>\n<shape type="rectangle"></shape>\n</group>\n</slide>\n');
  assert.match(r.warnings.join(), /has no title placeholder/);
  assert.match(r.warnings.join(), /can't go in a <group>/);
  assert.doesNotMatch(r.warnings.join(), /can only be added with a new <slide>/);
});

test("a group's alt text isn't sent, since Slides refuses it", () => {
  const raw = deck(group("ggggg", box("aaaaa"), box("bbbbb")));
  const p = plan(fromApi(structuredClone(raw)), parse(text(raw).replace('<group id="ggggg"', '<group id="ggggg" alt="bean life cycle"')));
  assert.ok(!p.requests.some((q) => q.updatePageElementAltText), JSON.stringify(p.requests));
  assert.match(p.warnings.join(), /can't set a <group>'s alt text/);
});
