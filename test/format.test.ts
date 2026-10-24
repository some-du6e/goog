import assert from "node:assert/strict";
import {test} from "node:test";
import {FormatError, parse, serialize} from "../src/format.ts";

const SAMPLE = `<!-- goog doc abc123 · "Bio HW" -->

<title align="center">Cellular Respiration</title>

Name: Karim
Answer every question in <b>complete <i>sentences</i></b>. Due <u>Friday</u>.
<p></p>

<h2>Part A</h2>

<li>Glycolysis: <mark>cytoplasm</mark></li>
<li level="2">Also the <mark color="#00ff00">citric acid cycle</mark></li>
<li type="1">ETC</li>

<table>
<tr><td><b>Stage</b></td><td>ATP</td></tr>
<tr><td><p>two</p><p>paras</p></td><td></td></tr>
</table>

<img id="kix.8f2" alt="diagram"> See <a href="https://x.test/?a=1&amp;b=2">notes</a>. 3 &lt; 5 &amp; ok<br>next line
`;

test("round trips", () => {
  const doc = parse(SAMPLE);
  assert.equal(serialize({...doc, name: "Bio HW"}), SAMPLE);
});

test("parses structure", () => {
  const doc = parse(SAMPLE);
  const kinds = doc.blocks.map((b) => (b.type === "para" ? b.style + (b.list ? `/li${b.list.level}${b.list.ordered ? "o" : ""}` : "") : b.type));
  assert.deepEqual(kinds, ["title", "p", "p", "p", "h2", "p/li0", "p/li1", "p/li0o", "table", "p"]);
  const last = doc.blocks.at(-1)!;
  assert.ok(last.type === "para");
  assert.equal(last.runs.length, 4);
});

test("multi-line table cells and agent-friendly errors", () => {
  const doc = parse(`<!-- goog doc x -->\n<table>\n  <tr>\n    <td>\n      hello\n    </td>\n  </tr>\n</table>\n`);
  assert.equal(serialize(doc), `<!-- goog doc x -->\n\n<table>\n<tr><td>hello</td></tr>\n</table>\n`);
  assert.throws(() => parse(`<!-- goog doc x -->\nhi <b>there\n`), /line 2: <b> is not closed/);
  assert.throws(() => parse(`<!-- goog doc x -->\n\n3 < 5\n`), (e: unknown) => e instanceof FormatError && e.line === 3);
  assert.throws(() => parse(`<!-- goog doc x -->\n<p>a\nb</p>\n`), /one line/);
  assert.throws(() => parse(`<!-- goog doc x -->\n<blink>a</blink>\n`), /unknown tag <blink>/);
  assert.throws(() => parse(`<<<<<<< yours\n`), /header/);
});

const H = `<!-- goog doc x -->\n\n`;
const roundTrip = (body: string) => serialize(parse(H + body)).slice(H.length);

test("paragraphs that only look blank keep their content", () => {
  const doc = parse(H + "x\n");
  const para = doc.blocks[0];
  assert.ok(para.type === "para");
  para.runs = [{text: " ", style: {b: true}}];
  const text = serialize(doc);
  assert.equal(text, H + "<p><b> </b></p>\n");
  assert.deepEqual(parse(text).blocks, doc.blocks);
  para.runs = [{text: "=======", style: {}}];
  assert.equal(serialize(doc), H + "&#61;======\n");
  assert.deepEqual(parse(serialize(doc)).blocks, doc.blocks);
});

test("invisible characters are written as entities and read back", () => {
  const doc = parse(H + "a&nbsp;b&#x200b;c‍d\n");
  const p = doc.blocks[0];
  assert.ok(p.type === "para" && "text" in p.runs[0]);
  assert.equal(p.runs[0].text, "a b​c‍d");
  assert.equal(serialize(doc), H + "a&nbsp;b&#x200b;c‍d\n");
});

test("a numeric entity past the last code point is kept as written", () => {
  const doc = parse(H + "a&#x110000;b\n");
  const p = doc.blocks[0];
  assert.ok(p.type === "para" && "text" in p.runs[0]);
  assert.equal(p.runs[0].text, "a&#x110000;b");
});

test("list types: numbers are ordered, bullets and checklists aren't", () => {
  const doc = parse(H + `<li type="a">x</li>\n<li type="disc">x</li>\n<li type="check" start="1">x</li>\n<li type="★">x</li>\n<li type="1" start="4">x</li>\n`);
  const lists = doc.blocks.map((b) => (b.type === "para" ? b.list : undefined));
  assert.deepEqual(lists, [
    {ordered: true, level: 0, glyph: "a"},
    {ordered: false, level: 0},
    {ordered: false, level: 0, glyph: "check", start: 1},
    {ordered: false, level: 0, glyph: "★"},
    {ordered: true, level: 0, glyph: "1", start: 4},
  ]);
  assert.equal(roundTrip(`<li type="disc">x</li>\n`), `<li>x</li>\n`);
});

