import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "goog-sync-test-"));
process.env.GOOG_CACHE_DIR = join(tmp, "cache");
process.env.GOOG_CONFIG_DIR = join(tmp, "config");
const S = await import("../src/sync.ts");

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc";
const doc = (...lines: string[]) => `<!-- goog doc ${ID} · "T" -->\n\n${lines.join("\n")}\n`;

test("resolveRef understands Google's URL shapes", () => {
  const urls = [
    `https://docs.google.com/document/d/${ID}/edit`,
    `https://docs.google.com/document/d/${ID}/edit?tab=t.0`,
    `https://docs.google.com/document/d/${ID}/edit?usp=sharing`,
    `https://docs.google.com/document/u/1/d/${ID}/edit#heading=h.x`,
    `docs.google.com/document/d/${ID}`,
  ];
  for (const u of urls) assert.deepEqual(S.resolveRef(u), {id: ID, kind: "doc"}, u);
  // These don't say whether it's a doc or a deck; Drive is asked later.
  const unsure = [
    `https://docs.google.com/open?id=${ID}`,
    `https://drive.google.com/open?id=${ID}&authuser=0`,
    `https://drive.google.com/file/d/${ID}/view?usp=drive_link`,
    ` ${ID} `,
  ];
  for (const u of unsure) assert.deepEqual(S.resolveRef(u), {id: ID}, u);
  assert.equal(S.resolveRef(`https://docs.google.com/presentation/d/${ID}/edit`).kind, "slides");
  assert.throws(() => S.resolveRef(`https://docs.google.com/document/d/e/2PACX-1vabc/pub`), /published/);
  assert.throws(() => S.resolveRef(`https://docs.google.com/spreadsheets/d/${ID}/edit`), /Sheets/);
  assert.throws(() => S.resolveRef(`https://example.com/document/d/${ID}`), /isn't a Google/);
  assert.throws(() => S.resolveRef("nope.goog"), /doesn't exist/);
  assert.throws(() => S.resolveRef("hello"), /isn't a doc id/);
});

test("resolveRef reads the header of a .goog file, BOM and CRLF included", () => {
  const f = join(tmp, "bom.goog");
  writeFileSync(f, "﻿" + doc("hi").replace(/\n/g, "\r\n"));
  assert.deepEqual(S.resolveRef(f), {id: ID, kind: "doc", file: f});
  const t = S.readText(f);
  assert.equal(t.crlf, true);
  assert.equal(t.text, doc("hi"));
  writeFileSync(f, "no header\n");
  assert.throws(() => S.resolveRef(f), /no goog header/);
});

test("writeText keeps CRLF and writes atomically", () => {
  const f = join(tmp, "crlf.goog");
  writeFileSync(f, "x");
  const h = S.writeText(f, doc("a", "b"), true);
  assert.equal(readFileSync(f, "utf8"), doc("a", "b").replace(/\n/g, "\r\n"));
  assert.equal(h, S.readText(f).hash);
});

test("reconcile: who changed what", () => {
  const base = doc("one", "two", "three");
  assert.equal(S.reconcile(base, base, base).action, "none");
  // Spacing and a missing trailing newline aren't changes.
  assert.equal(S.reconcile(doc("one", "", "", "two", "three").trimEnd(), base, base).action, "none");
  // Only the doc changed: pull.
  const r1 = S.reconcile(base, base, doc("one", "TWO", "three"));
  assert.equal(r1.action, "pull");
  // Only the file changed: push the file.
  const r2 = S.reconcile(doc("one", "two", "three", "four"), base, base);
  assert.equal(r2.action, "push");
  assert.ok(r2.action === "push" && !r2.merged && r2.text.endsWith("four\n"));
  // Both changed different lines: merge.
  const r3 = S.reconcile(doc("ONE", "two", "three"), base, doc("one", "two", "THREE"));
  assert.ok(r3.action === "push" && r3.merged);
  assert.equal(r3.action === "push" && S.bodyOf(r3.text), S.bodyOf(doc("ONE", "two", "THREE")));
  // Both made the same change: nothing to push, just take the doc.
  assert.equal(S.reconcile(doc("one", "2", "three"), base, doc("one", "2", "three")).action, "none");
  // Same line, different changes: conflict.
  const r4 = S.reconcile(doc("one", "mine", "three"), base, doc("one", "theirs", "three"));
  assert.equal(r4.action, "conflict");
  assert.match(r4.action === "conflict" ? r4.text : "", /<<<<<<< your file\nmine\n=======\ntheirs\n>>>>>>> google doc/);
  // Neighbouring lines changed on each side: merged line by line, no conflict.
  const r6 = S.reconcile(doc("ONE", "two", "three"), base, doc("one", "TWO", "three"));
  assert.ok(r6.action === "push" && r6.merged);
  assert.equal(r6.action === "push" && S.bodyOf(r6.text), S.bodyOf(doc("ONE", "TWO", "three")));
  // ...and only the line both changed is marked.
  const r7 = S.reconcile(doc("ONE", "mine", "three"), base, doc("one", "theirs", "THREE"));
  assert.ok(r7.action === "conflict" && r7.conflicts === 1);
  assert.match(r7.action === "conflict" ? r7.text : "", /^ONE\n<<<<<<< your file\nmine\n=======\ntheirs\n>>>>>>> google doc\nTHREE$/m);
  // No base: the file wins.
  const r5 = S.reconcile(doc("x"), null, base);
  assert.ok(r5.action === "push" && r5.noBase);
});

test("a resolved conflict pushes instead of conflicting again", () => {
  const base = doc("one", "two", "three");
  const theirs = doc("one", "theirs", "three", "four");
  const c = S.reconcile(doc("one", "mine", "three"), base, theirs);
  assert.equal(c.action, "conflict");
  // push() stores the doc as the new base when it writes markers.
  const resolved = (c as any).text.replace(/<<<<<<< your file\n(.*)\n=======\n.*\n>>>>>>> google doc/, "$1 and theirs");
  const r = S.reconcile(resolved, theirs, theirs);
  assert.equal(r.action, "push");
  assert.equal(r.action === "push" && S.bodyOf(r.text), S.bodyOf(doc("one", "mine and theirs", "three", "four")));
  // Half resolved: parse refuses, pointing at the marker line.
  assert.throws(() => S.reconcile((c as any).text, theirs, theirs), /line \d+: .*conflict markers/);
});

test("bases are per file, so a cat-ed copy doesn't inherit another file's history", () => {
  const a = join(tmp, "a.goog");
  const b = join(tmp, "b.goog");
  writeFileSync(a, doc("a"));
  writeFileSync(b, doc("a"));
  S.writeBase(a, {id: ID, text: doc("old")});
  assert.equal(S.readBase(a)?.text, doc("old"));
  assert.equal(S.readBase(b), null);
});

test("state records and listing", (t) => {
  const f = join(tmp, "s.goog");
  const watcher = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {stdio: "ignore"});
  t.after(() => watcher.kill());
  S.setState(f, {status: "synced", id: ID, pid: watcher.pid!, hash: "h"});
  assert.equal(S.readState(f)?.status, "synced");
  assert.ok(S.watcherOf(f));
  assert.ok(S.listStates().some((s) => s.file === f));
  if (S.startedAt(watcher.pid!)) {
    // A watcher that died without saying so, whose pid now runs something else.
    const dir = join(tmp, "cache", "state");
    const name = readdirSync(dir).find((n) => JSON.parse(readFileSync(join(dir, n), "utf8")).file === f)!;
    const st = JSON.parse(readFileSync(join(dir, name), "utf8"));
    writeFileSync(join(dir, name), JSON.stringify({...st, started: "1"}));
    assert.equal(S.watcherOf(f), null);
  }
  S.setState(f, {status: "stopped", id: ID, pid: watcher.pid!});
  assert.equal(S.watcherOf(f), null);
});

// ---------- push and pull against a fake backend ----------

const {backends} = await import("../src/backend.ts");

// Stands in for the Docs backend: the doc is `remote.text`, and `during`
// runs while goog is reading it (say, the user saving the file again).
function fakeDoc(text: string) {
  const remote = {text, rev: "r1", during: (): void => {}, pushed: [] as string[]};
  const be = backends.doc as any;
  be.fetch = async () => {
    remote.during();
    remote.during = () => {};
    return {text: remote.text, rev: remote.rev, remote: null};
  };
  be.push = async (_id: string, target: any) => {
    remote.text = be.serialize(target);
    remote.pushed.push(remote.text);
    remote.during();
    remote.during = () => {};
    return {fetched: {text: remote.text, rev: "r2", remote: null}, requests: 1, warnings: []};
  };
  return remote;
}

const fileIn = (name: string) => join(tmp, name);

test("pull won't replace a file it has no record of unless it matches the doc or --force", async () => {
  const f = fileIn("nobase.goog");
  fakeDoc(doc("from the doc"));
  writeFileSync(f, doc("my own notes"));
  await assert.rejects(S.pull(ID, f, {kind: "doc"}), /no record of syncing it/);
  assert.equal(readFileSync(f, "utf8"), doc("my own notes"));
  await S.pull(ID, f, {kind: "doc", force: true});
  assert.equal(readFileSync(f, "utf8"), doc("from the doc"));
  // Already the same: nothing to lose, so no --force needed.
  S.forgetBase(f);
  await S.pull(ID, f, {kind: "doc"});
});

test("pull won't drop unpushed edits to a synced file unless --force", async () => {
  const f = fileIn("dirty.goog");
  fakeDoc(doc("one"));
  await S.pull(ID, f, {kind: "doc"});
  writeFileSync(f, doc("one", "unpushed"));
  await assert.rejects(S.pull(ID, f, {kind: "doc"}), /changes that aren't in the doc yet/);
  assert.equal(readFileSync(f, "utf8"), doc("one", "unpushed"));
  await S.pull(ID, f, {kind: "doc", force: true});
  assert.equal(readFileSync(f, "utf8"), doc("one"));
});

test("a typed push stopped partway carries on next time instead of conflicting", async () => {
  const f = fileIn("typed.goog");
  const remote = fakeDoc(doc("Q1?", "Q2?"));
  await S.pull(ID, f, {kind: "doc"});
  writeFileSync(f, doc("Q1?", "Answer one.", "Q2?", "Answer two."));
  const be = backends.doc as any;
  const push = be.push;
  // The first pass types answer one and half of answer two, then it's killed.
  be.push = async (_id: string, _target: any, opts: any) => {
    remote.text = doc("Q1?", "Answer one.", "Q2?", "Answer");
    opts.onWrote({text: remote.text, rev: "r2", remote: null});
    throw new Error("killed");
  };
  const typing = {wpm: 45, sleep: async () => {}};
  await assert.rejects(S.push(f, {typing}), /killed/);
  be.push = push;
  const r = await S.push(f, {typing});
  assert.equal(r.status, "pushed");
  assert.equal(remote.text, doc("Q1?", "Answer one.", "Q2?", "Answer two."));
  assert.equal(readFileSync(f, "utf8"), remote.text);
});

test("a mid-pass kill saves the partial typing as the base, so the next push resumes", async () => {
  const f = fileIn("typed-midpass.goog");
  const remote = fakeDoc(doc("Q1?", "Q2?"));
  await S.pull(ID, f, {kind: "doc"});
  writeFileSync(f, doc("Q1?", "Answer one.", "Q2?", "Answer two."));
  const be = backends.doc as any;
  const push = be.push;
  // Kill DURING a pass: the pass's writes partially landed but onWrote was
  // never called for it. pushDoc's catch should refetch and save the partial.
  be.push = async (_id: string, _target: any, opts: any) => {
    // Simulate typeBatch throwing mid-way: some writes landed.
    remote.text = doc("Q1?", "Answer one.", "Q2?", "Ans");
    // The real pushDoc catch refetches and calls onWrote with this state.
    opts.onWrote({text: remote.text, rev: "r2", remote: null});
    throw new Error("killed");
  };
  const typing = {wpm: 45, sleep: async () => {}};
  await assert.rejects(S.push(f, {typing}), /killed/);
  be.push = push;
  // The base should now include the partial typing, so reconcile sees
  // doc === base and just pushes the rest — no conflict.
  const r = await S.push(f, {typing});
  assert.equal(r.status, "pushed");
  assert.equal(remote.text, doc("Q1?", "Answer one.", "Q2?", "Answer two."));
});

test("a save made while push reads the doc isn't overwritten", async () => {
  const f = fileIn("race-pull.goog");
  const remote = fakeDoc(doc("one", "two", "three"));
  await S.pull(ID, f, {kind: "doc"});
  // Someone edits the doc; the file hasn't changed, so push would pull...
  remote.text = doc("ONE", "two", "three");
  // ...but the user saves while it's reading.
  remote.during = () => writeFileSync(f, doc("one", "two", "3"));
  const r = await S.push(f);
  assert.equal(r.rewrote, false);
  assert.equal(readFileSync(f, "utf8"), doc("one", "two", "3"));
  assert.equal(r.savedDuring, true);
  // The next push merges both.
  const r2 = await S.push(f);
  assert.equal(r2.status, "pushed");
  assert.equal(S.bodyOf(remote.text), S.bodyOf(doc("ONE", "two", "3")));
});

test("a save made during a push still counts as unpushed", async () => {
  const f = fileIn("race-push.goog");
  const remote = fakeDoc(doc("one"));
  await S.pull(ID, f, {kind: "doc"});
  writeFileSync(f, doc("one", "two"));
  const pushedHash = S.readText(f).hash;
  remote.during = () => writeFileSync(f, doc("one", "two", "three"));
  const r = await S.push(f);
  assert.equal(r.status, "pushed");
  // goog wait compares this with the file: it must not match the newer save.
  assert.equal(r.hash, pushedHash);
  assert.equal(r.savedDuring, true);
  assert.notEqual(r.hash, S.readText(f).hash);
  assert.equal(readFileSync(f, "utf8"), doc("one", "two", "three"));
  await S.push(f);
  assert.equal(S.bodyOf(remote.text), S.bodyOf(doc("one", "two", "three")));
});

test("a file that's only the header line pushes an empty doc", async () => {
  const f = fileIn("header-only.goog");
  const remote = fakeDoc(doc("one"));
  await S.pull(ID, f, {kind: "doc"});
  writeFileSync(f, `<!-- goog doc ${ID} · "T" -->`);
  const r = await S.push(f);
  assert.equal(r.status, "pushed");
  assert.equal(S.bodyOf(remote.text).trim(), "");
});

test("a save made while the doc is being read stops a conflict being written over it", async () => {
  const f = fileIn("race-conflict.goog");
  const remote = fakeDoc(doc("one"));
  await S.pull(ID, f, {kind: "doc"});
  writeFileSync(f, doc("mine"));
  remote.text = doc("theirs");
  remote.during = () => writeFileSync(f, doc("mine, saved again"));
  const r = await S.push(f);
  assert.equal(r.savedDuring, true);
  assert.equal(r.conflicts, 0);
  assert.equal(readFileSync(f, "utf8"), doc("mine, saved again"));
});

test("pull leaves a file saved while it reads the doc, and takes an empty file", async () => {
  const f = fileIn("race-pullonly.goog");
  const remote = fakeDoc(doc("one"));
  await S.pull(ID, f, {kind: "doc"});
  remote.text = doc("one", "from the browser");
  remote.during = () => writeFileSync(f, doc("one", "my save"));
  await assert.rejects(S.pull(ID, f, {kind: "doc"}), /saved while the doc was being read/);
  assert.equal(readFileSync(f, "utf8"), doc("one", "my save"));
  // An empty file (mktemp, say) has nothing to lose.
  const e = fileIn("empty.goog");
  writeFileSync(e, "");
  await S.pull(ID, e, {kind: "doc"});
  assert.equal(readFileSync(e, "utf8"), remote.text);
});
