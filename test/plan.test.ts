import assert from "node:assert/strict";
import {test} from "node:test";
import {parse, serialize} from "../src/format.ts";
import {fromApi} from "../src/gdocs-read.ts";
import {normalizeTarget, plan} from "../src/gdocs-plan.ts";
import {readFileSync, readdirSync} from "node:fs";
import {pushDoc, toRemote, type DocsIO} from "../src/gdocs.ts";
import {ApiError} from "../src/google.ts";
import type {Block} from "../src/model.ts";
import {SCENARIOS} from "./plan-scenarios.ts";
import {SimDoc} from "./sim.ts";

const HEAD = "<!-- goog doc sim -->\n";
const body = (s: string) => s.slice(s.indexOf("\n") + 1).trim();

// Docs' filler paragraphs made explicit and image ids masked, so files that
// mean the same doc compare equal.
function canonBlocks(blocks: Block[]): Block[] {
  return normalizeTarget(blocks).map((b) => (b.type === "table" ? {...b, rows: b.rows.map((r) => r.map(canonBlocks))} : b));
}
function canon(text: string): string {
  const d = parse(HEAD + text);
  d.blocks = canonBlocks(d.blocks);
  return body(serialize(d)).replace(/<img [^>]*>/g, "<img>").replace(/ start="1"/g, "");
}

function io(sim: SimDoc): DocsIO & {batches: any[][]} {
  const batches: any[][] = [];
  return {
    batches,
    get: async () => sim.toApi(),
    batch: async (_id, b) => {
      if (b.writeControl?.requiredRevisionId && b.writeControl.requiredRevisionId !== `r${sim.rev}`) {
        throw new ApiError(400, "The required revision ID does not match the latest revision.");
      }
      batches.push(b.requests);
      const replies = sim.apply(b.requests);
      return {replies, writeControl: {requiredRevisionId: `r${sim.rev}`}};
    },
  };
}

async function push(sim: SimDoc, target: string) {
  const x = io(sim);
  const r = await pushDoc("sim", parse(HEAD + target), {io: x});
  return {...r, out: body(serialize(fromApi(sim.toApi()).doc)), batches: x.batches};
}

const pulled = (sim: SimDoc) => body(serialize(fromApi(sim.toApi()).doc));

// ---------- the live scenarios, against the simulator ----------

