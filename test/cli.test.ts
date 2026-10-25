// Offline checks of the CLI's exit codes and JSON shapes. No network: every
// command here fails or finishes before it would talk to Google.

import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync} from "node:fs";
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

test("goog <cmd> --help shows that command's part of the help", () => {
  const t = goog("transcript", "--help").stdout;
  assert.match(t, /^  goog transcript/);
  assert.match(t, /--from 2:00 --to 15:35/);
  assert.doesNotMatch(t, /goog wait/);
  assert.match(goog("classroom", "--help").stdout, /--progress/);
  assert.match(goog("c++", "--help").stdout, /goog help format/); // not a regex
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

test("goog pics: times out with exit 3, and lists the pictures once they're drawn", async () => {
  const {startedAt} = await import("../src/proc.ts");
  const file = join(tmp, "deck.goog");
  const dir = join(tmp, "deck.files");
  writeFileSync(file, `<!-- goog slides ${ID} -->\n`);
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, "slide-1.png"), "png");
  writeFileSync(join(dir, ".drawn.json"), "{}");
  writeFileSync(join(dir, ".drawing"), `${process.pid} ${startedAt(process.pid) ?? ""}`); // this test stands in for the draw
  let r = goog("pics", "deck.goog", "--timeout", "1", "--json");
  assert.equal(r.status, 3);
  assert.equal(JSON.parse(r.stdout).status, "drawing");
  rmSync(join(dir, ".drawing"));
  r = goog("pics", "deck.goog", "--json");
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).images, [join("deck.files", "slide-1.png")]);
});
