// Talks to the Slides API: reads a deck, pushes a .goog file to it pass by
// pass, and saves its pictures for an agent to look at.

import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {ApiError, api} from "./google.ts";
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
  const hashes = remote.deck.slides.map((s) => createHash("sha1").update(JSON.stringify(s)).digest("hex"));
  const key = (i: number) => `slide-${i + 1}`;
  const stale = remote.slides.map((s, i) => [s.id, i] as const).filter(([, i]) => drawn[key(i)] !== hashes[i] || !existsSync(slides[i]));
  const drawing = inBatches(stale, 12, async ([page, i]) => {
    const t = await api<{contentUrl: string}>("GET", `${SLIDES}/${encodeURIComponent(remote.deck.id)}/pages/${encodeURIComponent(page)}/thumbnail?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=MEDIUM`);
    writeFileSync(slides[i], (await download(t.contentUrl)).data);
    drawn[key(i)] = hashes[i];
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
// while it runs; `goog pics` waits for it. A newer draw replaces an older one.
const BIN = fileURLToPath(new URL("../bin/goog.ts", import.meta.url));
const drawingPath = (dir: string) => join(dir, ".drawing");
export const drawErrorPath = (dir: string) => join(dir, ".draw-error");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
};

// The pid of the draw running for dir, if one is.
export function drawingPid(dir: string): number | undefined {
  try {
    const pid = Number(readFileSync(drawingPath(dir), "utf8"));
    if (pid && alive(pid)) return pid;
  } catch {}
  return undefined;
}

export function drawInBackground(id: string, dir: string) {
  mkdirSync(dir, {recursive: true});
  const old = drawingPid(dir);
  if (old) {
    try {
      process.kill(old);
    } catch {}
  }
  rmSync(drawErrorPath(dir), {force: true});
  const err = openSync(drawErrorPath(dir), "w");
  const child = spawn(process.execPath, [...process.execArgv, BIN, "draw", id, dir], {detached: true, stdio: ["ignore", "ignore", err]});
  closeSync(err);
  writeFileSync(drawingPath(dir), String(child.pid));
  child.unref();
}

// What `goog draw` runs: fetch the deck and save its pictures.
export async function drawNow(id: string, dir: string) {
  try {
    await saveDeckImages(await fetchDeck(id), dir);
  } finally {
    // Only clear the mark if it's still ours (a newer draw may have replaced it).
    if (drawingPid(dir) === process.pid || !drawingPid(dir)) rmSync(drawingPath(dir), {force: true});
  }
}

// Blocks until the draw for dir is done. Returns its error, if it failed.
export async function waitForDrawing(dir: string, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (drawingPid(dir)) {
    if (Date.now() > deadline) throw new Error(`the slides are still being drawn after ${Math.round(timeoutMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const e = existsSync(drawErrorPath(dir)) ? readFileSync(drawErrorPath(dir), "utf8").trim() : "";
  return e || undefined;
}
