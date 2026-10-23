// Talks to the Slides API: reads a deck, pushes a .goog file to it pass by
// pass, and saves its pictures for an agent to look at.

import {existsSync, mkdirSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
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

const MAX_PASSES = 8;

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
// already saved; an id always names the same picture) and a fresh picture of
// every slide as <dir>/slide-<n>.png, since where things sit is half of a slide.
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
  const drawing = inBatches(remote.slides.map((s, i) => [s.id, slides[i]] as const), 12, async ([page, file]) => {
    const t = await api<{contentUrl: string}>("GET", `${SLIDES}/${encodeURIComponent(remote.deck.id)}/pages/${encodeURIComponent(page)}/thumbnail?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=MEDIUM`);
    writeFileSync(file, (await download(t.contentUrl)).data);
  });
  await Promise.all([saving, drawing]);
  // Pictures of slides that are gone.
  for (const f of readdirSync(dir)) {
    const m = /^slide-(\d+)\.png$/.exec(f);
    if (m && Number(m[1]) > remote.slides.length && existsSync(join(dir, f))) rmSync(join(dir, f));
  }
  return {images: pics.map(([id]) => images.get(id)!).filter(Boolean), slides};
}
