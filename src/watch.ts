// `goog edit`: keeps a .goog file live-synced with its doc until stopped.
//
// Saves are noticed by fs.watch on the directory (which also sees editors that
// save by writing a temp file and renaming it over the original) plus a cheap
// stat every second as a backstop. The doc is polled for a new revision. Every
// status written to the state file carries the hash of the file content it's
// about, so `goog wait` can tell a fresh "synced" from one about an older save.

import {appendFileSync, existsSync, mkdirSync, statSync, truncateSync, watch, type FSWatcher} from "node:fs";
import {basename, dirname, resolve} from "node:path";
import {type Kind, backends, kindOf} from "./backend.ts";
import {FormatError, markerLine, parseHeader} from "./format.ts";
import {ApiError, setRetryListener} from "./google.ts";
import {
  bodyOf, canonBody, hasConflictMarkers, logPath, pull, push, readBase, readState, readText, setState, SyncError,
  watcherOf, writeBase, type Status,
} from "./sync.ts";

export interface EditOptions {
  pollSeconds: number;
  json: boolean;
  quiet?: boolean; // background mode: only the log file
  onExisting?: "pull" | "push"; // what to do with a file goog has no record of
  kind?: Kind; // when the doc's URL said
}

const MAX_LOG = 1 << 20;

