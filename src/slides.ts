// Talks to the Slides API: reads a deck, pushes a .goog file to it pass by
// pass, and saves its pictures for an agent to look at.

import {execFile, spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {ApiError, DRIVE, api} from "./google.ts";
import {isAlive, startedAt} from "./proc.ts";
import type {Deck} from "./slides-format.ts";
import {plan, type SPlan} from "./slides-plan.ts";
import {type RemoteDeck, fromApi} from "./slides-read.ts";

export const SLIDES = "https://slides.googleapis.com/v1/presentations";

// How pushDeck talks to Slides; tests swap in a simulator.
export interface SlidesIO {
  get(id: string): Promise<any>;
  batch(id: string, body: {requests: any[]; writeControl?: any}): Promise<{replies?: any[]; writeControl?: {requiredRevisionId?: string}}>;
}

const LIVE: SlidesIO = {
  get: (id) => api("GET", `${SLIDES}/${encodeURIComponent(id)}`),
  batch: (id, body) => api("POST", `${SLIDES}/${encodeURIComponent(id)}:batchUpdate`, body),
};

export const fetchDeck = async (id: string, io: SlidesIO = LIVE): Promise<RemoteDeck> => fromApi(await io.get(id));

export async function fetchDeckRev(id: string): Promise<string> {
  const j = await api<{revisionId: string}>("GET", `${SLIDES}/${encodeURIComponent(id)}?fields=revisionId`);
  return j.revisionId;
}

export async function createDeck(title: string): Promise<string> {
  const j = await api<{presentationId: string}>("POST", SLIDES, {title});
  return j.presentationId;
}

export interface DeckPushResult {
  remote: RemoteDeck;
  requests: number;
  passes: number;
  warnings: string[];
}

// A group nested n deep takes about 2n passes to change; a pass that repeats
// the last one stops the push sooner.
const MAX_PASSES = 20;

// Edits the deck until it matches `target`, guarding each write with the
// revision it was planned against (see pushDoc in gdocs.ts).
export async function pushDeck(
  id: string,
  target: Deck,
  opts: {rev?: string; first?: RemoteDeck; onPass?: (p: SPlan, pass: number) => void; io?: SlidesIO} = {},
): Promise<DeckPushResult> {
  const io = opts.io ?? LIVE;
  const want = structuredClone(target);
  let remote = opts.first ?? (await fetchDeck(id, io));
  let requests = 0;
  let last = "";
  const warnings: string[] = [];
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const p = plan(remote, want);
    opts.onPass?.(p, pass);
    for (const w of p.warnings) if (!warnings.includes(w)) warnings.push(w);
    if (!p.requests.length) return {remote, requests, passes: pass, warnings};
    const sig = JSON.stringify(p.requests);
    if (sig === last) {
      warnings.push("some changes can't be made in Google Slides; the file shows what the deck ended up with");
      return {remote, requests, passes: pass, warnings};
    }
    last = sig;
    const rev = pass === 0 ? opts.rev ?? remote.deck.rev : remote.deck.rev;
    const res = await io.batch(id, {requests: p.requests, writeControl: rev ? {requiredRevisionId: rev} : undefined});
    requests += p.requests.length;
    remote = await fetchDeck(id, io);
    const after = res.writeControl?.requiredRevisionId;
    if (after && remote.deck.rev && after !== remote.deck.rev) {
      throw new ApiError(400, `required revision changed during push: the deck was edited after goog's write (pass ${pass + 1}); merge again and retry`);
    }
  }
  warnings.push(`stopped after ${MAX_PASSES} passes; the deck may not match the file exactly`);
  return {remote, requests, passes: MAX_PASSES, warnings};
}

const EXT: Record<string, string> = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg"};

async function inBatches<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(fn));
}

// contentUrls are pre-signed, and fetching them without the token is several
// times faster; the token is only a fallback.
async function download(url: string): Promise<{type: string; data: Buffer}> {
  try {
    const r = await fetch(url, {signal: AbortSignal.timeout(30_000)});
    if (r.ok) return {type: r.headers.get("content-type") ?? "", data: Buffer.from(await r.arrayBuffer())};
  } catch {}
  return api<{type: string; data: Buffer}>("GET", url, undefined, {bytes: true});
}

