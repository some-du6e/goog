// The Slides format, its geometry, and the planner, offline against a real
// deck's API response (test/fixtures/slides-hdi.json).

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {FormatError} from "../src/format.ts";
import {parse, serialize} from "../src/slides-format.ts";
import {plan} from "../src/slides-plan.ts";
import {EMU_PER_PT, affineFor, fromApi, geomOf, lineAffine, lineEnds} from "../src/slides-read.ts";

const raw = JSON.parse(readFileSync(new URL("./fixtures/slides-hdi.json", import.meta.url), "utf8"));
const remote = () => fromApi(structuredClone(raw));
const text = () => serialize(remote().deck);
const planFor = (edit: (s: string) => string) => plan(remote(), parse(edit(text())));
const kinds = (reqs: any[]) => reqs.map((r) => Object.keys(r)[0]);

test("slides: serialize is a fixed point and an unchanged deck plans nothing", () => {
  const s = text();
  assert.equal(serialize(parse(s)), s);
  assert.deepEqual(plan(remote(), parse(s)).requests, []);
});

test("slides: what a deck reads as", () => {
  const s = text();
  assert.match(s, /^<!-- goog slides \S+ · "HDI Practice" -->\n<!-- layouts for new slides: title \(Title slide\), section-header, title-and-body/);
  // The style shared by a shape's runs goes on its tag.
  assert.match(s, /<shape id="g1f7d8d64ee0_1_22" type="text-box" x="59.2" y="143.98" w="142.46" h="28.87" font="Playfair Display" size="18" color="dark2">\n<p align="center">64th<\/p>\n<\/shape>/);
  assert.match(s, /<line id="h280c39f37343028d_1_126" x1="216.93" y1="237.22" x2="394.33" y2="111.13" arrow="end">/);
  assert.match(s, /rot="-90"/);
  assert.match(s, /<tr><td bg="#ead1dc">GDP Per Capita<\/td><\/tr>/);
  assert.match(s, /<video id="g1f7d8d64ee0_1_67" [^>]*youtube="w5wORaWcWPY"/);
  assert.match(s, /<notes>\n<p>All stand up/);
});

test("slides: geometry survives the trip through a transform", () => {
  const W = 3000000;
  const H = 3000000;
  for (const g of [
    {x: 10, y: 20, w: 300, h: 40},
    {x: -141.4, y: 206.91, w: 335.62, h: 38.76, rot: -90},
    {x: 5, y: 6, w: 70, h: 80, rot: 33, flip: "h" as const},
    {x: 5, y: 6, w: 70, h: 80, flip: "v" as const},
  ]) {
    const back = geomOf(affineFor(g, W, H), W, H);
    for (const k of ["x", "y", "w", "h", "rot"] as const) assert.ok(Math.abs((back[k] ?? 0) - ((g as any)[k] ?? 0)) < 1e-6, `${k} of ${JSON.stringify(g)}: ${JSON.stringify(back)}`);
    assert.equal(back.flip, (g as any).flip);
  }
  const ends = lineEnds(lineAffine(217, 155, 391, 58, W, 0), W, 0);
  for (const [k, v] of Object.entries({x1: 217, y1: 155, x2: 391, y2: 58})) assert.ok(Math.abs((ends as any)[k] - v) < 1e-6, k);
});

test("slides: editing a word replaces just that word", () => {
  const p = planFor((s) => s.replace("<p align=\"center\">64th</p>", "<p align=\"center\">64th place</p>"));
  assert.deepEqual(p.requests, [{insertText: {objectId: "g1f7d8d64ee0_1_22", insertionIndex: 4, text: " place"}}]);
});

test("slides: styles, alignment and bullets are planned once the text matches", () => {
  const p = planFor((s) => s.replace("<p align=\"center\">64th</p>", "<p><b>64th</b></p>"));
  assert.deepEqual(kinds(p.requests), ["updateTextStyle", "updateParagraphStyle"]);
  assert.equal(p.requests[0].updateTextStyle.fields, "bold");
  assert.deepEqual(p.requests[0].updateTextStyle.textRange, {type: "FIXED_RANGE", startIndex: 0, endIndex: 4});
  assert.equal(p.requests[1].updateParagraphStyle.style.alignment, "START");
  const b = planFor((s) => s.replace("<p align=\"center\">75th</p>", "<li level=\"2\" align=\"center\">75th</li>"));
  assert.deepEqual(kinds(b.requests), ["insertText", "createParagraphBullets"]);
  assert.equal(b.requests[0].insertText.text, "\t");
});