test("paragraph attributes", () => {
  assert.equal(roundTrip(`<p indent="36" first="36">a</p>\n<p dir="rtl" align="right">b</p>\n<h2 id="h.1">c</h2>\n<p float="kix.a kix.b">d</p>\n`),
    `<p indent="36">a</p>\n<p align="right" dir="rtl">b</p>\n\n<h2 id="h.1">c</h2>\n\n<p float="kix.a kix.b">d</p>\n`);
  assert.throws(() => parse(H + `<p dir="up">a</p>\n`), /dir must be rtl or ltr/);
  assert.throws(() => parse(H + `<span weight="450">a</span>\n`), /weight must be/);
  assert.equal(roundTrip(`<span weight="400" smallcaps>a</span><ins>b</ins><del>c</del>\n`), `<span smallcaps>a</span><ins>b</ins><del>c</del>\n`);
});

test("merged cells: covered cells are implied, the grid stays full", () => {
  const src = `<table>\n<tr><td colspan="2">a</td><td rowspan="2">b</td></tr>\n<tr><td>c</td><td>d</td></tr>\n</table>\n`;
  const doc = parse(H + src);
  const t = doc.blocks.find((b) => b.type === "table");
  assert.ok(t?.type === "table");
  assert.deepEqual(t.rows.map((r) => r.length), [3, 3]);
  assert.deepEqual(t.cells, [[{colspan: 2}, {covered: true}, {rowspan: 2}], [undefined, undefined, {covered: true}]]);
  assert.equal(roundTrip(src), src);
  assert.throws(() => parse(H + `<table>\n<tr><td colspan="2">a</td></tr>\n<tr><td>b</td></tr>\n</table>\n`), /row 2 has 1 cells, row 1 has 2/);
  assert.throws(() => parse(H + `<table>\n<tr><td rowspan="2">a</td></tr>\n</table>\n`), /rowspan runs past/);
  assert.throws(() => parse(H + `<table>\n<tr><td bg="nope">a</td></tr>\n</table>\n`), /bad color/);
});

test("implied paragraphs around tables are left out and come back on parse", () => {
  const doc = parse(H + `<table>\n<tr><td>a</td></tr>\n</table>\n<table>\n<tr><td>b</td></tr>\n</table>\n`);
  assert.deepEqual(doc.blocks.map((b) => b.type), ["para", "table", "para", "table", "para"]);
  assert.equal(serialize(doc), H + `<table>\n<tr><td>a</td></tr>\n</table>\n\n<table>\n<tr><td>b</td></tr>\n</table>\n`);
  assert.deepEqual(parse(H).blocks, [{type: "para", style: "p", runs: []}]);
  assert.equal(serialize(parse(H)), H);
});

test("tabs and segments", () => {
  const src = `<tab id="t.0" title="One">\n\nhello\n\n<header id="kix.h">\nHead\n</header>\n\n<footnote-text id="kix.f">\nnote\n</footnote-text>\n\n<tab id="t.1" title="Two" parent="t.0">\n\nworld\n`;
  const doc = parse(H + src);
  assert.equal(doc.tabs?.length, 2);
  assert.equal(doc.blocks, doc.tabs![0].blocks);
  assert.deepEqual(doc.segments?.map((s) => [s.kind, s.id]), [["header", "kix.h"], ["footnote", "kix.f"]]);
  assert.equal(doc.tabs![1].parent, "t.0");
  assert.equal(roundTrip(src), src);
  assert.throws(() => parse(H + `stray\n<tab id="t.0" title="x">\n`), /before the first <tab>/);
  assert.throws(() => parse(H + `<tab title="x">\n`), /<tab> needs an id/);
  assert.throws(() => parse(H + `<footer>\nx\n</footer>\n`), /needs the id/);
  assert.throws(() => parse(H + `<table>\n<tr><td><header id="h">x</header></td></tr>\n</table>\n`), /top level/);
});

test("older files still parse", () => {
  const doc = parse(H + `<object kind="section-break" id="section">\n<li type="1">x</li>\n`);
  assert.deepEqual(doc.blocks[0], {type: "opaque", kind: "section-break", key: "section"});
  assert.equal(serialize(doc), H + `<object kind="section-break">\n<li type="1">x</li>\n`);
});
