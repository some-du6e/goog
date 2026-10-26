// Slide pictures: which slides get drawn again, the PDF route, and the
// background draw's bookkeeping. Google is a stubbed fetch, and mutool a
// shell script on PATH.

import assert from "node:assert/strict";
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "goog-pictures-test-"));
process.env.GOOG_CACHE_DIR = join(tmp, "cache");
process.env.GOOG_CONFIG_DIR = join(tmp, "config");
process.env.GOOG_TOKEN = "offline-test";
// mutool show prints $FAKE_PAGES; mutool draw writes "pdf page N" for each page asked for.
const bin = join(tmp, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "mutool"), `#!/bin/sh
case "$1" in
  -v) echo "mutool version fake" ;;
  show) echo "$FAKE_PAGES" ;;
  draw) for p in $(echo "$8" | tr , ' '); do echo "pdf page $p" > "$(echo "$6" | sed "s/%d/$p/")"; done ;;
esac
`);
chmodSync(join(bin, "mutool"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const {claim, saveDeckImages, drawingPid, drawInBackground, drawNow, waitForDrawing} = await import("../src/slides.ts");
const {fromApi} = await import("../src/slides-read.ts");
const {startedAt} = await import("../src/proc.ts");

const hdi = JSON.parse(readFileSync(new URL("./fixtures/slides-hdi.json", import.meta.url), "utf8"));

// The HDI deck (9 slides) with its slides repeated, ids made unique, up to n slides.
function deckOf(n: number): any {
  const raw = structuredClone(hdi);
  const base = raw.slides;
  raw.slides = Array.from({length: n}, (_, i) => {
    if (i < base.length) return base[i];
    const tag = `_c${i}`;
    return JSON.parse(JSON.stringify(base[i % base.length]), (k, v) => (k === "objectId" && typeof v === "string" ? v + tag : v));
  });
  return raw;
}

const calls = {thumbs: 0, exports: 0};
// What a fetch of the deck returns, and what runs just after it's read.
const served = {deck: deckOf(9) as any, fetches: 0, during: (): void => {}, gone: false};
function serve() {
  const real = globalThis.fetch;
  calls.thumbs = calls.exports = 0;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (/\/presentations\/[^/?]+$/.test(u)) {
      served.fetches++;
      if (served.gone) return new Response(JSON.stringify({error: {code: 404, message: "not found"}}), {status: 404, headers: {"content-type": "application/json"}});
      const body = JSON.stringify(served.deck);
      served.during();
      return new Response(body, {headers: {"content-type": "application/json"}});
    }
    const thumb = /\/pages\/([^/]+)\/thumbnail\?/.exec(u);
    if (thumb) {
      calls.thumbs++;
      return new Response(JSON.stringify({contentUrl: `https://pics.test/thumb/${thumb[1]}`}), {headers: {"content-type": "application/json"}});
    }
    if (u.startsWith("https://pics.test/thumb/")) return new Response(`thumb ${u.split("/").pop()}`);
    if (u.includes("/export?mimeType=application/pdf")) {
      calls.exports++;
      return new Response("%PDF-fake");
    }
    return new Response("img", {headers: {"content-type": "image/png"}}); // the deck's own images
  }) as typeof fetch;
  return () => (globalThis.fetch = real);
}

const fresh = () => mkdtempSync(join(tmp, "files-"));

test("pictures: only slides that look different are drawn again", async (t) => {
  t.after(serve());
  const dir = fresh();
  const raw = deckOf(9);
  const draw = async () => {
    calls.thumbs = 0;
    await saveDeckImages(fromApi(structuredClone(raw)), dir);
    return calls.thumbs;
  };
  assert.equal(await draw(), 9);
  assert.equal(await draw(), 0);
  // Freshly signed contentUrls and speaker notes don't change the picture.
  JSON.stringify(raw, (k, v) => (v && typeof v === "object" && "contentUrl" in v ? ((v.contentUrl += "&sig=new"), v) : v));
  raw.slides[0].slideProperties.notesPage = {objectId: "notes-changed"};
  assert.equal(await draw(), 0);
  // A background set in the browser isn't in the .goog file, but shows.
  raw.slides[2].pageProperties = {pageBackgroundFill: {solidFill: {color: {rgbColor: {red: 1}}}}};
  assert.equal(await draw(), 1);
  // So does a change to a layout: every slide on it is drawn again.
  const layout = raw.slides[3].slideProperties.layoutObjectId;
  const onLayout = raw.slides.filter((s: any) => s.slideProperties.layoutObjectId === layout).length;
  raw.layouts.find((l: any) => l.objectId === layout).pageProperties = {pageBackgroundFill: {solidFill: {color: {rgbColor: {blue: 1}}}}};
  assert.equal(await draw(), onLayout);
  // A missing picture is drawn again.
  rmSync(join(dir, "slide-2.png"));
  assert.equal(await draw(), 1);
  assert.ok(existsSync(join(dir, "slide-2.png")));
  // Pictures of slides that are gone are removed.
  raw.slides.pop();
  await draw();
  assert.ok(!existsSync(join(dir, "slide-9.png")));
});