for (const sc of SCENARIOS) {
  if (sc.setup || sc.between || sc.expectError) continue;
  test(`sim: ${sc.name}`, async () => {
    let sim: SimDoc;
    try {
      sim = SimDoc.from(sc.start);
    } catch (e: any) {
      if (/sim can't build/.test(e.message)) return; // hr, footnotes, …
      throw e;
    }
    assert.equal(canon(pulled(sim)), canon(sc.start), "sim built the start doc wrong");
    const target = typeof sc.edit === "string" ? sc.edit : sc.edit(pulled(sim));
    const r = await push(sim, target);
    if (r.warnings.some((w) => /can't create <(hr|footnote)/.test(w))) return;
    assert.equal(canon(r.out), canon(typeof sc.expect === "function" ? sc.expect(pulled(sim)) : sc.expect ?? target));
    assert.ok(!r.warnings.some((w) => /stopped after|some changes can't be made/.test(w)), r.warnings.join("\n"));
  });
}

// ---------- regressions ----------

test("untouched fixture docs (tabs, segments, lists, merged cells, chips) plan nothing", () => {
  const dir = new URL("./fixtures/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json") && !x.startsWith("slides-"))) {
    const remote = toRemote(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
    const p = plan(remote, parse(serialize(remote.doc)));
    assert.equal(p.requests.length, 0, `${f}: ${JSON.stringify(p.requests).slice(0, 300)}`);
    assert.deepEqual(p.warnings, [], f);
  }
});

test("small edits send few requests, in one pass", async () => {
  const sim = SimDoc.from("<h1>Title</h1>\nSome <b>bold</b> words here.\nlast");
  const r = await push(sim, "<h1>Title</h1>\nSome <b>very bold</b> words here.\nlast");
  assert.equal(r.passes, 1);
  // The insert inherits bold; the one restyle is for the new text only.
  assert.deepEqual(r.batches[0].map((q) => Object.keys(q)[0]), ["insertText", "updateTextStyle"]);
});

test("rewriting a paragraph to unrelated text is one delete and one insert, not letter-by-letter edits", async () => {
  const sim = SimDoc.from("Paragraph 523: the quick brown fox jumps over the lazy dog.\nkeep");
  const r = await push(sim, "Totally new line 523\nkeep");
  assert.equal(r.out, "Totally new line 523\nkeep");
  assert.ok(r.requests <= 4, `${r.requests} requests: ${JSON.stringify(r.batches)}`);
});

test("removing a link styles from the link's start (Docs ignores unlinks that start on plain text)", async () => {
  const sim = SimDoc.from(`go to <a href="https://example.com">site</a> now`);
  const r = await push(sim, "go to site now");
  assert.equal(r.out, "go to site now");
  assert.equal(r.passes, 1);
});

test("new <img src> gets its id from the reply and converges", async () => {
  const sim = SimDoc.from("one two");
  const r = await push(sim, `one <img src="https://example.com/a.png"> two`);
  assert.match(r.out, /^one <img id="kix\.sim\d+"> two$/);
  assert.equal(r.passes, 1);
});

test("moving an image copies it and deletes the original", async () => {
  const sim = SimDoc.from(`pic <img src="https://example.com/a.png"> here\nother`);
  const start = pulled(sim);
  const img = /<img [^>]+>/.exec(start)![0];
  const r = await push(sim, start.replace(` ${img}`, "").replace("other", `other ${img}`));
  assert.match(r.out, /^pic here\nother <img id="kix\.sim\d+">$/);
  assert.notEqual(/<img [^>]+>/.exec(r.out)![0], img);
  assert.ok(r.warnings.some((w) => /copied/.test(w)));
});

test("a new table at the very start keeps Docs' paragraph before it, and fills in one pass", async () => {
  const sim = SimDoc.from("<h1>Head</h1>\ntext");
  const r = await push(sim, "<table>\n<tr><td>x</td><td><b>y</b></td></tr>\n</table>\n<h1>Head</h1>\ntext");
  assert.equal(canon(r.out), canon("<table>\n<tr><td>x</td><td><b>y</b></td></tr>\n</table>\n<h1>Head</h1>\ntext"));
  assert.ok(r.passes <= 2, `passes ${r.passes}`);
});

test("inserting a table between paragraphs takes one pass", async () => {
  const sim = SimDoc.from("a\nb");
  const r = await push(sim, "a\n<table>\n<tr><td>1</td><td>2</td></tr>\n<tr><td>3</td><td>4</td></tr>\n</table>\nb");
  assert.equal(r.passes, 1);
});

test("deleting the last paragraph doesn't leave its heading style on the one before", async () => {
  const sim = SimDoc.from("Para\n<h2>End</h2>");
  const r = await push(sim, "Para");
  assert.equal(r.out, "Para");
  assert.equal(r.passes, 1);
});

test("deleting a trailing list item doesn't turn the previous paragraph into one", async () => {
  const sim = SimDoc.from("Intro\n<li>a</li>");
  const r = await push(sim, "Intro");
  assert.equal(r.out, "Intro");
  assert.equal(r.passes, 1);
});

test("a paragraph inserted after a heading or bullet doesn't inherit it", async () => {
  for (const [start, want] of [
    ["<h1>H</h1>\nbody", "<h1>H</h1>\nnew\nbody"],
    ["<li>a</li>\nafter", "<li>a</li>\nplain\nafter"],
    ["<li>a</li>", "<li>a</li>\nplain"],
  ]) {
    const sim = SimDoc.from(start);
    const r = await push(sim, want);
    assert.equal(canon(r.out), canon(want));
  }
});

test("inserting before an edited paragraph edits it in place instead of recreating it", async () => {
  const sim = SimDoc.from(`first <img src="https://example.com/a.png"> para`);
  const start = pulled(sim);
  const r = await push(sim, "brand new\n" + start.replace("para", "para, edited"));
  assert.equal(r.out, "brand new\n" + start.replace("para", "para, edited"));
  assert.ok(!r.batches.flat().some((q) => q.insertInlineImage), "the image was recreated");
});

test("adding a column on the left inserts one column, not a rewrite", async () => {
  const sim = SimDoc.from("<table>\n<tr><td>a</td><td>b</td></tr>\n<tr><td>c</td><td>d</td></tr>\n</table>");
  const r = await push(sim, "<table>\n<tr><td>z</td><td>a</td><td>b</td></tr>\n<tr><td>z</td><td>c</td><td>d</td></tr>\n</table>");
  assert.equal(canon(r.out), canon("<table>\n<tr><td>z</td><td>a</td><td>b</td></tr>\n<tr><td>z</td><td>c</td><td>d</td></tr>\n</table>"));
  assert.ok(!r.batches.flat().some((q) => q.deleteContentRange), "cells were rewritten");
  assert.deepEqual(r.batches[0].map((q) => Object.keys(q)[0]), ["insertTableColumn"]);
});

test("adding a row and a column at once is one reshape pass", async () => {
  const sim = SimDoc.from("<table>\n<tr><td>a</td><td>b</td></tr>\n</table>");
  const want = "<table>\n<tr><td>a</td><td>b</td><td>c</td></tr>\n<tr><td>d</td><td>e</td><td>f</td></tr>\n</table>";
  const r = await push(sim, want);
  assert.equal(canon(r.out), canon(want));
  assert.equal(r.passes, 2);
});

test("page break mid-paragraph takes one pass", async () => {
  const sim = SimDoc.from("Third and last.");
  const r = await push(sim, "Third<pagebreak> and last.");
  assert.equal(r.out, "Third<pagebreak> and last.");
  assert.equal(r.passes, 1);
});

test("moving a paragraph that's only an uncopyable object leaves it in place, without a stray empty paragraph", async () => {
  const sim = SimDoc.from("a\nb\nc");
  // A chip the sim can't build: splice one into the API JSON instead.
  const api = sim.toApi();
  const remote = toRemote(api);
  const para = remote.body[0] as any;
  para.block.runs = [{atom: {kind: "chip", key: "kix.chip", attrs: {type: "dropdown", id: "kix.chip"}, len: 1}, style: {}}];
  const p = plan(remote, parse(HEAD + "b\nc\n" + `<chip type="dropdown" id="kix.chip">`));
  assert.ok(p.warnings.some((w) => /can't move <chip/.test(w)), p.warnings.join("\n"));
  assert.ok(!p.requests.some((q) => q.insertText?.text?.includes("\n")), JSON.stringify(p.requests));
});

test("when a move can't happen, the list pass still lines paragraphs up by content", () => {
  const sim = SimDoc.from(`<h1>T</h1>\nhello\n<li>first</li>\n<li level="2">nested</li>\nx`);
  const remote = toRemote(sim.toApi());
  (remote.body.at(-1) as any).block.runs = [{atom: {kind: "chip", key: "kix.chip", attrs: {type: "dropdown", id: "kix.chip"}, len: 1}, style: {}}];
  const target = parse(HEAD + `<h1>T</h1>\n<chip type="dropdown" id="kix.chip">\nhello\n<li>first</li>\n<li level="2">nested</li>`);
  const p = plan(remote, target);
  assert.equal(p.pass, "done", JSON.stringify(p.requests));
});

test("objects that can't be created are skipped with a warning, without breaking the rest", async () => {
  const sim = SimDoc.from("Third last.");
  const r = await push(sim, "Third <hr> <b>last</b>.");
  assert.equal(r.out, "Third  <b>last</b>.");
  assert.ok(r.warnings.some((w) => /can't create <hr>/.test(w)));
  assert.ok(!r.warnings.some((w) => /some changes can't be made/.test(w)));
});

test("new chips are created, get the doc's ids, and converge", async () => {
  const sim = SimDoc.from("Meet then.");
  const r = await push(sim, `Meet <chip type="person" email="ana@example.com"> on <chip type="date" date="2026-12-25">, see <chip type="link" href="https://docs.google.com/document/d/abc/edit"> then.`);
  assert.match(r.out, /^Meet <chip type="person" id="kix\.sim\d+" name="ana" email="ana@example.com"> on <chip type="date" id="kix\.sim\d+" text="2026-12-25" date="2026-12-25T00:00:00Z">, see <chip type="link" id="kix\.sim\d+" title="Sim file" href="https:\/\/docs.google.com\/document\/d\/abc\/edit"> then\.$/);
  assert.ok(!r.warnings.length, r.warnings.join("\n"));
  assert.equal(r.passes, 1);
});

test("dropdowns: a new one with options, one reusing those options, and a value change", async () => {
  const sim = SimDoc.from("a\nb");
  let r = await push(sim, `a <chip type="dropdown" value="High" options="Low|Medium|High">\nb`);
  assert.match(r.out, /^a <chip type="dropdown" id="kix\.sim\d+" value="High">\nb$/);
  assert.equal(Object.keys(sim.dropdownDefinitions).length, 1);
  // Copying a dropdown without its id reuses its definition.
  r = await push(sim, r.out.replace("\nb", `\nb <chip type="dropdown" value="Low">`));
  assert.equal(Object.keys(sim.dropdownDefinitions).length, 1);
  assert.match(r.out, /\nb <chip type="dropdown" id="kix\.sim\d+" value="Low">$/);
  const id = /id="(kix\.sim\d+)" value="High"/.exec(r.out)![1];
  r = await push(sim, r.out.replace(`value="High"`, `value="Medium"`));
  assert.ok(r.out.includes(`id="${id}" value="Medium"`), r.out);
  assert.deepEqual(r.batches.flat().map((q) => Object.keys(q)[0]), ["updateDropdownProperties"]);
  r = await push(sim, r.out.replace(`value="Medium"`, `value="Huge"`));
  assert.ok(r.warnings.some((w) => /has no option "Huge"; its options are Low, Medium, High/.test(w)), r.warnings.join("\n"));
});

test("editing a date chip's date replaces the chip", async () => {
  const sim = SimDoc.from("x");
  let r = await push(sim, `x <chip type="date" date="2026-12-25">`);
  r = await push(sim, r.out.replace(`date="2026-12-25T00:00:00Z"`, `date="2027-01-01"`));
  assert.match(r.out, /^x <chip type="date" id="kix\.sim\d+" text="2027-01-01" date="2027-01-01T00:00:00Z">$/);
  assert.ok(!r.warnings.length, r.warnings.join("\n"));
});

test("new chips missing what they're made from warn instead of failing", () => {
  const remote = toRemote(SimDoc.from("x").toApi());
  const p = plan(remote, parse(HEAD + `x <chip type="person"> <chip type="date" date="soon"> <chip type="dropdown" value="Zed">`));
  for (const w of [/needs email=/, /can't read the date "soon"/, /no dropdown in the doc has the option "Zed"/]) assert.ok(p.warnings.some((x) => w.test(x)), p.warnings.join("\n"));
});

test("a new <footnote> is created, and its text lands in the footnote once the id is known", () => {
  const remote = toRemote(SimDoc.from("Claim.").toApi());
  const target = parse(HEAD + `Claim<footnote text="Source: me">.`);
  const p = plan(remote, target);
  const req = p.requests.find((q) => q.createFootnote);
  assert.deepEqual(req, {createFootnote: {location: {index: 6}}});
  p.created.find((c) => c.req === req)!.apply({createFootnote: {footnoteId: "kix.fn1"}});
  assert.deepEqual(target.segments, [{kind: "footnote", id: "kix.fn1", blocks: [{type: "para", style: "p", runs: [{text: "Source: me", style: {}}]}]}]);
  assert.ok(serialize(target).includes(`Claim<footnote id="kix.fn1">.`));
});

test("checklist ticks the file changes can't be pushed, so they warn", () => {
  const remote = toRemote(SimDoc.from(`<li type="check">a</li>\n<li type="check">b</li>`).toApi());
  remote.doc.blocks.forEach((b, k) => k === 0 && b.type === "para" && (b.list!.checked = true));
  const p = plan(remote, parse(HEAD + `<li type="check">a</li>\n<li type="check" checked>b</li>`));
  assert.equal(p.pass, "done");
  assert.ok(p.warnings.some((w) => /ticking or unticking/.test(w)), p.warnings.join("\n"));
});

test("adding an item next to one at the same level keeps the list (no rebuild)", async () => {
  const listIds = (sim: SimDoc) => sim.toApi().body.content.filter((e: any) => e.paragraph?.bullet).map((e: any) => e.paragraph.bullet.listId);
  for (const [start, want] of [
    [`<li>a</li>\n<li level="2">b</li>\n<li type="1" start="1">n</li>`, `<li>a</li>\n<li level="2">b</li>\n<li level="2">b2</li>\n<li type="1" start="1">n</li>`],
    [`<li>a</li>\n<li>b</li>\nafter`, `<li>a</li>\n<li>b</li>\n<li>c</li>\nafter`],
    [`<li>a</li>\n<li>b</li>\nnot yet`, `<li>a</li>\n<li>b</li>\n<li>not yet</li>`],
  ]) {
    const sim = SimDoc.from(start);
    const before = listIds(sim)[0];
    const r = await push(sim, want);
    assert.equal(canon(r.out), canon(want));
    assert.equal(listIds(sim)[0], before, `list was rebuilt for ${want}`);
  }
});

test("level changes rebuild the list (joining a list ignores nesting tabs) and converge", async () => {
  for (const [start, want] of [
    [`<li>a</li>\n<li>b</li>\n<li>c</li>`, `<li>a</li>\n<li level="2">b</li>\n<li>c</li>`],
    [`<li>a</li>\n<li>b</li>`, `<li>a</li>\n<li>b</li>\n<li level="3">deep</li>`],
    [`<li>a</li>\n<li level="2">b</li>`, `<li>a</li>\n<li>b</li>`],
  ]) {
    const r = await push(SimDoc.from(start), want);
    assert.equal(canon(r.out), canon(want));
    assert.ok(!r.warnings.some((w) => /some changes|stopped/.test(w)), r.warnings.join("\n"));
  }
});

test("custom-glyph lists that already match aren't rebuilt", () => {
  const sim = SimDoc.from(`<li type="★">a</li>\n<li type="★">b</li>`);
  const remote = fromApi(sim.toApi());
  const p = plan(remote, parse(HEAD + pulled(sim)));
  assert.equal(p.pass, "done");
});

test("unreachable list glyphs warn once instead of looping", async () => {
  const sim = SimDoc.from("x");
  const r = await push(sim, `<li type="1">one</li>\n<li level="2" type="I">nested</li>`);
  assert.ok(r.warnings.some((w) => /type="I"/.test(w)), r.warnings.join("\n"));
  assert.ok(!r.warnings.some((w) => /some changes can't be made|stopped/.test(w)), r.warnings.join("\n"));
});

test("a doc edit between write and re-read stops the push", async () => {
  const sim = SimDoc.from("a\nb");
  const x = io(sim);
  const sneaky: DocsIO = {
    get: x.get,
    batch: async (id, b) => {
      const res = await x.batch(id, b);
      sim.apply([{insertText: {location: {index: 1}, text: "Z"}}]);
      return res;
    },
  };
  await assert.rejects(pushDoc("sim", parse(HEAD + "a\nb\n<li>c</li>"), {io: sneaky}), /required revision/);
});

test("a ticked checklist item doesn't warn on the passes after the first", async () => {
  const sim = SimDoc.from('<li type="check">task</li>\nold');
  const first = toRemote(sim.toApi());
  for (const b of first.doc.blocks) if (b.type === "para" && b.list) b.list.checked = true; // as markChecked would
  const r = await pushDoc("sim", parse(HEAD + '<li type="check" checked>task</li>\nnew'), {io: io(sim), first});
  assert.equal(pulled(sim), '<li type="check">task</li>\nnew');
  assert.deepEqual(r.warnings, []);
  // Unticking it in the file still warns.
  const sim2 = SimDoc.from('<li type="check">task</li>\nold');
  const first2 = toRemote(sim2.toApi());
  for (const b of first2.doc.blocks) if (b.type === "para" && b.list) b.list.checked = true;
  const r2 = await pushDoc("sim", parse(HEAD + '<li type="check">task</li>\nnew'), {io: io(sim2), first: first2});
  assert.match(r2.warnings.join(), /ticking or unticking/);
});

test("a stale revision is rejected on the first write", async () => {
  const sim = SimDoc.from("a");
  await assert.rejects(pushDoc("sim", parse(HEAD + "b"), {io: io(sim), rev: "r-old"}), /required revision/);
});

// ---------- the original plain-paragraph cases ----------

const START = [
  {text: "Cellular Respiration", ps: {namedStyleType: "HEADING_1"}},
  {text: "Answer every question in complete sentences."},
  {text: "1. Why do cells need oxygen? ANSWER HERE"},
  {text: "Thanks 🙂 bye"},
];

const cases: [string, string][] = [
  ["text edit", `<h1>Cellular Respiration</h1>\n\nAnswer every question in full sentences.\n1. Why do cells need oxygen? ANSWER HERE\nThanks 🙂 bye\n`],
  ["highlight + bold", `<h1>Cellular Respiration</h1>\n\nAnswer every question in <b>complete sentences</b>.\n1. Why do cells need oxygen? <mark>To make ATP.</mark>\nThanks 🙂 bye\n`],
  ["insert paragraphs", `<h1>Cellular Respiration</h1>\n\nAnswer every question in complete sentences.\nNew one\n<h2>And a heading</h2>\n\n1. Why do cells need oxygen? ANSWER HERE\nThanks 🙂 bye\nAt the end\n`],
  ["delete paragraphs", `<h1>Cellular Respiration</h1>\n\nThanks 🙂 bye\n`],
  ["delete last", `<h1>Cellular Respiration</h1>\n\nAnswer every question in complete sentences.\n1. Why do cells need oxygen? ANSWER HERE\n`],
  ["emoji edits", `<h1>Cellular Respiration 🧬</h1>\n\nAnswer every question in complete sentences.\n1. Why do cells need oxygen? ANSWER HERE\nThanks 🙃 bye <i>ok</i>\n`],
  ["restyle", `<p align="center">Cellular Respiration</p>\n<h3>Answer every question in complete sentences.</h3>\n\n1. Why do cells need oxygen? ANSWER HERE\nThanks 🙂 bye\n`],
  ["rewrite all", `<title>Totally</title>\n\ndifferent <a href="https://x.test">doc</a>\n<p></p>\n<p></p>\nwith blanks\n`],
  ["first paragraph", `New first\n\n<h1>Cellular Respiration</h1>\n\nAnswer every question in complete sentences.\n1. Why do cells need oxygen? ANSWER HERE\nThanks 🙂 bye\n`],
];

for (const [name, target] of cases) {
  test(`converges: ${name}`, async () => {
    const r = await push(new SimDoc(START), target);
    assert.equal(canon(r.out), canon(target));
  });
}

test("plain text edit is a single pass", async () => {
  const r = await push(new SimDoc(START), `<h1>Cellular Respiration</h1>\n\nAnswer every question in full sentences.\n1. Why do cells need oxygen? ANSWER HERE\nThanks 🙂 bye\n`);
  assert.equal(r.passes, 1);
});
