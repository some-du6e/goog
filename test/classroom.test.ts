import assert from "node:assert/strict";
import {test} from "node:test";
import {addedWords, dueOf, editable, isBlank, isTodo, marks, parseCourseRef, parseWorkRef, videosIn, words, type Attachment, type Work} from "../src/classroom.ts";

test("parseWorkRef: Classroom links and courseId/workId", () => {
  const want = {courseId: "793347668502", id: "883088850317"};
  assert.deepEqual(parseWorkRef("https://classroom.google.com/c/NzkzMzQ3NjY4NTAy/a/ODgzMDg4ODUwMzE3/details"), want);
  assert.deepEqual(parseWorkRef("classroom.google.com/u/1/c/NzkzMzQ3NjY4NTAy/a/ODgzMDg4ODUwMzE3/submissions/by-status"), want);
  assert.deepEqual(parseWorkRef("793347668502/883088850317"), want);
  assert.equal(parseWorkRef("https://docs.google.com/document/d/abc/edit"), null);
  assert.equal(parseWorkRef("notes.goog"), null);
  assert.throws(() => parseWorkRef("https://classroom.google.com/c/NzkzMzQ3NjY4NTAy"), /isn't a Classroom assignment link/);
  assert.throws(() => parseWorkRef("https://classroom.google.com/c/NzkzMzQ3NjY4NTAy/m/ODgzMDg4ODUwMzE3/details"), /class material, not an assignment/);
});

test("parseCourseRef: a class's link", () => {
  assert.equal(parseCourseRef("https://classroom.google.com/u/0/c/NzkzMzQ3NjY4NTAy"), "793347668502");
  assert.equal(parseCourseRef("https://classroom.google.com/c/NzkzMzQ3NjY4NTAy/a/ODgzMDg4ODUwMzE3/details"), null);
  assert.equal(parseCourseRef("Science"), null);
});

test("dueOf: Classroom's JSON leaves out zero hours and minutes", () => {
  const dueDate = {year: 2026, month: 10, day: 27};
  assert.equal(dueOf({dueDate, dueTime: {hours: 12}}), "2026-10-27T12:00:00.000Z");
  assert.equal(dueOf({dueDate, dueTime: {}}), "2026-10-27T00:00:00.000Z");
  assert.equal(dueOf({dueDate}), "2026-10-27T23:59:00.000Z");
  assert.equal(dueOf({}), undefined);
});

const now = Date.parse("2026-10-24T12:00:00Z");
const work = (w: Partial<Work>): Work => ({
  course: "Science", courseId: "1", id: "2", title: "Lab", url: "", type: "assignment", created: "2026-10-20T00:00:00Z",
  state: "assigned", missing: false, materials: [], yours: [], ...w,
});

test("isTodo: not turned in, and recent or still due", () => {
  assert.equal(isTodo(work({due: "2026-10-27T05:59:00Z"}), now), true);
  assert.equal(isTodo(work({due: "2026-10-17T05:59:00Z", missing: true, daysLate: 8}), now), true);
  assert.equal(isTodo(work({due: "2026-09-01T05:59:00Z"}), now), false);
  assert.equal(isTodo(work({due: "2026-10-27T05:59:00Z", state: "turned-in"}), now), false);
  assert.equal(isTodo(work({due: "2026-10-27T05:59:00Z", state: "returned"}), now), false);
  assert.equal(isTodo(work({}), now), true);
  assert.equal(isTodo(work({created: "2026-08-01T00:00:00Z"}), now), false);
});

test("editable: your one Doc or Slides copy, else a teacher's file shared to edit", () => {
  const doc = (title: string, extra: Partial<Attachment> = {}): Attachment => ({title, url: `https://docs.google.com/document/d/${title}-0123456789abcdef/edit`, kind: "doc", readable: true, ...extra});
  const pdf: Attachment = {title: "rubric.pdf", url: "https://drive.google.com/file/d/x/view", kind: "file", readable: false};
  assert.equal(editable(work({yours: [pdf, doc("mine")], materials: [doc("template", {share: "student-copy"})]})).title, "mine");
  assert.throws(() => editable(work({yours: [doc("a"), doc("b")]})), /2 files of yours; pick one:\n  doc  .*a-0123/);
  assert.equal(editable(work({materials: [doc("shared", {share: "edit"})]})).title, "shared");
  assert.throws(() => editable(work({materials: [doc("handout", {share: "view"})]})), /no Doc or Slides of yours.*\n  doc .*handout/);
  assert.throws(() => editable(work({})), /^Error: "Lab" has no Doc or Slides of yours to edit$/);
  const photo: Attachment = {title: "photo.jpg", url: "https://drive.google.com/file/d/y/view", kind: "file", readable: false};
  assert.equal(editable(work({yours: [photo], materials: [doc("shared", {share: "edit"})]})).title, "shared");
});

test("progress: words a copy adds to its template, tags and header aside", () => {
  const template = `<!-- goog doc T · "Lab" -->\n<h1>Lab</h1>\n<table>\n<tr><td>Name:</td><td></td></tr>\n</table>\nWhat is a cell?\n<p></p>\n`;
  const blank = template.replace("doc T", "doc C");
  const done = blank.replace("<td></td>", "<td>Sam</td>").replace("<p></p>", "<p>The <b>smallest</b> unit of life.</p>");
  assert.deepEqual(words(template), ["Lab", "Name:", "What", "is", "a", "cell?"]);
  assert.equal(addedWords(words(blank), words(template)), 0);
  assert.equal(addedWords(words(done), words(template)), 6);
  assert.equal(addedWords(["a", "a"], ["a"]), 1); // repeats count
});

test("progress sees images and ticks, not just words", () => {
  assert.deepEqual(marks(`<li type="check" checked>done</li>\n<li type="check">not yet</li>\n<p><img id="kix.1"> and <chip type="date" date="2026-10-01"></p>`), {objects: 2, ticks: 1});
  const a = (x: Partial<Attachment>): Attachment => ({title: "t", url: "", kind: "doc", readable: true, ...x});
  assert.equal(isBlank(a({added: 0, objectsAdded: 0, ticksAdded: 0})), true);
  assert.equal(isBlank(a({added: 0, objectsAdded: 1, ticksAdded: 5})), false); // a chart and ticks, no words
  assert.equal(isBlank(a({})), false); // not measured
});

test("videosIn: links and embeds, once each", () => {
  const text = `<a href="https://www.youtube.com/watch?v=j8YfUEzBQ20&t=3">video</a> <a href="https://youtu.be/j8YfUEzBQ20">again</a>\n<video id="v" youtube="abcdefghijk">`;
  assert.deepEqual(videosIn(text), ["https://youtu.be/j8YfUEzBQ20", "https://youtu.be/abcdefghijk"]);
  const more = `<a href="https://www.youtube.com/watch?feature=shared&amp;v=AAAAAAAAAAA">a</a> youtube.com/shorts/BBBBBBBBBBB https://www.youtube-nocookie.com/embed/CCCCCCCCCCC youtube.com/live/DDDDDDDDDDD`;
  assert.deepEqual(videosIn(more), ["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC", "DDDDDDDDDDD"].map((id) => `https://youtu.be/${id}`));
});