test("pictures: many stale slides come from one PDF export", async (t) => {
  t.after(serve());
  process.env.FAKE_PAGES = "12";
  const dir = fresh();
  // Left by a draw that was killed; cleared, not drawn from.
  mkdirSync(join(dir, ".pdf"));
  writeFileSync(join(dir, ".pdf", "p1.png"), "stale");
  const raw = deckOf(12);
  await saveDeckImages(fromApi(structuredClone(raw)), dir);
  assert.deepEqual(calls, {thumbs: 0, exports: 1});
  assert.equal(readFileSync(join(dir, "slide-1.png"), "utf8").trim(), "pdf page 1");
  assert.equal(readFileSync(join(dir, "slide-12.png"), "utf8").trim(), "pdf page 12");
  assert.ok(!existsSync(join(dir, ".pdf")));
  // Recorded as drawn, so nothing is drawn again.
  await saveDeckImages(fromApi(structuredClone(raw)), dir);
  assert.deepEqual(calls, {thumbs: 0, exports: 1});
  // A few changed slides skip the export.
  for (const i of [0, 1]) raw.slides[i].pageProperties = {pageBackgroundFill: {solidFill: {color: {rgbColor: {green: 1}}}}};
  await saveDeckImages(fromApi(structuredClone(raw)), dir);
  assert.deepEqual(calls, {thumbs: 2, exports: 1});
});

test("pictures: a PDF whose pages don't match the slides falls back to thumbnails", async (t) => {
  t.after(serve());
  process.env.FAKE_PAGES = "11"; // as if a skipped slide were left out
  const dir = fresh();
  await saveDeckImages(fromApi(deckOf(12)), dir);
  assert.deepEqual(calls, {thumbs: 12, exports: 1});
  assert.match(readFileSync(join(dir, "slide-1.png"), "utf8"), /^thumb /);
});

test("pictures: a draw's mark names one live process", async () => {
  const dir = fresh();
  const mark = (pid: number, started = startedAt(pid) ?? "") => writeFileSync(join(dir, ".drawing"), `${pid} ${started}`);
  assert.deepEqual(await waitForDrawing(dir, 1000), {status: "done"});
  mark(process.pid);
  assert.equal(drawingPid(dir), process.pid);
  assert.equal((await waitForDrawing(dir, 300)).status, "drawing");
  if (startedAt(process.pid)) {
    // The pid now belongs to another program: not a draw, and not waited on.
    mark(process.pid, "1");
    assert.equal(drawingPid(dir), undefined);
  }
  const dead = spawnSync("true").pid;
  mark(dead, "");
  assert.equal(drawingPid(dir), undefined);
  // A mark left behind means the draw was killed partway.
  const w = await waitForDrawing(dir, 1000);
  assert.equal(w.status, "failed");
  rmSync(join(dir, ".drawing"));
  writeFileSync(join(dir, ".draw-error"), "goog: the deck is gone\n");
  assert.deepEqual(await waitForDrawing(dir, 1000), {status: "failed", message: "drawing the slides failed: the deck is gone"});
});

test("pictures: a sync during a draw asks it to go round again instead of starting another", () => {
  const dir = fresh();
  const mark = `${process.pid} ${startedAt(process.pid) ?? ""}`;
  writeFileSync(join(dir, ".drawing"), mark);
  drawInBackground("deck", dir);
  assert.ok(existsSync(join(dir, ".redraw")));
  assert.equal(readFileSync(join(dir, ".drawing"), "utf8"), mark);
  assert.ok(!existsSync(join(dir, ".draw-error")));
  // And never fails the sync, even when the pictures can't go anywhere.
  const notADir = join(tmp, "plain-file");
  writeFileSync(notADir, "");
  assert.equal(drawInBackground("deck", notADir), false);
  // A draw that can't start gives back the mark it took, or no draw would ever run again.
  const stuck = fresh();
  mkdirSync(join(stuck, ".draw-error"));
  assert.equal(drawInBackground("deck", stuck), false);
  assert.ok(!existsSync(join(stuck, ".drawing")));
});

test("pictures: without mutool, nothing is exported", async (t) => {
  t.after(serve());
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  t.after(() => (process.env.PATH = path));
  await saveDeckImages(fromApi(deckOf(12)), fresh());
  assert.deepEqual(calls, {thumbs: 12, exports: 0});
});

test("pictures: a draw goes round again for a sync made while it ran, then clears its mark", async (t) => {
  t.after(serve());
  const dir = fresh();
  writeFileSync(join(dir, ".drawing"), `${process.pid} ${startedAt(process.pid) ?? ""}`);
  served.fetches = 0;
  served.deck = deckOf(9);
  served.during = () => {
    served.during = () => {};
    // A push lands while the first round is fetching.
    served.deck.slides[0].pageProperties = {pageBackgroundFill: {solidFill: {color: {rgbColor: {red: 1}}}}};
    drawInBackground("deck", dir);
  };
  await drawNow("deck", dir);
  assert.equal(served.fetches, 2);
  assert.equal(calls.thumbs, 9 + 1);
  assert.ok(!existsSync(join(dir, ".drawing")));
  assert.ok(!existsSync(join(dir, ".redraw")));
  assert.deepEqual(await waitForDrawing(dir, 1000), {status: "done"});
});

test("pictures: a mark left by a killed draw is taken over, a live one isn't", () => {
  const dir = fresh();
  const live = `${process.pid} ${startedAt(process.pid) ?? ""}`;
  writeFileSync(join(dir, ".drawing"), `${spawnSync("true").pid} `);
  assert.ok(claim(dir, process.pid));
  assert.equal(readFileSync(join(dir, ".drawing"), "utf8"), live);
  assert.ok(!claim(dir, process.pid));
  assert.equal(readFileSync(join(dir, ".drawing"), "utf8"), live);
  assert.deepEqual(readdirSync(dir), [".drawing"]);
});

test("pictures: a draw that fails keeps its mark, so goog pics can't take it for done", async (t) => {
  t.after(serve());
  t.after(() => (served.gone = false));
  const dir = fresh();
  writeFileSync(join(dir, ".drawing"), `${process.pid} ${startedAt(process.pid) ?? ""}`);
  served.gone = true;
  await assert.rejects(drawNow("deck", dir));
  assert.ok(existsSync(join(dir, ".drawing")));
});
