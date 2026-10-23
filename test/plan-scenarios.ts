// Edit scenarios shared by the live harness (test/plan-live.ts).

import type {Remote} from "../src/gdocs-read.ts";
import type {PushResult} from "../src/gdocs.ts";

export interface Scenario {
  name: string;
  start: string;
  edit: string | ((pulled: string) => string);
  expect?: string | ((pulled: string) => string); // what the doc should read back as, when it isn't the target
  setup?: (id: string) => Promise<void>; // runs after `start` is pushed
  expectError?: RegExp;
  between?: (id: string) => Promise<void>; // runs after the pull, before the push
  check?: (final: Remote, r: PushResult) => string | undefined;
}

const rep = (...pairs: [string | RegExp, string][]) => (s: string) => {
  for (const [a, b] of pairs) {
    const t = s.replace(a, b);
    if (t === s) throw new Error(`edit didn't apply: ${a}`);
    s = t;
  }
  return s;
};

export const IMG = "https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png";

const TEXT = `<h1>Heading one</h1>

First paragraph with <b>bold</b> and <i>italic</i>.
Second paragraph 🙂 here.
Third and last.`;

const LIST = `Intro
<li>apple</li>
<li>banana</li>
<li level="2">banana kid</li>
<li>cherry</li>
Outro`;

const TABLE = `Before
<table>
<tr><td>a1</td><td>b1</td><td>c1</td></tr>
<tr><td>a2</td><td>b2</td><td>c2</td></tr>
<tr><td>a3</td><td>b3</td><td>c3</td></tr>
</table>
After`;

const s = (name: string, start: string, edit: Scenario["edit"], extra: Partial<Scenario> = {}): Scenario => ({name, start, edit, ...extra});

const batch = async (id: string, requests: any[]) => {
  const {api} = await import("../src/google.ts");
  return api("POST", `https://docs.googleapis.com/v1/documents/${id}:batchUpdate`, {requests});
};

const BIG = Array.from({length: 150}, (_, i) => (i % 10 === 0 ? `<h2>Section ${i / 10}</h2>` : `Paragraph number ${i} with some text in it.`)).join("\n");