test("slides: moving things, a line's ends, fills and table cells", () => {
  const p = planFor((s) => s
    .replace(/<line id="h280c39f37343028d_1_126"[^>]*>/, '<line id="h280c39f37343028d_1_126" x1="217" y1="238" x2="391" y2="99" arrow="end">')
    .replace('x="59.2" y="143.98" w="142.46" h="28.87"', 'x="100" y="143.98" w="142.46" h="28.87"')
    .replace('fill="#073763" font="Playfair Display" size="24" color="light1">\n<p align="center">Higher', 'fill="accent1" font="Playfair Display" size="24" color="light1">\n<p align="center">Higher')
    .replace("LIfe Expectancy", "Life Expectancy"));
  assert.deepEqual(kinds(p.requests).sort(), ["deleteText", "insertText", "updatePageElementTransform", "updatePageElementTransform", "updateShapeProperties"].sort());
  const line = p.requests.find((r) => r.updatePageElementTransform?.objectId === "h280c39f37343028d_1_126").updatePageElementTransform;
  const t = line.transform;
  const W = 3000000;
  assert.ok(Math.abs((t.scaleX * W + t.shearX * W + t.translateX) / EMU_PER_PT - 391) < 1e-6);
  assert.ok(Math.abs((t.shearY * W + t.scaleY * W + t.translateY) / EMU_PER_PT - 99) < 1e-6);
  assert.deepEqual(p.requests.find((r) => r.updateShapeProperties).updateShapeProperties.shapeProperties.shapeBackgroundFill.solidFill.color, {themeColor: "ACCENT1"});
  const cell = p.requests.find((r) => r.deleteText).deleteText;
  assert.deepEqual(cell.cellLocation, {rowIndex: 3, columnIndex: 0});
  // Within Slides' rounding of a transform is already there.
  const q = planFor((s) => s.replace('x="59.2" y="143.98"', 'x="59.21" y="143.99"'));
  assert.deepEqual(q.requests, []);
  // A turn more or less is the same rotation (Slides reads rot="270" back as -90).
  assert.deepEqual(planFor((s) => s.replace('rot="-90" fill="#fff2cc"', 'rot="270" fill="#fff2cc"')).requests, []);
});

test("slides: outlines", () => {
  const off = planFor((s) => s.replace('fill="#fff2cc" outline="#000000" outline-width="1.5"', 'fill="#fff2cc"'));
  assert.deepEqual(off.requests, [{updateShapeProperties: {objectId: "g1f7d8d64ee0_1_65", shapeProperties: {outline: {propertyState: "NOT_RENDERED"}}, fields: "outline.propertyState"}}]);
  const on = planFor((s) => s.replace('x="59.2" y="143.98" w="142.46" h="28.87"', 'x="59.2" y="143.98" w="142.46" h="28.87" outline="accent1" outline-width="3"'));
  const o = on.requests[0].updateShapeProperties.shapeProperties.outline;
  assert.deepEqual(o, {propertyState: "RENDERED", outlineFill: {solidFill: {color: {themeColor: "ACCENT1"}, alpha: 1}}, weight: {magnitude: 3, unit: "PT"}});
  assert.throws(() => parse(text().replace('outline="#000000" outline-width="1.5"', 'outline-width="1.5"')), /needs an outline color/);
});

