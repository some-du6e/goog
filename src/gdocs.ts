import {mkdirSync, readdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {ApiError, DOCS, DRIVE, api} from "./google.ts";
import {fromApi} from "./gdocs-read.ts";
import {CHECKS_WARNING, adoptNew, plan, typeable, type Plan, type PlanRemote} from "./gdocs-plan.ts";
import {chunks, flubs, type Typing} from "./typing.ts";
import type {Block, Doc, Para} from "./model.ts";

export function toRemote(raw: any): PlanRemote {
  const remote: PlanRemote = fromApi(raw);
  // The planner reads image content URIs and named style defaults from it.
  Object.defineProperty(remote, "api", {value: raw, enumerable: false});
  return remote;
}

export async function fetchDoc(id: string): Promise<PlanRemote> {
  const remote = toRemote(await api("GET", `${DOCS}/${encodeURIComponent(id)}?includeTabsContent=true`));
  await markChecked(id, remote.doc);
  return remote;
}

// The Docs API doesn't say which checklist items are ticked, but Drive's
// markdown export does ("- [x]"). Its checklist lines are matched to the
// doc's in order; if the counts differ (a checklist in a table, say), nothing
// is marked rather than marking the wrong ones.
export async function markChecked(id: string, doc: Doc): Promise<boolean> {
  const items: Para[] = [];
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.type === "para" && b.list?.glyph === "check") items.push(b);
      if (b.type === "table") for (const row of b.rows) for (const c of row) walk(c);
    }
  };
  for (const t of doc.tabs ?? [{blocks: doc.blocks}]) walk(t.blocks);
  if (!items.length) return true;
  let md: string;
  try {
    md = await api<string>("GET", `${DRIVE}/files/${encodeURIComponent(id)}/export?mimeType=text%2Fmarkdown`, undefined, {text: true});
  } catch {
    return false;
  }
  const ticks = [...md.matchAll(/^[ \t>]*[-*+] \[([ xX])\] /gm)].map((m) => m[1] !== " ");
  if (ticks.length !== items.length) return false;
  items.forEach((p, k) => {
    if (ticks[k]) p.list!.checked = true;
  });
  return true;
}

// Saves each image in the doc as <dir>/<object id>.<ext>, so an agent can look
// at the pictures it's writing about. Images already saved are skipped (an id
// always names the same picture). Returns the paths of every image in the doc.
export async function saveImages(raw: any, dir: string): Promise<string[]> {
  const uris = new Map<string, string>();
  const walk = (t: any) => {
    for (const objs of [t?.inlineObjects, t?.positionedObjects]) {
      for (const [id, o] of Object.entries<any>(objs ?? {})) {
        const p = o.inlineObjectProperties ?? o.positionedObjectProperties;
        const uri = p?.embeddedObject?.imageProperties?.contentUri;
        if (uri) uris.set(id, uri);
      }
    }
  };
  walk(raw);
  const tabs = (ts: any[] = []) => ts.forEach((t) => (walk(t.documentTab), tabs(t.childTabs)));
  tabs(raw.tabs);
  if (!uris.size) return [];
  mkdirSync(dir, {recursive: true});
  const have = new Map(readdirSync(dir).map((f) => [f.replace(/\.[^.]*$/, ""), f]));
  const out: string[] = [];
  for (const [id, uri] of uris) {
    let f = have.get(id);
    if (!f) {
      const r = await api<{type: string; data: Buffer}>("GET", uri, undefined, {bytes: true});
      f = `${id}.${EXT[r.type.split(";")[0]] ?? "img"}`;
      writeFileSync(join(dir, f), r.data);
    }
    out.push(join(dir, f));
  }
  return out;
}

const EXT: Record<string, string> = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg"};

// How pushDoc talks to Docs; tests swap in a simulator.
export interface DocsIO {
  get(id: string): Promise<any>;
  batch(id: string, body: {requests: any[]; writeControl?: any}): Promise<{replies?: any[]; writeControl?: {requiredRevisionId?: string}}>;
}