export async function edit(id: string, fileArg: string, opts: EditOptions) {
  const file = resolve(fileArg);
  const name = basename(file);
  const other = watcherOf(file);
  if (other && other.pid !== process.pid) {
    throw new Error(`${file} is already being synced by goog edit (pid ${other.pid}); goog stop ${fileArg} ends it`);
  }

  const logFile = logPath(file);
  mkdirSync(dirname(logFile), {recursive: true});
  try {
    if (statSync(logFile).size > MAX_LOG) truncateSync(logFile, 0);
  } catch {}
  let lastMsg = "";
  const log = (event: string, message: string, extra: Record<string, unknown> = {}) => {
    const at = new Date().toISOString();
    const line = JSON.stringify({at, event, message, file, ...extra});
    try {
      appendFileSync(logFile, line + "\n");
    } catch {}
    if (opts.quiet) return;
    if (opts.json) console.log(line);
    else console.log(`${new Date().toTimeString().slice(0, 8)} ${event} ${message}`);
  };
  // Repeated failures (offline, no access) are logged once, not every poll.
  const logOnce = (event: string, message: string, extra: Record<string, unknown> = {}) => {
    if (message === lastMsg) return;
    lastMsg = message;
    log(event, message, extra);
  };

  let status: Status = "starting";
  const state = (s: Status, hash: string | undefined, message?: string, line?: number) => {
    status = s;
    setState(file, {status: s, id, pid: process.pid, hash, message, line});
  };
  state("starting", undefined);
  const fileKind = existsSync(file) ? parseHeader(readText(file).text) : null;
  const kind = await kindOf(id, opts.kind ?? (fileKind?.id === id ? fileKind.kind : undefined));
  const be = backends[kind];
  log("·", `${name} <-> ${be.url(id)}`, {id, pid: process.pid});

  setRetryListener(({message, delayMs}) => logOnce("…", `${message}; retrying in ${Math.round(delayMs / 1000)}s`));

  // ---------- startup ----------
  let lastHash: string | undefined; // file content the current status is about
  try {
    if (!existsSync(file)) {
      state("pulling", undefined);
      lastHash = (await pull(id, file, {kind})).hash;
      log("↓", `pulled into ${file}`);
      state("synced", lastHash);
    } else if (!readBase(file, id)) {
      const ft = readText(file);
      const remote = await be.fetch(id);
      const theirs = remote.text;
      let same = false;
      try {
        same = canonBody(ft.text) === bodyOf(theirs);
      } catch {}
      if (same) {
        writeBase(file, {id, text: theirs, rev: remote.rev});
        log("·", `${name} already matches the doc`);
      } else if (opts.onExisting === "pull") {
        lastHash = (await pull(id, file, {force: true, kind})).hash;
        log("↓", `replaced ${name} with the doc`);
      } else if (opts.onExisting !== "push") {
        state("stopped", ft.hash, "file exists without a sync record");
        throw new Error(`${fileArg} already exists, differs from the doc, and goog has no record of syncing it, so it can't tell which side is newer.
    goog edit ${fileArg} --pull   replace the file with the doc, then sync
    goog edit ${fileArg} --push   make the doc match the file, then sync
    goog diff ${fileArg}          see what differs first`);
      }
    }
  } catch (e: any) {
    if (readState(file)?.status !== "stopped") state("stopped", undefined, e?.message);
    throw e;
  }

  // ---------- the sync loop ----------
  let busy = false;
  let pending = false;
  let remoteChanged = false;
  let stopping = false;
  let failures = 0;
  let retryAt = 0;

  async function step() {
    if (!existsSync(file)) {
      if (status !== "error" || lastHash !== undefined) {
        lastHash = undefined;
        state("error", undefined, "the file is missing");
        log("✗", `${name} was deleted or moved. Nothing was sent to the doc. Recreate it (goog pull ${id} -o ${fileArg}) or stop with ${opts.quiet ? `goog stop ${fileArg}` : "Ctrl+C"}.`);
      }
      return;
    }
    const ft = readText(file);
    const retrying = retryAt > 0 && Date.now() >= retryAt;
    if (ft.hash === lastHash && !remoteChanged && !retrying) return;
    if (ft.text.trim() === "") {
      // Usually an editor mid-save, and the real content follows. Never pushed as an empty doc.
      lastHash = ft.hash;
      state("error", ft.hash, `${name} is empty; nothing was pushed`);
      return;
    }
    const head = parseHeader(ft.text);
    if (head?.id !== id) {
      lastHash = ft.hash;
      const msg = head
        ? `the first line of ${name} now names doc ${head.id}, but this goog edit syncs doc ${id}; put back <!-- goog doc ${id} --> (nothing was pushed)`
        : `the first line of ${name} must be the goog header; put back <!-- goog doc ${id} --> (nothing was pushed)`;
      state("error", ft.hash, msg, 1);
      logOnce("✗", msg, {line: 1});
      return;
    }
    const base = readBase(file, id);
    if (!remoteChanged && !retrying) {
      // A save that doesn't change anything (or one goog wrote) needs no request.
      try {
        if (base && canonBody(ft.text) === bodyOf(base.text)) {
          lastHash = ft.hash;
          state("synced", ft.hash);
          lastMsg = "";
          return;
        }
      } catch {}
    }
    if (hasConflictMarkers(ft.text)) {
      lastHash = ft.hash;
      const line = markerLine(ft.text);
      state("conflict", ft.hash, `unresolved conflict markers (first at line ${line})`, line);
      logOnce("!", `${name} still has conflict markers (line ${line}); not pushed. Keep the version you want, delete the <<<<<<< ======= >>>>>>> lines, and save.`);
      return;
    }
    remoteChanged = false;
    retryAt = 0;
    state("pushing", ft.hash);
    try {
      const r = await push(file, {expectId: id});
      failures = 0;
      lastMsg = "";
      lastHash = r.hash;
      for (const w of r.warnings) log("⚠", w);
      if (r.status === "conflict") {
        state("conflict", r.hash, `${r.conflicts} conflict(s) with edits made in the doc`);
        log("!", `the doc changed in the same places you did: ${r.conflicts} conflict(s) marked in ${name} with <<<<<<< your file / ======= / >>>>>>> google doc. Keep what you want, delete the marker lines, and save; that version is pushed.`, {conflicts: r.conflicts});
        return;
      }
      if (r.status === "pushed") {
        log("↑", `pushed (${r.requests} edit${r.requests === 1 ? "" : "s"})${r.merged ? ", merged with browser edits" : ""}${r.rewrote ? `; ${name} updated to match the doc` : ""}`, {requests: r.requests, merged: r.merged});
      } else if (r.status === "pulled") log("↓", `pulled edits made in the doc into ${name}`);
      // Kept on the synced state so goog wait shows what Docs couldn't take.
      state("synced", r.hash, r.warnings.length ? `warnings: ${r.warnings.join("; ")}` : undefined);
    } catch (e: any) {
      if (e instanceof FormatError) {
        lastHash = ft.hash;
        state("error", ft.hash, e.message, e.line);
        logOnce("✗", `${name} ${e.message} (not pushed; fix it and save)`, {line: e.line});
      } else if (e instanceof SyncError || (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429 && !/required revision/i.test(e.message))) {
        // Needs a person: no access, wrong header, doc gone. Try again when something changes.
        lastHash = ft.hash;
        state("error", ft.hash, e.message);
        logOnce("✗", e.message);
      } else {
        // Network, rate limit, Google having a moment, Chrome for the token: retry with backoff.
        failures++;
        const delay = Math.min(5000 * 2 ** (failures - 1), 120_000);
        retryAt = Date.now() + delay;
        const temporary = e instanceof ApiError && (e.status === 429 || e.status >= 500 || /required revision/i.test(e.message));
        state(e instanceof ApiError && e.status === 0 ? "offline" : temporary ? "retrying" : "error", ft.hash, e.message);
        logOnce("✗", `${e.message}; will retry (every ${Math.round(delay / 1000)}s at most)`);
      }
    }
  }

  async function run() {
    if (busy) {
      pending = true;
      return;
    }
    busy = true;
    try {
      do {
        pending = false;
        await step();
      } while (pending && !stopping);
    } catch (e: any) {
      log("✗", `unexpected: ${e?.stack ?? e}`);
    } finally {
      busy = false;
    }
  }

  // ---------- triggers ----------
  let debounce: NodeJS.Timeout | undefined;
  const kick = (ms = 250) => {
    if (stopping) return;
    clearTimeout(debounce);
    debounce = setTimeout(run, ms);
  };

  let watcher: FSWatcher | undefined;
  const startWatcher = () => {
    try {
      watcher = watch(dirname(file), (_e, n) => {
        if (!n || n === name) kick();
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      watcher = undefined;
    }
  };
  startWatcher();

  let seen = "";
  const fingerprint = () => {
    try {
      const s = statSync(file);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return "missing";
    }
  };
  seen = fingerprint();
  const local = setInterval(() => {
    if (!watcher) startWatcher();
    const f = fingerprint();
    if (f !== seen) {
      seen = f;
      kick();
    }
    if (retryAt && Date.now() >= retryAt && !busy) run();
  }, 1000);

  let polling = false;
  const poll = setInterval(async () => {
    if (busy || polling || stopping || (retryAt && Date.now() < retryAt)) return;
    polling = true;
    try {
      const rev = await be.fetchRev(id);
      if (status === "offline") {
        log("·", "back online");
        lastMsg = "";
        // A push that failed offline is retried now. Otherwise this poll's
        // failure set offline, and only on a synced file.
        if (retryAt) {
          retryAt = Date.now();
          run();
        } else state("synced", lastHash);
      }
      if (rev !== readBase(file, id)?.rev) {
        remoteChanged = true;
        run();
      }
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 0 && status === "synced") state("offline", lastHash, e.message);
      logOnce("✗", `checking the doc failed: ${e.message}`);
    } finally {
      polling = false;
    }
  }, opts.pollSeconds * 1000);

  remoteChanged = true; // pick up anything done in the browser while nobody was watching
  await run();
  log("·", `watching ${file}; edit and save. ${opts.quiet ? "goog stop" : "Ctrl+C"} to stop.`);

  // ---------- shutdown ----------
  await new Promise<void>((done) => {
    let signals = 0;
    const stop = async (sig: string) => {
      if (++signals > 1) {
        state("stopped", lastHash, "interrupted");
        log("·", "stopped without finishing");
        process.exit(130);
      }
      stopping = true;
      watcher?.close();
      clearInterval(local);
      clearInterval(poll);
      clearTimeout(debounce);
      if (busy && !opts.quiet) log("·", `${sig}: finishing the push in progress (again to quit now)`);
      while (busy) await new Promise((r) => setTimeout(r, 100));
      stopping = false;
      if (status !== "offline") await step();
      setRetryListener(undefined);
      state("stopped", lastHash);
      log("·", "stopped");
      done();
    };
    process.on("SIGINT", () => stop("Ctrl+C"));
    process.on("SIGTERM", () => stop("stopping"));
    process.on("SIGHUP", () => stop("hangup"));
  });
}