test("slides: adding, copying, deleting and reordering", () => {
  const add = planFor((s) => s.replace("</slide>", '<shape type="ellipse" x="10" y="10" w="50" h="50" fill="red">\n<p>new</p>\n</shape>\n</slide>'));
  assert.deepEqual(kinds(add.requests), ["createShape", "insertText"]);
  assert.equal(add.requests[0].createShape.shapeType, "ELLIPSE");
  assert.equal(add.requests[1].insertText.text, "new");

  const s = text();
  const block = /<slide id="h280c39f37343028d_1_133".*?<\/slide>\n/s.exec(s)![0];
  const dup = plan(remote(), parse(s.replace(block, block + "\n" + block)));
  assert.deepEqual(kinds(dup.requests), ["duplicateObject"]);
  const d = dup.requests[0].duplicateObject;
  assert.equal(d.objectId, "h280c39f37343028d_1_133");
  assert.ok(Object.hasOwn(d.objectIds, "h280c39f37343028d_1_143"), "the slide's image gets a chosen id");

  const del = planFor((t) => t.replace(/<image id="h4874a086f7bb33c0_1_1"[^>]*>\n/, "").replace(block, ""));
  assert.deepEqual(kinds(del.requests).sort(), ["deleteObject", "deleteObject"]);

  const moved = plan(remote(), parse(s.replace(block, "") + "\n" + block));
  assert.deepEqual(moved.requests, [{updateSlidesPosition: {slideObjectIds: ["h280c39f37343028d_1_133"], insertionIndex: 9}}]);

  const fresh = planFor((t) => t + '\n<slide layout="title-and-body">\n<shape placeholder="title"><p>Exit ticket</p></shape>\n</slide>\n');
  assert.deepEqual(kinds(fresh.requests), ["createSlide"]);
  const cs = fresh.requests[0].createSlide;
  assert.equal(cs.slideLayoutReference.layoutId, "g58a6f24344_0_14");
  assert.deepEqual(cs.placeholderIdMappings[0].layoutPlaceholder, {type: "TITLE", index: 0});
});

test("slides: removing several table rows deletes them back to front", () => {
  const rows = (reqs: any[]) => reqs.filter((r) => r.deleteTableRow).map((r) => r.deleteTableRow.cellLocation.rowIndex);
  const drop = (...names: string[]) => (s: string) => names.reduce((t, n) => t.replace(new RegExp(`<tr><td bg="#ead1dc">${n}</td></tr>\\n`), ""), s);
  // Only the first table (h280c39f37343028d_1_122) has these rows first.
  const last = planFor(drop("Poverty Rate", "Infant Mortality Rate")).requests;
  assert.deepEqual(rows(last), [7, 6]);
  const first = planFor(drop("GDP Per Capita", "Gender Gap Index", "Literacy Rate")).requests;
  assert.deepEqual(rows(first), [2, 1, 0]);
  const both = planFor(drop("GDP Per Capita", "Gender Gap Index", "Poverty Rate", "Infant Mortality Rate")).requests;
  assert.deepEqual(rows(both), [7, 6, 1, 0]);
});

test("slides: dropping a group but keeping its children ungroups it", () => {
  const r = structuredClone(raw);
  const slide = r.slides[1];
  const [a, b, ...rest] = slide.pageElements;
  slide.pageElements = [{objectId: "grp_test", size: a.size, transform: {scaleX: 1, scaleY: 1, unit: "EMU"}, elementGroup: {children: [a, b]}}, ...rest];
  const s = serialize(fromApi(structuredClone(r)).deck);
  assert.match(s, /<group id="grp_test"/);
  const unwrap = s.replace(/<group id="grp_test"[^\n]*\n/, "").replace(/<\/group>\n/, "");
  const p = plan(fromApi(structuredClone(r)), parse(unwrap)).requests;
  assert.deepEqual(p, [{ungroupObjects: {objectIds: ["grp_test"]}}]);
  // Dropping the whole group still deletes it, children and all.
  const gone = s.replace(/<group id="grp_test"[\s\S]*?<\/group>\n/, "");
  assert.deepEqual(plan(fromApi(structuredClone(r)), parse(gone)).requests, [{deleteObject: {objectId: "grp_test"}}]);
});

test("slides: format errors point at the problem", () => {
  const s = text();
  assert.throws(() => parse(s.replace("<p align=\"center\">64th</p>\n</shape>", "<p align=\"center\">64th</p>")), (e: any) => e instanceof FormatError && /<shape> on line \d+ is not closed before the <shape>/.test(e.message));
  assert.throws(() => parse(s.replace("<slide id=\"p\"", "stray words\n<slide id=\"p\"")), /isn't inside anything/);
  assert.throws(() => parse(s.replace("<p align=\"center\">64th</p>", "<h1>64th</h1>")), /no <h1>/);
  assert.throws(() => parse(s.replace('fill="#073763"', 'fill="blurple"')), /theme color/);
});