const LIVE: DocsIO = {
  get: (id) => api("GET", `${DOCS}/${encodeURIComponent(id)}?includeTabsContent=true`),
  batch: (id, body) => api("POST", `${DOCS}/${encodeURIComponent(id)}:batchUpdate`, body),
};

export async function fetchRev(id: string): Promise<string> {
  const j = await api<{revisionId: string}>("GET", `${DOCS}/${encodeURIComponent(id)}?fields=revisionId`);
  return j.revisionId;
}

export interface PushResult {
  remote: PlanRemote;
  requests: number;
  passes: number;
  warnings: string[];
}

const MAX_PASSES = 8;

// Edits the remote doc until it matches `target`. `rev` guards the first write:
// if someone else edited the doc after that revision, Docs rejects it. Later
// passes are guarded the same way, and an edit that lands between a write and
// the next read stops the push too, rather than being planned away. Both
// throw an ApiError whose message mentions "required revision".
//
// With `typing`, text is typed in instead (see typeBatch), a paragraph a pass,
// so passes that type don't count towards MAX_PASSES. `onPass` sees each plan,
// and `onWrote` the doc after each pass's writes.
export async function pushDoc(
  id: string,
  target: Doc | Block[],
  opts: {rev?: string; first?: PlanRemote; onPass?: (p: Plan, pass: number) => void; onWrote?: (remote: PlanRemote) => void; io?: DocsIO; typing?: Typing; onSignal?: () => Promise<void>} = {},
): Promise<PushResult> {
  const io = opts.io ?? LIVE;
  // A typed pass runs for minutes, so Ctrl+C or a kill lands mid-pass far more
  // often than between passes. Save where the typing got to (like the catch
  // below does for a failed write) so the next push resumes instead of
  // conflicting, then re-signal so the exit code still says how we died. Both
  // listeners come off first: with them still on, the re-kill would re-enter
  // this handler (and loop forever), and a second impatient Ctrl+C would start
  // another fetch instead of forcing the exit it expects.
  const onSignal = async (sig: "SIGINT" | "SIGTERM") => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await opts.onSignal?.();
    process.kill(process.pid, sig);
  };
  if (opts.onSignal) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  try {
    return await pushDocPasses(id, target, opts, io);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function pushDocPasses(
  id: string,
  target: Doc | Block[],
  opts: {rev?: string; first?: PlanRemote; onPass?: (p: Plan, pass: number) => void; onWrote?: (remote: PlanRemote) => void; io?: DocsIO; typing?: Typing},
  io: DocsIO,
): Promise<PushResult> {
  // New objects get their ids written into this copy as they're created.
  const want = structuredClone(target);
  let remote = opts.first ?? toRemote(await io.get(id));
  let requests = 0;
  let last = "";
  let left = MAX_PASSES;
  const warnings: string[] = [];
  for (let pass = 0; ; pass++) {
    if (!left) {
      warnings.push(`stopped after ${MAX_PASSES} passes; the doc may not match the file exactly`);
      return {remote, requests, passes: pass, warnings};
    }
    const p = plan(remote, want, {typing: !!opts.typing});
    opts.onPass?.(p, pass);
    // Only the first read knows which items are ticked (see markChecked), so
    // only it can tell whether the file ticks differently; backend.ts checks
    // the doc as it ended up.
    for (const w of p.warnings) if (!warnings.includes(w) && (pass === 0 || w !== CHECKS_WARNING)) warnings.push(w);
    if (p.pass === "done") return {remote, requests, passes: pass, warnings};
    const sig = JSON.stringify(p.requests);
    if (sig === last) {
      warnings.push("some changes can't be made in Google Docs; the file shows what the doc ended up with");
      return {remote, requests, passes: pass, warnings};
    }
    last = sig;
    const rev = pass === 0 ? opts.rev ?? remote.doc.rev : remote.doc.rev;
    const typed = !!opts.typing && p.requests.some((r) => typeable(r) || r.insertText?.text.includes("\n"));
    if (!typed) left--;
    const res = await (async () => {
      try {
        return opts.typing
          ? await typeBatch(io, id, p.requests, rev, opts.typing)
          : await io.batch(id, {requests: p.requests, writeControl: rev ? {requiredRevisionId: rev} : undefined});
      } catch (e) {
        // A mid-typing failure leaves the doc between the base and the file;
        // save where it got to so the next push resumes instead of conflicting.
        if (opts.onWrote) {
          try {
            opts.onWrote(toRemote(await io.get(id)));
          } catch {
            // the doc's gone or unreadable; the original error says more
          }
        }
        throw e;
      }
    })();
    requests += p.requests.length;
    for (const c of p.created) c.apply(res.replies?.[p.requests.indexOf(c.req)]);
    remote = toRemote(await io.get(id));
    adoptNew(want, remote.doc, p.chips);
    const after = res.writeControl?.requiredRevisionId;
    if (after && remote.doc.rev && after !== remote.doc.rev) {
      throw new ApiError(400, `required revision changed during push: the doc was edited after goog's write (pass ${pass + 1}); merge again and retry`);
    }
    opts.onWrote?.(remote);
  }
}

// Sends a batch with each long insertText typed in: split into chunks (see
// typing.ts), each its own write at the index the one before it ended. The
// requests around it go as they are, so every later request finds its index
// where the batch expected it. Each write is guarded by the revision the one
// before it made, so an edit made in the doc meanwhile stops the push.
//
// A 400 "required revision" can mean two things: Docs forgot the revision (a
// server tick; observed live — the doc's rev is still ours), or someone else
// edited (the rev has moved on). Only the first is retried, once, without the
// guard; the second rethrows so the push stops instead of typing into the
// other edit.
async function typeBatch(io: DocsIO, id: string, requests: any[], rev: string | undefined, t: Typing) {
  const sleep = t.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const replies: any[] = [];
  let guard = rev;
  const send = async (reqs: any[]): Promise<any[]> => {
    try {
      const res = await io.batch(id, {requests: reqs, writeControl: guard ? {requiredRevisionId: guard} : undefined});
      // An unguarded write gets no writeControl back; refetch so the next
      // write is guarded again rather than leaving the rest of the batch naked.
      guard = res.writeControl?.requiredRevisionId ?? (guard ? undefined : toRemote(await io.get(id)).doc.rev);
      return res.replies ?? reqs.map(() => ({}));
    } catch (e) {
      if (!guard || !(e instanceof ApiError && e.status === 400 && /required revision/i.test(e.message))) throw e;
      let now: string | undefined;
      try {
        now = toRemote(await io.get(id)).doc.rev;
      } catch {
        throw e; // can't tell whether it's a tick or an edit; don't type blind
      }
      if (!now || now !== guard) throw e; // someone else edited; don't type into it
      guard = undefined; // Docs forgot the rev; retry once without it
      return send(reqs);
    }
  };
  // Budget total as the sum of every step's insert (typos included), so done
  // tracks keystrokes, not net text — a doubling typo can't push done past it.
  const steps = requests.filter(typeable).map((r) => flubs(chunks(r.insertText.text, t), t));
  const total = steps.flat().reduce((n, s) => n + ("insert" in s ? s.insert.length : 0), 0);
  let done = 0;
  let pending: any[] = [];
  let at = 0;
  for (const r of requests) {
    if (!typeable(r)) {
      pending.push(r);
      continue;
    }
    if (pending.length) replies.push(...(await send(pending)));
    pending = [];
    const {location} = r.insertText;
    const {index: _i, ...ctx} = location; // segmentId/tabId, for the backspaces
    let index = location.index;
    for (const s of steps[at++]) {
      await sleep(s.wait);
      if ("insert" in s) {
        await send([{insertText: {location: {...location, index}, text: s.insert}}]);
        index += s.insert.length;
        done += s.insert.length;
      } else {
        await send([{deleteContentRange: {range: {startIndex: index - s.del, endIndex: index, ...ctx}}}]);
        index -= s.del;
      }
      t.onChunk?.(done, total);
    }
    replies.push({});
  }
  if (pending.length) replies.push(...(await send(pending)));
  return {replies, writeControl: {requiredRevisionId: guard}};
}

export async function createDoc(title: string): Promise<string> {
  const j = await api<{documentId: string}>("POST", DOCS, {title});
  return j.documentId;
}
