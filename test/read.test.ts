// Read fidelity against real Docs API responses (test/fixtures/*.json, scrubbed).
//
// live-*.json were made with the API in a scratch account; scratch.json is a
// user's niche test doc; synthetic.json is hand-built from the API reference
// for things the API can't create (suggestions, TOC, equations, positioned
// objects, horizontal rules, column breaks, page-number autotext, …).

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {parse, serialize} from "../src/format.ts";
import {fromApi, type ISegment, type Remote} from "../src/gdocs-read.ts";
import {plan} from "../src/gdocs-plan.ts";
import type {Doc} from "../src/model.ts";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const FIXTURES = ["scratch", "live-text", "live-structure", "live-empty", "live-edge-tables", "synthetic"];

// Drops fields only the remote side has.
const comparable = (d: Doc) => JSON.parse(JSON.stringify({...d, rev: undefined}, (k, v) => (k === "len" ? undefined : v)));

function segments(r: Remote): ISegment[] {
  const out: ISegment[] = [];
  const add = (seg: ISegment) => {
    out.push(seg);
    for (const b of seg) if (b.type === "table") for (const row of b.cells) for (const c of row) add(c);
  };
  for (const t of r.tabs ?? [{body: r.body, segments: r.segments}]) {
    add(t.body);
    for (const s of t.segments) add(s.body);
  }
  return out;
}

for (const name of FIXTURES) {
  test(`${name}: every index unit is accounted for`, () => {
    const remote = fromApi(load(name));
    for (const seg of segments(remote)) {
      for (const b of seg) {
        if (b.type !== "para") continue;
        let len = 1; // the newline
        for (const r of b.block.runs) len += "text" in r ? r.text.length : r.atom.len ?? NaN;
        assert.equal(len, b.end - b.start, `paragraph at ${b.start}: runs cover ${len} units, the API says ${b.end - b.start}`);
      }
    }
  });

  test(`${name}: serialize -> parse gives back the same doc, and the text is a fixed point`, () => {
    const remote = fromApi(load(name));
    const text = serialize(remote.doc);
    const doc = parse(text);
    assert.deepEqual(comparable(doc), comparable(remote.doc));
    assert.equal(serialize(doc), text);
  });

  test(`${name}: an untouched doc plans no content requests`, () => {
    const remote = fromApi(load(name));
    const doc = parse(serialize(remote.doc));
    const p = plan(remote, doc.blocks);
    assert.notEqual(p.pass, "content", JSON.stringify(p.requests).slice(0, 500));
  });

  test(`${name}: an untouched doc plans zero requests`, () => {
    const remote = fromApi(load(name));
    const p = plan(remote, parse(serialize(remote.doc)).blocks);
    assert.equal(p.requests.length, 0, `${p.pass}: ${JSON.stringify(p.requests).slice(0, 500)}`);
  });
}

const lines = (name: string) => serialize(fromApi(load(name)).doc).split("\n");
const has = (ls: string[], line: string) => assert.ok(ls.includes(line), `missing line: ${line}\n---\n${ls.join("\n")}`);

test("scratch doc: dropdown chip, drawing and chart, heading with <br>", () => {
  const ls = lines("scratch");
  has(ls, `<chip type="dropdown" id="kix.a9y3aucl3r9f" value="yes">`);
  has(ls, `<img id="kix.39j740klsejn" type="drawing">`);
  has(ls, `<img id="kix.kucvnw26w2xc" type="chart" alt="Points scored">`);
  has(ls, `<h1>Wow<br>O<span size="10">k </span></h1>`);
  has(ls, `---`);
  has(ls, `<p>/&gt;&lt;img src=”x” onfail=”alert(‘lol’)&gt;<br><br></p>`);
  has(ls, `<li type="1">numbered</li>`);
});

test("live text doc: styles, links, paragraph attrs, list glyphs, special characters, chips", () => {
  const ls = lines("live-text");
  for (const l of [
    `<h2 id="h.hyvx7eot1dqj">Head 2</h2>`,
    `E=mc<sup>2</sup> and H<sub>2</sub>O`,
    `<span font="Roboto" weight="300">light weight</span>`,
    `<span smallcaps>small caps</span>`,
    `<a href="https://example.com/a?b=1&amp;c=2"><span color="#008000"><u>colored link</u></span></a>`,
    `<a href="https://example.com/nu"><span color="#1155cc">nounder link</span></a>`,
    `<a href="#heading=h.hyvx7eot1dqj">heading link</a>`,
    `<a href="#tab=t.0">tab link</a>`,
    `<p align="justify">justified text that goes on</p>`,
    `<p indent="36">indented</p>`,
    `<p indent="36" first="0">hanging indent</p>`,
    `<p first="36">first line indent</p>`,
    `<p dir="rtl">שלום עולם rtl</p>`,
    `<li type="check">check one</li>`,
    `<li type="★">star</li>`,
    `<li type="A">upper alpha</li>`,
    `<li type="01">zero decimal</li>`,
    `<p>\ttabbed\tcols</p>`,
    `nbsp&nbsp;here`,
    `zw&#x200b;sp and soft&#xad;hyphen`,
    `emoji 👩‍👩‍👧 🏳️‍🌈 👍🏽 é`,
    `&lt;b&gt;not bold&lt;/b&gt;`,
    `&lt;!-- not a comment --&gt;`,
    `&#61;======`,
    `&lt;&lt;&lt;&lt;&lt;&lt;&lt; ours`,
    `<p>  leading and trailing  </p>`,
    `&amp;amp; literal`,
    `line<br>break`,
    `<p>&nbsp;</p>`,
    `<pagebreak>`,
  ]) has(ls, l);
  const chips = ls.find((l) => l.startsWith("chips: "))!;
  assert.match(chips, /<chip type="dropdown" id="[^"]+" value="done">/);
  assert.match(chips, /<chip type="date" id="[^"]+" text="Oct 22, 2026" date="2026-10-22T12:00:00Z">/);
  assert.match(chips, /<chip type="person" id="[^"]+" email="someone@example.com">/);
  assert.match(chips, /<chip type="link" id="[^"]+" title="[^"]+" href="https:\/\/docs.google.com\/document\/d\/live-text-doc\/edit">/);
});

