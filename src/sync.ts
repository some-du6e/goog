// Keeps a .goog file and its Google Doc in step.
//
// For each file goog stores the last version both sides agreed on (the base),
// keyed by the file's absolute path, so several files can follow one doc and a
// copied or `goog cat`-ed file never inherits another file's history. On push,
// your changes are base -> file; anything someone did in the browser is
// base -> doc. Both get merged line by line, like git, before writing.

import {createHash} from "node:crypto";
import {existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync} from "node:fs";
import {basename, dirname, join, resolve} from "node:path";
import {createTwoFilesPatch} from "diff";
import {diff3Merge} from "node-diff3";
import {CACHE_DIR, readJson, writeAtomic, writeJson} from "./config.ts";
import {type Kind, backendOfText, backends, kindOf} from "./backend.ts";
import {FormatError, parseHeader} from "./format.ts";
import {ApiError} from "./google.ts";

// ---------- refs ----------

export interface Ref {
  id: string;
  kind?: Kind; // unset for a bare id; kindOf() asks Drive
  file?: string;
}

// Accepts a doc id, a .goog file, or any of the URL shapes Google hands out:
// docs.google.com/document/d/ID/edit?tab=t.0, /document/u/1/d/ID, ?usp=sharing,
// docs.google.com/open?id=ID, drive.google.com/file/d/ID/view, drive.google.com/open?id=ID.
export function resolveRef(arg: string): Ref {
  arg = arg.trim();
  if (/^https?:\/\/|^(docs|drive)\.google\.com\//.test(arg)) {
    const u = new URL(/^https?:/.test(arg) ? arg : `https://${arg}`);
    if (!/(^|\.)google\.com$/.test(u.hostname)) throw new Error(`"${arg}" isn't a Google Docs or Drive URL`);
    const path = u.pathname.replace(/\/u\/\d+(?=\/)/, "");
    if (/\/d\/e\//.test(path)) throw new Error(`that's a "published to the web" link, which has a different id from the doc; open the doc itself and copy its URL from the address bar`);
    const m = /^\/(document|presentation|spreadsheets|file|drawings|forms)\/d\/([\w-]+)/.exec(path);
    const id = m?.[2] ?? u.searchParams.get("id");
    if (!id) throw new Error(`can't find a doc id in "${arg}"`);
    const kind = m?.[1];
    if (kind === "spreadsheets") throw new Error("Sheets aren't supported yet; only Docs and Slides for now");
    if (kind && !["document", "presentation", "file"].includes(kind)) throw new Error(`that's a Google ${kind.replace(/s$/, "")}, not a doc`);
    // open?id= and drive.google.com/file links don't say; kindOf() asks Drive.
    return kind === "presentation" ? {id, kind: "slides"} : kind === "document" ? {id, kind: "doc"} : {id};
  }
  if (arg.endsWith(".goog") || existsSync(arg)) {
    if (!existsSync(arg)) throw new Error(`${arg} doesn't exist`);
    if (statSync(arg).isDirectory()) throw new Error(`${arg} is a directory`);
    const h = parseHeader(readText(arg).text);
    if (!h) throw new Error(`${arg} has no goog header on its first line (like <!-- goog doc DOC_ID -->)`);
    return {id: h.id, kind: h.kind, file: arg};
  }
  if (/^[\w-]{20,}$/.test(arg)) return {id: arg};
  throw new Error(`"${arg}" isn't a doc id, Google Docs URL, or .goog file`);
}

// ---------- file text ----------

export interface FileText {
  raw: string;
  text: string; // BOM stripped, \n line endings
  crlf: boolean;
  hash: string;
}

export const hashText = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export function readText(file: string): FileText {
  const raw = readFileSync(file, "utf8");
  return {raw, text: raw.replace(/^﻿/, "").replace(/\r\n/g, "\n"), crlf: /\r\n/.test(raw), hash: hashText(raw)};
}

// Writes atomically (temp file + rename), through symlinks, keeping the mode
// and the file's line endings. Returns the hash of what was written.
export function writeText(file: string, text: string, crlf = false): string {
  let target = file;
  let mode: number | undefined;
  try {
    target = realpathSync(file);
    mode = statSync(target).mode & 0o7777;
  } catch {
    mkdirSync(dirname(file), {recursive: true});
  }
  const raw = crlf ? text.replace(/\n/g, "\r\n") : text;
  writeAtomic(target, raw, mode);
  return hashText(raw);
}

export const bodyOf = (text: string) => (text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "");
const headOf = (text: string) => (text.includes("\n") ? text.slice(0, text.indexOf("\n") + 1) : text + "\n");

// The body as goog would write it: blank lines, spacing and trailing newline
// stop mattering. Throws FormatError.
export const canonBody = (text: string) => {
  const be = backendOfText(text);
  return bodyOf(be.serialize(be.parse(text)));
};

const MARKER = /^(<{7}|={7}|>{7})( |$)/m;
export const hasConflictMarkers = (text: string) => MARKER.test(text);

// ---------- base and state records ----------

export const keyOf = (file: string) => hashText(resolve(file));
const basePath = (file: string) => join(CACHE_DIR, "base", `${keyOf(file)}.json`);
const statePath = (file: string) => join(CACHE_DIR, "state", `${keyOf(file)}.json`);
export const logPath = (file: string) => join(CACHE_DIR, "log", `${keyOf(file)}.log`);

export interface Base {
  id: string;
  file: string;
  text: string; // serialized doc as of the last sync
  rev?: string;
  at?: string;
}

export function readBase(file: string, id?: string): Base | null {
  const b = readJson<Base | null>(basePath(file), null);
  if (b?.text !== undefined) return b;
  // Before per-file records, bases were per doc: base/<id>.goog for <id>.goog.
  if (id && basename(file) === `${id}.goog`) {
    const legacy = readJson<{text?: string; rev?: string} | null>(join(CACHE_DIR, "base", `${id}.goog`), null);
    if (legacy?.text) return {id, file: resolve(file), text: legacy.text, rev: legacy.rev};
  }
  return null;
}

export function writeBase(file: string, b: Omit<Base, "file" | "at">) {
  writeJson(basePath(file), {...b, file: resolve(file), at: new Date().toISOString()});
}

export function forgetBase(file: string) {
  rmSync(basePath(file), {force: true});
}

export type Status = "starting" | "synced" | "pushing" | "pulling" | "error" | "conflict" | "offline" | "retrying" | "stopped";

export interface SyncState {
  status: Status;
  id: string;
  file: string;
  pid: number;
  hash?: string; // hash of the file content this status is about
  message?: string;
  line?: number;
  at: string;
}

export function setState(file: string, s: Omit<SyncState, "at" | "file">) {
  writeJson(statePath(file), {...s, file: resolve(file), at: new Date().toISOString()});
}

export function readState(file: string): SyncState | null {
  return readJson<SyncState | null>(statePath(file), null);
}

export function listStates(): SyncState[] {
  const dir = join(CACHE_DIR, "state");
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {}
  const out: SyncState[] = [];
  for (const n of names) {
    const s = readJson<SyncState | null>(join(dir, n), null);
    if (s?.file && s.id) out.push(s);
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export function forgetState(file: string) {
  rmSync(statePath(file), {force: true});
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

// The live `goog edit` for a file, if there is one.
export function watcherOf(file: string): SyncState | null {
  const s = readState(file);
  return s && s.status !== "stopped" && isAlive(s.pid) ? s : null;
}

// ---------- merging ----------

export interface Merge {
  text: string;
  conflicts: number;
}

// Three-way merge of whole files; the header comes from `ours`.
export function merge3(ours: string, base: string, theirs: string): Merge {
  const lines = (s: string) => bodyOf(s).split("\n");
  const out: string[] = [];
  let conflicts = 0;
  for (const region of diff3Merge(lines(ours), lines(base), lines(theirs), {excludeFalseConflicts: true})) {
    if (region.ok) out.push(...region.ok);
    else if (region.conflict) {
      const {a, o, b} = region.conflict as {a: string[]; o: string[]; b: string[]};
      // diff3 treats changes to neighbouring lines as one conflict. When no
      // lines were added or removed, each line can be merged on its own, so a
      // paragraph edited in the browser next to one edited in the file is fine.
      const pieces: (string | {a: string[]; b: string[]})[] = [];
      if (a.length === o.length && b.length === o.length) {
        for (let i = 0; i < o.length; i++) {
          if (a[i] === o[i] || a[i] === b[i]) pieces.push(b[i]);
          else if (b[i] === o[i]) pieces.push(a[i]);
          else {
            const last = pieces.at(-1);
            if (typeof last === "object") {
              last.a.push(a[i]);
              last.b.push(b[i]);
            } else pieces.push({a: [a[i]], b: [b[i]]});
          }
        }
      } else pieces.push({a, b});
      for (const p of pieces) {
        if (typeof p === "string") out.push(p);
        else {
          conflicts++;
          out.push("<<<<<<< your file", ...p.a, "=======", ...p.b, ">>>>>>> google doc");
        }
      }
    }
  }
  return {text: headOf(ours) + out.join("\n"), conflicts};
}

export type Action =
  | {action: "none"} // the file already matches the doc
  | {action: "pull"; text: string} // only the doc changed
  | {action: "push"; text: string; merged: boolean; noBase: boolean}
  | {action: "conflict"; text: string; conflicts: number};

// Decides what a sync should do. `ours` is the file, `theirs` the doc as goog
// writes it, `base` the last agreed version (null if this file never synced).
// Pure, so it's tested offline. Throws FormatError if `ours` doesn't parse.
export function reconcile(ours: string, base: string | null, theirs: string): Action {
  const head = headOf(ours);
  const o = canonBody(ours);
  const t = bodyOf(theirs);
  if (o === t) return {action: "none"};
  // No history: the file is what the caller wants the doc to be.
  if (base === null) return {action: "push", text: head + o, merged: false, noBase: true};
  const b = bodyOf(base);
  if (o === b) return {action: "pull", text: theirs};
  if (t === b) return {action: "push", text: head + o, merged: false, noBase: false};
  const m = merge3(head + o, base, theirs);
  if (m.conflicts) return {action: "conflict", text: m.text, conflicts: m.conflicts};
  if (bodyOf(m.text) === t) return {action: "pull", text: theirs};
  return {action: "push", text: m.text, merged: true, noBase: false};
}

// ---------- pull / push ----------

export class SyncError extends Error {}

function checkHeader(file: string, ft: FileText, id: string | undefined) {
  const h = parseHeader(ft.text);
  if (!h) throw new FormatError(1, `the first line must be the goog header; put back <!-- goog doc ${id ?? "DOC_ID"} --> (or goog slides, for a deck)`);
  if (id && h.id !== id) {
    throw new SyncError(`${file} is synced with ${id}, but its first line now names ${h.id}. Put back <!-- goog ${h.kind} ${id} --> (or run goog pull ${h.id} -o ${file} --force to make this file follow that one).`);
  }
  return h;
}

export interface PullResult {
  file: string;
  id: string;
  hash: string;
  replaced: boolean;
  images: string[]; // saved copies of the doc's images, see imagesDir
  slides?: string[]; // a deck's slides as pictures, slide-1.png, …
}

// Where pull saves a file's images: cer.goog -> cer.files/
export function imagesDir(file: string): string {
  return file.replace(/\.goog$/, "") + ".files";
}

export async function pull(id: string, file: string, opts: {force?: boolean; kind?: Kind} = {}): Promise<PullResult> {
  let crlf = false;
  let kind = opts.kind;
  let noBase: string | undefined; // the file's text, when it has no base to check it against
  const exists = existsSync(file);
  if (exists) {
    const ft = readText(file);
    crlf = ft.crlf;
    const fh = parseHeader(ft.text);
    if (!kind && fh?.id === id) kind = fh.kind;
    if (!opts.force) {
      const h = parseHeader(ft.text);
      if (h && h.id !== id) throw new SyncError(`${file} belongs to doc ${h.id}, not ${id}; leave out -o to pull into ${id}.goog, or pass --force to overwrite it`);
      const base = readBase(file, id);
      if (base && base.id === id) {
        let dirty = true;
        try {
          dirty = canonBody(ft.text) !== bodyOf(base.text);
        } catch {}
        if (dirty) throw new SyncError(`${file} has changes that aren't in the doc yet; goog push sends them (merging with edits made in the doc), or pass --force to throw them away`);
      } else noBase = ft.text;
    }
  }
  const be = backends[await kindOf(id, kind)];
  const remote = await be.fetch(id);
  const text = remote.text;
  if (noBase !== undefined) {
    // Never synced (or its record is gone): only a file that already says what
    // the doc says can be replaced without --force.
    let same = false;
    try {
      same = canonBody(noBase) === bodyOf(text);
    } catch {}
    if (!same) throw new SyncError(`${file} already exists, differs from the doc, and goog has no record of syncing it; goog diff ${file} shows the difference, goog push ${file} makes the doc match it, or pass --force to replace it with the doc`);
  }
  const hash = writeText(file, text, crlf);
  writeBase(file, {id, text, rev: remote.rev});
  // Images are a convenience; a failed download doesn't fail the pull.
  const pics = await be.saveImages(remote, imagesDir(file)).catch((): {images: string[]; slides?: string[]} => ({images: []}));
  return {file, id, hash, replaced: exists, images: pics.images, ...(pics.slides ? {slides: pics.slides} : {})};
}

export interface PushOutcome {
  file: string;
  id: string;
  status: "unchanged" | "pulled" | "pushed" | "conflict";
  dryRun: boolean;
  requests: number; // batchUpdate requests sent (or that would be, first pass, with --dry-run)
  merged: boolean; // the push included edits made in the doc since the last sync
  rewrote: boolean; // the file was rewritten (to match the doc, or with conflict markers)
  noBase: boolean; // this file had never been synced, so it simply replaced the doc
  conflicts: number;
  warnings: string[];
  hash: string; // hash of the file content as goog left it
  planned?: unknown[]; // --dry-run: the first batch of requests
  patch?: string; // --dry-run: what would change in the doc, as a unified diff
}

const isRevisionClash = (e: unknown) => e instanceof ApiError && e.status === 400 && /required revision/i.test(e.message);

export async function push(file: string, opts: {dryRun?: boolean; expectId?: string} = {}): Promise<PushOutcome> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await pushOnce(file, opts);
    } catch (e) {
      // Someone edited the doc between our read and our write; merge again.
      if (isRevisionClash(e) && attempt < 3) continue;
      throw e;
    }
  }
}

async function pushOnce(file: string, opts: {dryRun?: boolean; expectId?: string}): Promise<PushOutcome> {
  if (!existsSync(file)) throw new SyncError(`${file} doesn't exist`);
  const dryRun = !!opts.dryRun;
  const ours = readText(file);
  const head = checkHeader(file, ours, opts.expectId);
  const id = head.id;
  const base = readBase(file, id);
  if (base && base.id !== id) {
    throw new SyncError(`${file} was synced with doc ${base.id}, but its first line now names doc ${id}. Put back <!-- goog doc ${base.id} -->, or run goog pull ${id} -o ${file} --force to make this file follow that doc.`);
  }
  const be = backends[head.kind];
  if (hasConflictMarkers(ours.text)) be.parse(ours.text); // throws a FormatError pointing at the marker
  const remote = await be.fetch(id);
  const theirs = remote.text;
  const act = reconcile(ours.text, base?.text ?? null, theirs);
  const out: PushOutcome = {
    file, id, status: "unchanged", dryRun, requests: 0, merged: false, rewrote: false, noBase: !base, conflicts: 0, warnings: [], hash: ours.hash,
  };
  const save = (text: string, rev?: string) => {
    if (!dryRun) writeBase(file, {id, text, rev});
  };
  // The file was saved again while the doc was read: rewriting it would lose
  // that save. Leave everything as it was; the next sync starts over from it.
  const savedSince = () => (existsSync(file) ? readText(file).raw : null) !== ours.raw;
  if (act.action === "none") {
    save(theirs, remote.rev);
    return out;
  }
  if (act.action === "pull") {
    if (dryRun) return {...out, status: "pulled", patch: patch(file, headOf(ours.text) + canonBody(ours.text), act.text, "file", "doc")};
    if (savedSince()) return out;
    out.hash = writeText(file, act.text, ours.crlf);
    save(theirs, remote.rev);
    return {...out, status: "pulled", rewrote: true};
  }
  if (act.action === "conflict") {
    if (dryRun) return {...out, status: "conflict", conflicts: act.conflicts};
    if (savedSince()) return out;
    out.hash = writeText(file, act.text, ours.crlf);
    // The doc as it is now becomes the base: once the markers are resolved,
    // the resolved file is pushed over it, the way a merge commit works.
    save(theirs, remote.rev);
    return {...out, status: "conflict", rewrote: true, conflicts: act.conflicts};
  }
  out.merged = act.merged;
  const target = be.parse(act.text);
  if (dryRun) {
    const p = be.plan(remote, target);
    return {
      ...out, status: p.requests.length ? "pushed" : "unchanged", requests: p.requests.length, warnings: p.warnings,
      planned: p.requests, patch: patch(file, theirs, act.text, "doc", "after push"),
    };
  }
  const res = await be.push(id, target, {rev: remote.rev, first: remote});
  out.requests = res.requests;
  out.warnings = res.warnings;
  out.status = res.requests ? "pushed" : "unchanged";
  const final = res.fetched.text;
  if (!savedSince()) {
    // Rewrite the file only if the doc came out different from it (a merge, or
    // something Docs normalized).
    if (bodyOf(final) !== canonBody(ours.text)) {
      out.hash = writeText(file, headOf(ours.text) + bodyOf(final), ours.crlf);
      out.rewrote = true;
    }
    save(final, res.fetched.rev);
  } else {
    // The file was saved again while we pushed. Its new content descends from
    // what we read, so that's the base the next sync merges against, and any
    // browser edits merged into `final` aren't mistaken for deletions.
    // out.hash stays the pushed content's, so the newer save still counts as
    // unpushed (goog wait keeps waiting, the watcher pushes it next).
    save(headOf(ours.text) + canonBody(ours.text), undefined);
  }
  return out;
}

export function patch(file: string, from: string, to: string, fromLabel: string, toLabel: string): string {
  return createTwoFilesPatch(`${file} (${fromLabel})`, `${file} (${toLabel})`, from, to, undefined, undefined, {context: 2})
    .split("\n").slice(1).join("\n"); // drop the "====" line
}

export {FormatError};