export const SCENARIOS: Scenario[] = [
  // ---- text ----
  s("text: start of para", TEXT, rep(["First paragraph", "NEW First paragraph"])),
  s("text: middle", TEXT, rep(["with <b>bold</b>", "with <b>very bold</b>"])),
  s("text: end of para", TEXT, rep(["Third and last.", "Third and last. More."])),
  s("text: end of doc append para", TEXT, (t) => t + "\nBrand new last"),
  s("text: start of doc", TEXT, (t) => "Brand new first\n" + t),
  s("text: emoji zwj", TEXT, rep(["🙂", "👨‍👩‍👧‍👦 and 🇺🇸"])),
  s("text: emoji replace", "a 🙂 b 😀 c", "a 😀 b 🙂 c"),
  s("text: delete last para", TEXT, rep(["\nThird and last.", ""])),
  s("text: delete first para", TEXT, rep([/^<h1>Heading one<\/h1>\n*/, ""])),
  s("text: delete everything", TEXT, ""),
  s("text: empty to content", "", TEXT),
  s("text: whitespace-only para", TEXT, rep(["Second paragraph", "<p>   </p>\nSecond paragraph"])),
  s("text: leading/trailing spaces", TEXT, rep(["Third and last.", "<p>  Third and last.  </p>"])),
  s("text: tabs", TEXT, rep(["Third and last.", "Third\tand\tlast."])),
  s("text: br", TEXT, rep(["Third and last.", "Third<br>and last."])),
  s("text: remove br", "one<br>two", "one two"),
  s("text: big rewrite", TEXT, `<title>Totally</title>\n\nDifferent <a href="https://x.test">doc</a>\n<p></p>\nwith blanks\n<h2>H</h2>\n\nend`),
  s("text: reorder", "alpha\nbeta\ngamma\ndelta", "delta\ngamma\nbeta\nalpha"),
  s("text: split para", TEXT, rep(["Second paragraph 🙂 here.", "Second paragraph\n🙂 here."])),
  s("text: join paras", TEXT, rep(["Second paragraph 🙂 here.\nThird and last.", "Second paragraph 🙂 here. Third and last."])),

  // ---- styles ----
  s("style: heading to p", TEXT, rep(["<h1>Heading one</h1>", "<p>Heading one</p>"])),
  s("style: p to heading", TEXT, rep(["Third and last.", "<h2>Third and last.</h2>"])),
  s("style: align", TEXT, rep(["Third and last.", `<p align="center">Third and last.</p>`])),
  s("style: mark colors", "plain <mark>yellow</mark> text", `plain <mark color="#00ff00">yellow</mark> <mark>text</mark>`),
  s("style: link add", "go to site now", `go to <a href="https://example.com">site</a> now`),
  s("style: link change", `go to <a href="https://example.com">site</a> now`, `go to <a href="https://example.org/x">site</a> now`),
  s("style: link remove", `go to <a href="https://example.com">site</a> now`, "go to site now"),
  s("style: sup/sub", "E=mc2 H2O", "E=mc<sup>2</sup> H<sub>2</sub>O"),
  s("style: font size color", "styled text", `<span color="#cc0000" font="Georgia" size="14">styled</span> text`),
  s("style: clear formatting", `<span color="#cc0000" font="Georgia" size="14"><b>styled</b></span> <mark>text</mark>`, "styled text"),
  s("style: clear in heading", `<h1><span color="#cc0000" size="30">Big</span> heading</h1>`, "<h1>Big heading</h1>"),
  s("style: heading then insert after", TEXT, rep(["<h1>Heading one</h1>", "<h1>Heading one</h1>\nplain after heading"])),
  s("style: insert before heading", TEXT, rep(["<h1>Heading one</h1>", "plain before\n<h1>Heading one</h1>"])),
  s("style: type after bold", "<b>bold</b>", "<b>bold</b> plain"),
  s("style: type before link", `<a href="https://x.test">link</a> tail`, `pre <a href="https://x.test">link</a> tail`),

  // ---- lists ----
  s("list: change level", LIST, rep(["<li>cherry</li>", `<li level="2">cherry</li>`])),
  s("list: unindent", LIST, rep([`<li level="2">banana kid</li>`, "<li>banana kid</li>"])),
  s("list: toggle numbered", LIST, (t) => t.replace(/<li(?: level="2")?>/g, (m) => m.replace(">", ` type="1">`))),
  s("list: para to list", LIST, rep(["Outro", "<li>Outro</li>"])),
  s("list: list to para", LIST, rep(["<li>cherry</li>", "cherry"])),
  s("list: insert mid", LIST, rep(["<li>banana</li>", "<li>banana</li>\n<li>blueberry</li>"])),
  s("list: insert after last", LIST, rep(["<li>cherry</li>", "<li>cherry</li>\n<li>date</li>"])),
  s("list: insert para after list", LIST, rep(["<li>cherry</li>", "<li>cherry</li>\nnot a bullet"])),
  s("list: insert para before list", LIST, rep(["Intro", "Intro\nnot a bullet either"])),
  s("list: split", LIST, rep(["<li>banana</li>", "<li>banana</li>\nmiddle"])),
  s("list: merge", "<li>one</li>\nbreak\n<li>two</li>", "<li>one</li>\n<li>two</li>"),
  s("list: deep nesting", "<li>l1</li>", `<li>l1</li>\n<li level="2">l2</li>\n<li level="3">l3</li>\n<li level="4">l4</li>\n<li level="5">l5</li>`),
  s("list: text edit only", LIST, rep(["banana kid", "banana child"])),
  s("list: delete item", LIST, rep(["<li>banana</li>\n", ""])),
  s("list: delete all items", LIST, "Intro\nOutro"),
  s("list: mixed top level", LIST, rep(["<li>cherry</li>", `<li type="1">cherry</li>`])),
  s("list: heading item", LIST, rep(["<li>cherry</li>", `<li style="h2">cherry</li>`])),
  s("list: at doc end", "Intro", "Intro\n<li>a</li>\n<li>b</li>"),
  s("list: at doc start", "Intro", "<li>a</li>\n<li>b</li>\nIntro"),
  s("list: adjacent to table", TABLE, rep(["Before\n", "Before\n<li>x</li>\n<li>y</li>\n"])),
  s("list: after table", TABLE, rep(["After", "<li>x</li>\n<li>y</li>"])),
  s("list: nested item before other list", `<li>a</li>\n<li level="2">b</li>\n<li type="1" start="1">n</li>`, `<li>a</li>\n<li level="2">b</li>\n<li level="2">b2</li>\n<li type="1" start="1">n</li>`),
  s("list: middle item level", "<li>a</li>\n<li>b</li>\n<li>c</li>", `<li>a</li>\n<li level="2">b</li>\n<li>c</li>`),
  s("list: two separate lists", "<li>a</li>\n<li>b</li>\nmid\n<li>c</li>", "<li>a</li>\n<li>b</li>\nmid\n<li>c</li>\n<li>d</li>"),

  // ---- tables ----
  s("table: edit cell", TABLE, rep(["<td>b2</td>", "<td>b2 edited</td>"])),
  s("table: clear cell", TABLE, rep(["<td>b2</td>", "<td></td>"])),
  s("table: fill empty cell", "<table>\n<tr><td></td><td>x</td></tr>\n</table>", "<table>\n<tr><td>filled</td><td>x</td></tr>\n</table>"),
  s("table: add row first", TABLE, rep(["<tr><td>a1</td>", "<tr><td>a0</td><td>b0</td><td>c0</td></tr>\n<tr><td>a1</td>"])),
  s("table: add row middle", TABLE, rep(["<tr><td>a2</td>", "<tr><td>aX</td><td>bX</td><td>cX</td></tr>\n<tr><td>a2</td>"])),
  s("table: add row last", TABLE, rep(["</table>", "<tr><td>a4</td><td>b4</td><td>c4</td></tr>\n</table>"])),
  s("table: remove row first", TABLE, rep(["<tr><td>a1</td><td>b1</td><td>c1</td></tr>\n", ""])),
  s("table: remove row middle", TABLE, rep(["<tr><td>a2</td><td>b2</td><td>c2</td></tr>\n", ""])),
  s("table: remove row last", TABLE, rep(["\n<tr><td>a3</td><td>b3</td><td>c3</td></tr>", ""])),
  s("table: add col last", TABLE, (t) => t.replace(/<\/td><\/tr>/g, "</td><td>d</td></tr>")),
  s("table: add col first", TABLE, (t) => t.replace(/<tr>/g, "<tr><td>z</td>")),
  s("table: remove col first", TABLE, (t) => t.replace(/<tr><td>a\d<\/td>/g, "<tr>")),
  s("table: remove col middle", TABLE, (t) => t.replace(/<td>b\d<\/td>/g, "")),
  s("table: remove col last", TABLE, (t) => t.replace(/<td>c\d<\/td>/g, "")),
  s("table: row edit + add", TABLE, rep(["<td>a2</td>", "<td>A2</td>"], ["</table>", "<tr><td>a4</td><td>b4</td><td>c4</td></tr>\n</table>"])),
  s("table: insert whole", TEXT, rep(["Third and last.", "<table>\n<tr><td>x</td><td><b>y</b></td></tr>\n<tr><td>z</td><td>w</td></tr>\n</table>\nThird and last."])),
  s("table: insert at end", TEXT, (t) => t + "\n<table>\n<tr><td>x</td><td>y</td></tr>\n</table>"),
  s("table: insert at start", TEXT, (t) => "<table>\n<tr><td>x</td><td>y</td></tr>\n</table>\n" + t),
  s("table: delete whole", TABLE, "Before\nAfter"),
  s("table: delete at end", "Before\n<table>\n<tr><td>x</td></tr>\n</table>", "Before"),
  s("table: delete para before", TABLE, rep(["Before\n", ""])),
  s("table: delete para after", TABLE, rep(["\nAfter", ""])),
  s("table: insert before", TABLE, rep(["Before", "Before\nJust before table"])),
  s("table: insert after", TABLE, rep(["After", "Just after table\nAfter"])),
  s("table: between tables", "<table>\n<tr><td>1</td></tr>\n</table>\nmid\n<table>\n<tr><td>2</td></tr>\n</table>\nend", "<table>\n<tr><td>1</td></tr>\n</table>\nmid\nmid2\n<table>\n<tr><td>2</td></tr>\n</table>\nend"),
  s("table: multi-para cell", TABLE, rep(["<td>b2</td>", "<td><p>one</p><p>two</p></td>"])),
  s("table: multi-para cell back", "<table>\n<tr><td><p>one</p><p>two</p></td><td>x</td></tr>\n</table>", "<table>\n<tr><td>one</td><td>x</td></tr>\n</table>"),
  s("table: list in cell", TABLE, rep(["<td>b2</td>", "<td><li>i1</li><li>i2</li></td>"])),
  s("table: heading in cell", TABLE, rep(["<td>b2</td>", "<td><h2>head</h2></td>"])),
  s("table: nested table", TABLE, rep(["<td>b2</td>", "<td><p>x</p><table><tr><td>in</td></tr></table><p></p></td>"])),
  s("table: 1x1 empty", "Before", "Before\n<table>\n<tr><td></td></tr>\n</table>\nAfter"),
  s("table: replace table", TABLE, rep([/<table>[\s\S]*<\/table>/, "<table>\n<tr><td>new</td><td>table</td></tr>\n</table>"])),
  s("table: styled cells", TABLE, rep(["<td>a1</td>", "<td><b>a1</b></td>"], ["<td>c3</td>", `<td><p align="center"><mark>c3</mark></p></td>`])),

  // ---- atoms ----
  s("atom: insert image", TEXT, rep(["Third and last.", `Third <img src="${IMG}"> and last.`])),
  s("atom: delete image", `pic <img src="${IMG}"> here`, "pic  here"),
  s("atom: move image", `pic <img src="${IMG}"> here\nother`, (t) => t.replace(/ (<img [^>]+>)/, "").replace("other", "other $1".replace("$1", /<img [^>]+>/.exec(t)![0]))),
  s("atom: duplicate image", `pic <img src="${IMG}"> here`, (t) => t.replace(/(<img [^>]+>)/, "$1$1")),
  s("atom: text around image", `pic <img src="${IMG}"> here`, (t) => t.replace("pic ", "picture: ").replace(" here", " is here")),
  s("atom: pagebreak add", TEXT, rep(["Third and last.", "Third<pagebreak> and last."])),
  s("atom: pagebreak own para", TEXT, rep(["Third and last.", "<pagebreak>\nThird and last."])),
  s("atom: pagebreak remove", "a<pagebreak>b\nc", "ab\nc"),
  s("atom: hr create", TEXT, rep(["Third and last.", "Third <hr> last."]), {expect: TEXT.replace("Third and last.", "Third  last.")}),
  s("atom: image in cell", TABLE, rep(["<td>b2</td>", `<td>b2 <img src="${IMG}"></td>`])),

  // ---- regressions and new fields ----
  s("style: default font", "styled text", `<span color="#cc0000" font="Arial" size="14">styled</span> text`, {expect: `<span color="#cc0000" size="14">styled</span> text`}),
  s("del: heading at end", "Para\n<h2>End</h2>", "Para"),
  s("del: list item at end", "Intro\n<li>a</li>", "Intro"),
  s("del: para after list at end", "<li>a</li>\n<li>b</li>\nOutro", "<li>a</li>\n<li>b</li>"),
  s("del: para before table after heading", "<h1>H</h1>\nx\n<table>\n<tr><td>1</td></tr>\n</table>", "<h1>H</h1>\n<table>\n<tr><td>1</td></tr>\n</table>"),
  s("ins: between heading and edited", "<h1>H</h1>\nbody text", "<h1>H</h1>\nnew para\nbody text edited"),
  s("ins: before edited first", "first para here", "brand new\nfirst para here, edited"),
  // Nested items follow the preset: level 2 of an A list is a.
  s("list: glyph A", LIST, (t) => t.replace(/<li>/g, `<li type="A">`), {expect: LIST.replace(/<li>/g, `<li type="A">`).replace(`<li level="2">`, `<li level="2" type="a">`)}),
  s("list: checklist", "<li>a</li>\n<li>b</li>", `<li type="check">a</li>\n<li type="check">b</li>`),
  s("list: star bullets", "<li>a</li>\n<li>b</li>", `<li type="★">a</li>\n<li type="★">b</li>`),
  s("list: nested numbered type=1", "x", `<li type="1">one</li>\n<li level="2" type="1">nested</li>`),
  s("list: nested a", "x", `<li type="1">one</li>\n<li level="2" type="a">nested</li>\n<li type="1">two</li>`),
  s("list: bullets then numbers adjacent", "x", `<li>a</li>\n<li type="1">b</li>`),
  s("para: indent add", TEXT, rep(["Third and last.", `<p indent="36">Third and last.</p>`])),
  s("para: indent remove", `<p indent="36" first="0">x</p>\ny`, "x\ny"),
  s("para: rtl", "abc", `<p dir="rtl">abc</p>`),
  s("text: weight smallcaps", "abc def", `<span weight="300">abc</span> <span smallcaps>def</span>`),
  s("table: cell bg", TABLE, rep(["<td>b2</td>", `<td bg="#ffff00">b2</td>`])),
  s("table: cell bg remove", `<table>\n<tr><td bg="#ff0000">x</td><td>y</td></tr>\n</table>`, `<table>\n<tr><td>x</td><td>y</td></tr>\n</table>`),
  s("table: merge cells", TABLE, rep(["<tr><td>a1</td><td>b1</td><td>c1</td></tr>", `<tr><td colspan="2">a1</td><td>c1</td></tr>`])),
  s("table: unmerge", `<table>\n<tr><td colspan="2">a</td></tr>\n<tr><td>b</td><td>c</td></tr>\n</table>`, `<table>\n<tr><td>a</td><td>x</td></tr>\n<tr><td>b</td><td>c</td></tr>\n</table>`),
  s("table: rowspan", TABLE, rep(["<tr><td>a1</td>", `<tr><td rowspan="2">a1</td>`], ["<tr><td>a2</td>", "<tr>"])),
  s("table: add row and col", TABLE, (t) => t.replace(/<\/td><\/tr>/g, "</td><td>d</td></tr>").replace("</table>", "<tr><td>a4</td><td>b4</td><td>c4</td><td>d4</td></tr>\n</table>")),
  s("table: list in new table", TEXT, rep(["Third and last.", "<table>\n<tr><td><li>i1</li><li>i2</li></td><td>y</td></tr>\n</table>\nThird and last."])),
  s("table: heading before new table", "<h1>Head</h1>\nafter", "<h1>Head</h1>\n<table>\n<tr><td>x</td></tr>\n</table>\nafter"),
  s("table: two new adjacent", "a", "a\n<table>\n<tr><td>1</td></tr>\n</table>\n<table>\n<tr><td>2</td></tr>\n</table>\nb"),
  s("atom: move image paragraph", `<img src="${IMG}">\ntext one\ntext two`, (t) => {
    const img = /<img [^>]+>/.exec(t)![0];
    return t.replace(img + "\n", "").replace("text two", "text two\n" + img);
  }),
  s("atom: image survives text edits", `before <img src="${IMG}"> after`, (t) => t.replace("before", "BEFORE!").replace("after", "AFTER!"), {
    check: (f) => (/kix\./.test(JSON.stringify(f.doc.blocks)) ? undefined : "image gone"),
  }),
  s("big: edit few", BIG, (t) => t.replace("Paragraph number 33 ", "Paragraph NUMBER 33 ").replace("Paragraph number 101 ", "").replace("<h2>Section 7</h2>", "<h2>Section seven</h2>")),
  s("big: reverse", "a1\nb2\nc3\nd4\ne5\nf6\ng7\nh8", "h8\ng7\nf6\ne5\nd4\nc3\nb2\na1"),
  s("seg: header edit", "body", (t) => t.replace(/(<header[^>]*>)\n*(<p><\/p>\n)?/, "$1\nHeader <b>text</b>\n"), {
    setup: async (id) => void (await batch(id, [{createHeader: {type: "DEFAULT"}}])),
  }),
  s("seg: footnote edit", "body text", (t) => t.replace(/(<footnote-text[^>]*>)\n*([^\n]*)\n/, "$1\nNote <i>here</i>\n"), {
    setup: async (id) => void (await batch(id, [{createFootnote: {location: {index: 5}}}])),
  }),
  s("tab: edit second tab", "first tab body", (t) => t.replace(/(<tab id="(t\.[^"]+)" title=")Second("[^>]*>)\n*(<p><\/p>\n)?/, "$1Renamed$3\n\nsecond tab text\n"), {
    setup: async (id) => void (await batch(id, [{addDocumentTab: {tabProperties: {title: "Second"}}}])),
  }),

  s("style: emoji-leading restyle", "🙂 start\nnext", "<h2>🙂 start</h2>\nnext"),
  s("list: emoji-leading items", "🙂 a\n😀 b", `<li>🙂 a</li>\n<li level="2">😀 b</li>`),
  s("list: emoji item to para", `<li>🙂 a</li>\n<li>😀 b</li>`, `<li>🙂 a</li>\n😀 b`),
  s("seg: delete header", "body", (t) => t.replace(/\n*<header[^>]*>[\s\S]*?<\/header>\n?/, "\n"), {
    setup: async (id) => void (await batch(id, [{createHeader: {type: "DEFAULT"}}])),
  }),
  s("tab: delete second tab", "first tab body", (t) => t.replace(/\n*<tab id="t\.(?!0")[\s\S]*$/, "\n"), {
    setup: async (id) => void (await batch(id, [{addDocumentTab: {tabProperties: {title: "Second"}}}])),
    expect: "first tab body", // one tab left: no <tab> lines
  }),
  s("seg: delete footnote mark and edit its text", "body text\nother", (t) => t.replace(/<footnote [^>]+>/, "").replace(/(<footnote-text[^>]*>)\n*[^\n]*\n/, "$1\nedited note\n"), {
    setup: async (id) => void (await batch(id, [{createFootnote: {location: {index: 5}}}])),
    expect: "body text\nother",
  }),
  s("atom: move chip line", "<h1>T</h1>\nhello\n<li>first</li>\n<li level=\"2\">nested</li>\nchip here", (t) => {
    const line = t.split("\n").find((l) => l.includes("<chip"))!;
    return t.replace("\n" + line, "").replace("hello", line + "\nhello");
  }, {
    setup: async (id) => {
      const {fetchDoc} = await import("../src/gdocs.ts");
      const d = await fetchDoc(id);
      const last = d.body.at(-1)!;
      await batch(id, [{insertPerson: {personProperties: {email: "someone@example.com"}, location: {index: last.end - 1}}}]);
    },
    // The text moves; the chip can't, so it stays behind in its own paragraph.
    expect: (t) => {
      const line = t.split("\n").find((l) => l.includes("<chip"))!;
      const chip = /<chip [^>]+>/.exec(line)![0];
      return t.replace("\n" + line, "\n" + chip).replace("hello", line.replace(chip, "") + "\nhello");
    },
    check: (_f, r) => (r.warnings.some((w) => /can't move <chip/.test(w)) ? undefined : "no warning"),
  }),
  s("atom: edit next to chip", "chip here", (t) => t.replace("chip", "the chip").replace("here", "is here"), {
    setup: async (id) => void (await batch(id, [{insertPerson: {personProperties: {email: "someone@example.com"}, location: {index: 5}}}])),
  }),
  s("atom: move footnote paragraph", "body text\nother line", (t) => {
    const [first, ...rest] = t.split("\n");
    const i = rest.indexOf("other line");
    rest.splice(i + 1, 0, first);
    return rest.join("\n");
  }, {
    setup: async (id) => void (await batch(id, [{createFootnote: {location: {index: 5}}}])),
    expect: (t) => {
      const fn = /<footnote [^>]+>/.exec(t)![0];
      return t.replace(/^body(<footnote [^>]+>) text\nother line/, `$1\nother line\nbody text`).replace(fn + "\n", fn + "\n");
    },
    check: (f, r) => (f.doc.segments?.some((x) => x.kind === "footnote") && r.warnings.some((w) => /can't move <footnote/.test(w)) ? undefined : "footnote lost or no warning"),
  }),

  // ---- misc ----
  s("misc: everything changes", LIST + "\n" + TABLE, TEXT),
  s("misc: rev mismatch", TEXT, rep(["Third and last.", "Third and last, by file."]), {
    expectError: /required revision/,
    between: async (id) => {
      const {api} = await import("../src/google.ts");
      await api("POST", `https://docs.googleapis.com/v1/documents/${id}:batchUpdate`, {requests: [{insertText: {location: {index: 1}, text: "X"}}]});
    },
  }),
];