test("live structure doc: merged and colored cells, nested table, sections, segments, tabs", () => {
  const ls = lines("live-structure");
  for (const l of [
    `<tab id="t.0" title="Tab 1">`,
    `<tr><td colspan="2">merged across</td><td bg="#ffe699">top right</td></tr>`,
    `<tr><td rowspan="2">merged down</td><td><p>para one</p><p>para two</p></td><td><li type="check">item x</li><li type="check">item y</li></td></tr>`,
    `<tr><td><p>nested host</p><table><tr><td></td><td></td></tr></table></td><td></td></tr>`,
    `footnote here<footnote id="kix.fpbwkdk6l30h" n="1">`,
    `<object kind="section-break" type="next-page">`,
    `<object kind="section-break" type="continuous">`,
    `<header id="kix.dpe0w0535w95">`, `Header text`, `</header>`,
    `<footer id="kix.ayfv69cww9wq">`, `Footer text`, `</footer>`,
    `<footnote-text id="kix.fpbwkdk6l30h">`, `<p>The footnote &lt;text&gt; &amp; more </p>`, `</footnote-text>`,
    `<tab id="t.468c0bxjb9qi" title="Second tab">`, `with &lt;two&gt; lines`,
    `<tab id="t.ikroufp6fs2q" title="Child tab" parent="t.468c0bxjb9qi">`, `Child body`,
  ]) has(ls, l);
  const remote = fromApi(load("live-structure"));
  const t = remote.doc.blocks.find((b) => b.type === "table")!;
  assert.ok(t.type === "table");
  // The grid stays complete for the planner even though the file hides covered cells.
  assert.deepEqual(t.rows.map((r) => r.length), [3, 3, 3]);
  assert.deepEqual(t.cells?.[0][1], {covered: true});
  assert.deepEqual(t.cells?.[2][0], {covered: true});
  assert.equal(remote.tabs?.length, 3);
});

test("empty doc and a doc that's only a table", () => {
  assert.deepEqual(lines("live-empty").slice(1), ["", ""]);
  assert.deepEqual(lines("live-edge-tables").slice(1), ["", "<table>", "<tr><td></td></tr>", "</table>", ""]);
});

test("synthetic doc: suggestions, TOC, floats, hr, equation, column break, unknown elements, list starts, autotext", () => {
  const ls = lines("synthetic");
  for (const l of [
    `<!-- goog doc synthetic-doc · "weird -\\u002d> title" -->`,
    `<h1 id="h.intro">Intro</h1>`,
    `<object kind="toc">`,
    `keep <ins>added</ins><del>gone</del><ins><chip type="person" id="kix.p1" name="A Person" email="a@example.com"></ins>`,
    `<p float="kix.pos1 kix.pos2">anchor</p>`,
    `<hr>`,
    `E=<equation> and col<columnbreak>after`,
    `future <b><obj type="fancyNewThing"></b>`,
    `<a href="#bookmark=id.bm1">bm</a><a href="#heading=h.far&amp;tab=t.other"> other tab</a>`,
    `<li type="1" start="3">three</li>`,
    `<li type="1" start="1">one again</li>`,
    `<li>bullet</li>`,
    `<li level="2" type="1">numbered child</li>`,
    `<li type="none">no glyph</li>`,
    `a--&gt;b &lt;!-- c`,
    `<tr><td colspan="2">wide</td><td bg="#ff0000" covered></td></tr>`,
    `<header id="kix.first" type="first">`,
    `Page <autotext type="page-number"> of <autotext type="page-count">`,
  ]) has(ls, l);
  assert.equal(parse(ls.join("\n")).name, "weird --> title");
});


test("deleting a tab never takes child tabs the file keeps", () => {
  const remote = fromApi(load("live-structure"));
  const text = serialize(remote.doc);
  const cut = (s: string, id: string) => {
    const lines = s.split("\n");
    const a = lines.findIndex((l) => l.startsWith(`<tab id="${id}"`));
    let b = lines.findIndex((l, i) => i > a && l.startsWith("<tab "));
    if (b < 0) b = lines.length;
    lines.splice(a, b - a);
    return lines.join("\n");
  };
  const tabReqs = (p: {requests: unknown[]}) => (p.requests as any[]).filter((r) => r.deleteTab);
  // Parent dropped, child kept: nothing is deleted, and it says why.
  const p = plan(remote, parse(cut(text, "t.468c0bxjb9qi")));
  assert.deepEqual(tabReqs(p), []);
  assert.match(p.warnings.join(), /"Second tab" wasn't deleted: deleting it would delete "Child tab"/);
  // Both dropped: one deleteTab, for the parent (the child goes with it).
  const both = plan(remote, parse(cut(cut(text, "t.ikroufp6fs2q"), "t.468c0bxjb9qi")));
  assert.deepEqual(tabReqs(both), [{deleteTab: {tabId: "t.468c0bxjb9qi"}}]);
  // Just the child: deleted on its own.
  assert.deepEqual(tabReqs(plan(remote, parse(cut(text, "t.ikroufp6fs2q")))), [{deleteTab: {tabId: "t.ikroufp6fs2q"}}]);
});
