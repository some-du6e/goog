// What sync and the watcher need from a kind of Google file, so they work the
// same for Docs and Slides. A file's kind is in its header; a bare id's is
// looked up in Drive once.

import {parseHeader, parse as parseDoc, serialize as serializeDoc} from "./format.ts";
import {fetchDoc, fetchRev, markChecked, pushDoc, saveImages} from "./gdocs.ts";
import {plan as planDoc} from "./gdocs-plan.ts";
import {DRIVE, api} from "./google.ts";
import {parse as parseDeck, serialize as serializeDeck} from "./slides-format.ts";
import {plan as planDeck} from "./slides-plan.ts";
import {fetchDeck, fetchDeckRev, pushDeck, saveDeckImages} from "./slides.ts";

export type Kind = "doc" | "slides";

// One read of the remote file: its text as goog writes it, and what the
// backend needs to plan against it.
export interface Fetched {
  text: string;
  rev?: string;
  remote: any;
}

export interface Backend {
  kind: Kind;
  noun: string; // "doc" or "deck", for messages
  url(id: string): string;
  fetch(id: string): Promise<Fetched>;
  fetchRev(id: string): Promise<string>;
  parse(text: string): any; // throws FormatError
  serialize(target: any): string;
  plan(f: Fetched, target: any): {requests: unknown[]; warnings: string[]};
  push(id: string, target: any, opts: {rev?: string; first: Fetched}): Promise<{fetched: Fetched; requests: number; warnings: string[]}>;
  saveImages(f: Fetched, dir: string): Promise<{images: string[]; slides?: string[]}>;
}

const docs: Backend = {
  kind: "doc",
  noun: "doc",
  url: (id) => `https://docs.google.com/document/d/${id}/edit`,
  async fetch(id) {
    const remote = await fetchDoc(id);
    return {text: serializeDoc(remote.doc), rev: remote.doc.rev, remote};
  },
  fetchRev,
  parse: parseDoc,
  serialize: serializeDoc,
  plan: (f, target) => planDoc(f.remote, target),
  async push(id, target, opts) {
    const res = await pushDoc(id, target, {rev: opts.rev, first: opts.first.remote});
    if (res.requests) await markChecked(id, res.remote.doc);
    return {fetched: {text: serializeDoc(res.remote.doc), rev: res.remote.doc.rev, remote: res.remote}, requests: res.requests, warnings: res.warnings};
  },
  saveImages: async (f, dir) => ({images: await saveImages((f.remote as any).api, dir)}),
};

const slides: Backend = {
  kind: "slides",
  noun: "deck",
  url: (id) => `https://docs.google.com/presentation/d/${id}/edit`,
  async fetch(id) {
    const remote = await fetchDeck(id);
    return {text: serializeDeck(remote.deck), rev: remote.deck.rev, remote};
  },
  fetchRev: fetchDeckRev,
  parse: parseDeck,
  serialize: serializeDeck,
  plan: (f, target) => planDeck(f.remote, structuredClone(target)),
  async push(id, target, opts) {
    const res = await pushDeck(id, target, {rev: opts.rev, first: opts.first.remote});
    return {fetched: {text: serializeDeck(res.remote.deck), rev: res.remote.deck.rev, remote: res.remote}, requests: res.requests, warnings: res.warnings};
  },
  saveImages: (f, dir) => saveDeckImages(f.remote, dir),
};

export const backends: Record<Kind, Backend> = {doc: docs, slides};

// The backend for a file's text (its header says which).
export const backendOfText = (text: string): Backend => backends[parseHeader(text)?.kind ?? "doc"];

const known = new Map<string, Kind>();

// The kind of a Google file. `hint` (from a URL or a file header) wins;
// otherwise Drive says. If Drive can't, it's assumed to be a doc and the Docs
// API gives the error.
export async function kindOf(id: string, hint?: Kind): Promise<Kind> {
  if (hint) known.set(id, hint);
  const k = known.get(id);
  if (k) return k;
  let kind: Kind = "doc";
  try {
    const f = await api<{mimeType: string}>("GET", `${DRIVE}/files/${encodeURIComponent(id)}?fields=mimeType&supportsAllDrives=true`);
    if (f.mimeType === "application/vnd.google-apps.presentation") kind = "slides";
  } catch {}
  known.set(id, kind);
  return kind;
}
