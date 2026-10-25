// Offline checks of the CLI's exit codes and JSON shapes. No network: every
// command here fails or finishes before it would talk to Google.

import assert from "node:assert/strict";
import {execFileSync, spawnSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "goog-cli-test-"));
const bin = new URL("../bin/goog.ts", import.meta.url).pathname;
const env = {...process.env, GOOG_CACHE_DIR: join(tmp, "cache"), GOOG_CONFIG_DIR: join(tmp, "config"), GOOG_TOKEN: "offline-test", GOOG_AGENT_HOME: join(tmp, "home")};
const goog = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], {cwd: tmp, env, encoding: "utf8"});

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc";
writeFileSync(join(tmp, "ok.goog"), `<!-- goog doc ${ID} -->\nHello <b>there</b>\n`);
writeFileSync(join(tmp, "bad.goog"), `<!-- goog doc ${ID} -->\nHello <b>there\n`);
writeFileSync(join(tmp, "conflict.goog"), `<!-- goog doc ${ID} -->\n<<<<<<< your file\na\n=======\nb\n>>>>>>> google doc\n`);

test("help", () => {
  const r = goog("help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /goog wait/);
  assert.match(goog("help", "format").stdout, /\.goog format/);
});

test("check: exit codes and --json", () => {
  assert.equal(goog("check", "ok.goog").status, 0);
  const bad = goog("check", "bad.goog", "--json");
  assert.equal(bad.status, 1);
  assert.deepEqual(JSON.parse(bad.stdout), {ok: false, file: "bad.goog", line: 2, error: "line 2: <b> is not closed before the end of the line"});
  const c = goog("check", "conflict.goog");
  assert.equal(c.status, 1);
  assert.match(c.stdout, /conflict markers/);
});

test("status of a file goog never synced", () => {
  const r = goog("status", "ok.goog", "--json");
  assert.equal(r.status, 0);
  const s = JSON.parse(r.stdout);
  assert.equal(s.status, "not synced");
  assert.equal(s.watching, false);
  assert.equal(goog("status").stdout.trim(), "no files known; goog edit <doc> starts syncing one");
});

test("wait without a watcher fails clearly", () => {
  const r = goog("wait", "ok.goog", "--json");
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).ok, false);
  const all = goog("wait");
  assert.equal(all.status, 1);
  assert.match(all.stderr, /no goog edit is running/);
});

test("errors: usage, unknown command, bad refs, --json errors", () => {
  assert.match(goog("push").stderr, /usage: goog push/);
  assert.match(goog("frobnicate").stderr, /unknown command/);
  const r = goog("cat", "https://docs.google.com/spreadsheets/d/abc/edit", "--json");
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /Sheets/);
  assert.match(goog("pull", "nope.goog").stderr, /doesn't exist/);
});

test("stop and log with nothing running", () => {
  assert.equal(goog("stop").stdout.trim(), "no goog edit is running");
  assert.deepEqual(JSON.parse(goog("log", "--json").stdout), []);
});

test("push --type refuses decks, a watching goog edit, and a bad --wpm", () => {
  // A deck: the kind check fires before any fetch.
  const deck = join(tmp, "deck.goog");
  writeFileSync(deck, `<!-- goog slides ${ID} -->\n`);
  const d = goog("push", deck, "--type");
  assert.equal(d.status, 1);
  assert.match(d.stderr, /docs only/);
  // A watching goog edit would push without typing. Register a fake watcher
  // (its pid is this shell, so it reads as alive) via sync.ts's own setter.
  const watched = join(tmp, "watched.goog");
  writeFileSync(watched, `<!-- goog doc ${ID} -->\n`);
  const sync = join(tmp, "mksw.js");
  writeFileSync(sync, `const s = await import(${JSON.stringify(new URL("../src/sync.ts", import.meta.url).href)});\ns.setState(process.argv[2], {status: "synced", id: process.argv[3], pid: Number(process.argv[4])});\n`);
  execFileSync(process.execPath, ["--experimental-strip-types", sync, watched, ID, String(process.ppid)], {env});
  const w = goog("push", watched, "--type");
  assert.equal(w.status, 1);
  assert.match(w.stderr, /would push it without typing/);
  // --wpm that isn't a number is rejected before any push.
  const bad = goog("push", "ok.goog", "--type", "--wpm", "abc");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--wpm/);
});

test("skill: hint until installed, then a symlink per agent", () => {
  const home = join(tmp, "home");
  mkdirSync(join(home, ".claude"), {recursive: true});
  assert.match(goog("help").stdout, /goog skill install/);
  assert.match(goog("skill").stdout, /Claude Code: not installed/);
  assert.match(goog("skill", "install").stdout, /installed for Claude Code/);
  assert.equal(readlinkSync(join(home, ".claude/skills/goog")), new URL("../skill", import.meta.url).pathname);
  assert.equal(existsSync(join(home, ".codex")), false); // agents that aren't set up are left alone
  assert.doesNotMatch(goog("help").stdout, /goog skill install/);
  assert.match(goog("skill", "remove").stdout, /removed from Claude Code/);
  assert.equal(existsSync(join(home, ".claude/skills/goog")), false);
});

test("wait: --timeout takes seconds or minutes, and refuses anything else", () => {
  const r = goog("wait", "ok.goog", "--timeout", "30x");
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /--timeout takes seconds/);
  const ok = goog("wait", "ok.goog", "--timeout", "2m");
  assert.doesNotMatch(ok.stderr + ok.stdout, /--timeout/);
  assert.match(ok.stderr + ok.stdout, /not watched/);
});

test("log: -n takes a count from 1", () => {
  const r = goog("log", "-n", "0");
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /-n takes a whole number from 1/);
});