// The thumbnail API allows about 60 calls a minute per user, so drawing a big
// deck slide by slide waits on the quota for a minute or more. Drive's PDF
// export draws the whole deck in one call and mutool turns the pages into
// pictures in a few seconds. A few changed slides stay on thumbnails, which
// skip the export. False when this way can't draw them (no mutool, skipped
// slides missing from the export, an export too big for Drive).
const PDF_FROM = 10;
const run = promisify(execFile);
const mutool = new Map<string, Promise<boolean>>(); // by PATH
const hasMutool = () => {
  const path = process.env.PATH ?? "";
  if (!mutool.has(path)) mutool.set(path, run("mutool", ["-v"]).then(() => true, () => false));
  return mutool.get(path)!;
};
async function drawFromPdf(deckId: string, count: number, want: number[], slides: string[], dir: string): Promise<boolean> {
  if (want.length < PDF_FROM || !(await hasMutool())) return false;
  // Inside dir, so a draw that's killed leaves at most one, which the next
  // draw clears.
  const tmp = join(dir, ".pdf");
  try {
    rmSync(tmp, {recursive: true, force: true});
    mkdirSync(tmp);
    const pdf = join(tmp, "deck.pdf");
    writeFileSync(pdf, (await api<{data: Buffer}>("GET", `${DRIVE}/files/${encodeURIComponent(deckId)}/export?mimeType=application/pdf`, undefined, {bytes: true})).data);
    if (Number((await run("mutool", ["show", pdf, "trailer/Root/Pages/Count"])).stdout.trim()) !== count) return false;
    await run("mutool", ["draw", "-q", "-w", "800", "-o", join(tmp, "p%d.png"), pdf, want.map((i) => i + 1).join(",")]);
    for (const i of want) copyFileSync(join(tmp, `p${i + 1}.png`), slides[i]);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
}

// What a slide looks like, for telling whether its picture is out of date:
// the API's page with its layout and master, so a background, chart or theme
// changed in the browser counts too. contentUrls are signed afresh on every
// fetch and speaker notes aren't drawn, so they're left out.
function looks(remote: RemoteDeck, page: any): string {
  const props = page.slideProperties ?? {};
  const find = (list: any[] | undefined, id: string | undefined) => list?.find((p) => p.objectId === id);
  const parts = [page, find(remote.raw.layouts, props.layoutObjectId), find(remote.raw.masters, props.masterObjectId)];
  const json = JSON.stringify(parts, (k, v) => (k === "contentUrl" || k === "notesPage" ? undefined : v));
  return createHash("sha1").update(json).digest("hex");
}

// Saves each picture on the deck as <dir>/<object id>.<ext> (skipping ones
// already saved; an id always names the same picture) and a picture of every
// slide as <dir>/slide-<n>.png, since where things sit is half of a slide. A
// slide is drawn again only when what's on it changed: .drawn.json remembers
// what each slide-<n>.png shows.
export async function saveDeckImages(remote: RemoteDeck, dir: string): Promise<{images: string[]; slides: string[]}> {
  mkdirSync(dir, {recursive: true});
  const have = new Map(readdirSync(dir).map((f) => [f.replace(/\.[^.]*$/, ""), f]));
  const pics: [string, string][] = [];
  for (const [id, r] of remote.els) if (r.raw.image?.contentUrl) pics.push([id, r.raw.image.contentUrl]);
  const images = new Map<string, string>();
  const saving = inBatches(pics, 24, async ([id, url]) => {
    let f = have.get(id);
    if (!f) {
      const r = await download(url);
      f = `${id}.${EXT[r.type.split(";")[0]] ?? "img"}`;
      writeFileSync(join(dir, f), r.data);
    }
    images.set(id, join(dir, f));
  });
  const slides: string[] = remote.slides.map((_, i) => join(dir, `slide-${i + 1}.png`));
  const drawnPath = join(dir, ".drawn.json");
  let drawn: Record<string, string> = {};
  try {
    drawn = JSON.parse(readFileSync(drawnPath, "utf8"));
  } catch {}
  const hashes = remote.slides.map((s) => looks(remote, s.raw));
  const key = (i: number) => `slide-${i + 1}`;
  const stale = remote.slides.map((s, i) => [s.id, i] as const).filter(([, i]) => drawn[key(i)] !== hashes[i] || !existsSync(slides[i]));
  const drawThumbnails = () => inBatches(stale, 12, async ([page, i]) => {
    const t = await api<{contentUrl: string}>("GET", `${SLIDES}/${encodeURIComponent(remote.deck.id)}/pages/${encodeURIComponent(page)}/thumbnail?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=MEDIUM`);
    writeFileSync(slides[i], (await download(t.contentUrl)).data);
    drawn[key(i)] = hashes[i];
  });
  const drawing = drawFromPdf(remote.deck.id, remote.slides.length, stale.map(([, i]) => i), slides, dir).then((done) => {
    if (done) for (const [, i] of stale) drawn[key(i)] = hashes[i];
    else return drawThumbnails();
  });
  try {
    await Promise.all([saving, drawing]);
  } finally {
    writeFileSync(drawnPath, JSON.stringify(drawn));
  }
  // Pictures of slides that are gone.
  for (const f of readdirSync(dir)) {
    const m = /^slide-(\d+)\.png$/.exec(f);
    if (m && Number(m[1]) > remote.slides.length && existsSync(join(dir, f))) rmSync(join(dir, f));
  }
  return {images: pics.map(([id]) => images.get(id)!).filter(Boolean), slides};
}

// Drawing the slides is most of a pull's time (the thumbnail API takes about
// a second a slide), so pull and push hand it to a detached `goog draw`
// process and return once the text is written. <dir>/.drawing holds its pid
// and start time while it runs; `goog pics` waits for it. One draw runs at a
// time: a sync while it runs leaves <dir>/.redraw, and the draw goes round
// again once it's done, so a deck saved every few seconds still gets drawn.
const BIN = fileURLToPath(new URL("../bin/goog.ts", import.meta.url));
const drawingPath = (dir: string) => join(dir, ".drawing");
const redrawPath = (dir: string) => join(dir, ".redraw");
const drawErrorPath = (dir: string) => join(dir, ".draw-error");
const mark = (pid: number) => `${pid} ${startedAt(pid) ?? ""}`;

// The pid of the draw running for dir, if one is. A pid whose start time
// doesn't match has been reused by another program.
export function drawingPid(dir: string): number | undefined {
  try {
    const [pid, started] = readFileSync(drawingPath(dir), "utf8").trim().split(" ");
    if (isAlive(Number(pid)) && (!started || started === startedAt(Number(pid)))) return Number(pid);
  } catch {}
  return undefined;
}

// Takes the mark for pid, unless a live draw has it. Creating the file is
// atomic, so two syncs at once can't both start a draw.
export function claim(dir: string, pid: number): boolean {
  try {
    const was = readFileSync(drawingPath(dir), "utf8");
    if (drawingPid(dir)) return false;
    // Left by a draw that was killed. Moving it aside is atomic, so of two
    // syncs clearing it only one gets it; one that got a live mark instead
    // puts it back.
    const aside = `${drawingPath(dir)}.${process.pid}`;
    renameSync(drawingPath(dir), aside);
    const got = readFileSync(aside, "utf8");
    if (got !== was) {
      try {
        linkSync(aside, drawingPath(dir));
      } catch {}
      rmSync(aside, {force: true});
      return false;
    }
    rmSync(aside, {force: true});
  } catch {}
  try {
    writeFileSync(drawingPath(dir), mark(pid), {flag: "wx"});
    return true;
  } catch {
    return false;
  }
}

// Starts drawing dir's pictures, or has the running draw go round again.
// False if neither could be done. Never throws: the pictures are a
// convenience, and the sync that asked for them has already worked.
export function drawInBackground(id: string, dir: string): boolean {
  try {
    mkdirSync(dir, {recursive: true});
    for (let tries = 0; tries < 3; tries++) {
      if (drawingPid(dir)) {
        writeFileSync(redrawPath(dir), "");
        if (drawingPid(dir)) return true; // else it finished just now without seeing .redraw
      }
      // Ours until the child's pid is known.
      if (!claim(dir, process.pid)) continue;
      const err = openSync(drawErrorPath(dir), "w");
      const child = spawn(process.execPath, [...process.execArgv, BIN, "draw", id, dir], {detached: true, stdio: ["ignore", "ignore", err]});
      closeSync(err);
      child.on("error", (e) => writeFileSync(drawErrorPath(dir), `couldn't start the draw: ${e.message}`));
      if (child.pid) writeFileSync(drawingPath(dir), mark(child.pid));
      else rmSync(drawingPath(dir), {force: true});
      child.unref();
      return !!child.pid;
    }
  } catch {}
  return false;
}

// What `goog draw` runs: fetch the deck and save its pictures, again for as
// long as syncs keep asking.
export async function drawNow(id: string, dir: string) {
  for (;;) {
    try {
      do {
        rmSync(redrawPath(dir), {force: true});
        await saveDeckImages(await fetchDeck(id), dir);
      } while (existsSync(redrawPath(dir)));
    } finally {
      // Only clear the mark if it's still ours.
      if (drawingPid(dir) === process.pid || !drawingPid(dir)) rmSync(drawingPath(dir), {force: true});
    }
    // A sync that asked for a redraw just as this draw finished.
    if (!existsSync(redrawPath(dir)) || !claim(dir, process.pid)) return;
  }
}

export type DrawWait = {status: "done"} | {status: "failed" | "drawing"; message: string};

// Waits until the draw for dir is done, or the time is up.
export async function waitForDrawing(dir: string, timeoutMs: number): Promise<DrawWait> {
  const deadline = Date.now() + timeoutMs;
  while (drawingPid(dir)) {
    if (Date.now() > deadline) return {status: "drawing", message: `the slides are still being drawn after ${Math.round(timeoutMs / 1000)}s`};
    await new Promise((r) => setTimeout(r, 200));
  }
  const e = existsSync(drawErrorPath(dir)) ? readFileSync(drawErrorPath(dir), "utf8").trim().replace(/^goog: /, "") : "";
  if (e) return {status: "failed", message: `drawing the slides failed: ${e}`};
  // A finished draw removes its mark; one left behind was killed partway.
  if (existsSync(drawingPath(dir))) return {status: "failed", message: "the draw was stopped before it finished, so some pictures may be out of date"};
  return {status: "done"};
}
