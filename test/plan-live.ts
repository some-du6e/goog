// Live planner harness: runs edit scenarios against real Google Docs.
//
//   node test/plan-live.ts [name-regex] [--keep] [--verbose]
//
// Each scenario gets a fresh doc: push `start`, pull it, apply `edit` to the
// pulled text, push, re-read, and compare serializations. Created doc ids are
// appended to /tmp/goog-planner-docs.txt, and each is deleted for good (not
// trashed, so a run doesn't leave hundreds of docs in the Drive trash) unless
// --keep is passed.

import {appendFileSync} from "node:fs";
import {parse, serialize} from "../src/format.ts";
import {createDoc, fetchDoc, pushDoc} from "../src/gdocs.ts";
import {normalizeTarget} from "../src/gdocs-plan.ts";
import type {Block} from "../src/model.ts";
import {DRIVE, api} from "../src/google.ts";
import {SCENARIOS, type Scenario} from "./plan-scenarios.ts";

const args = process.argv.slice(2);
const filter = new RegExp(args.find((a) => !a.startsWith("--")) ?? ".");
const keep = args.includes("--keep");
const verbose = args.includes("--verbose");
const LOG = "/tmp/goog-planner-docs.txt";

const body = (s: string) => s.slice(s.indexOf("\n") + 1).trim();
// Canonical form: Docs' filler paragraphs made explicit, image ids masked
// (new and copied images get ids the file can't know).
function canonBlocks(blocks: Block[]): Block[] {
  return normalizeTarget(blocks).map((b) => (b.type === "table" ? {...b, rows: b.rows.map((r) => r.map(canonBlocks))} : b));
}
function canon(text: string): string {
  const d = parse(`<!-- goog doc x -->\n${text}`);
  d.blocks = canonBlocks(d.blocks);
  for (const s of d.segments ?? []) s.blocks = canonBlocks(s.blocks);
  for (const t of d.tabs ?? []) {
    t.blocks = canonBlocks(t.blocks);
    for (const s of t.segments ?? []) s.blocks = canonBlocks(s.blocks);
  }
  if (d.tabs) d.blocks = d.tabs[0].blocks;
  return body(serialize(d)).replace(/<img [^>]*>/g, "<img>").replace(/ start="1"/g, "");
}
const norm = (_id: string, text: string) => canon(text);

async function remove(id: string) {
  await api("DELETE", `${DRIVE}/files/${id}`);
}

interface Result {
  name: string;
  ok: boolean;
  setupOk: boolean;
  passes: number;
  requests: number;
  kinds: string;
  warnings: string[];
  diff?: string;
  error?: string;
}

function lineDiff(a: string, b: string): string {
  const x = a.split("\n");
  const y = b.split("\n");
  const out: string[] = [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) out.push(`  want: ${y[i] ?? "<none>"}\n  got:  ${x[i] ?? "<none>"}`);
  }
  return out.slice(0, 6).join("\n");
}

async function run(sc: Scenario): Promise<Result> {
  let id: string;
  try {
    id = await createDoc(`goog test (planner) ${sc.name}`);
  } catch (e: any) {
    return {name: sc.name, ok: false, setupOk: false, passes: 0, requests: 0, kinds: "", warnings: [], error: e.message};
  }
  appendFileSync(LOG, id + "\n");
  const res: Result = {name: sc.name, ok: false, setupOk: false, passes: 0, requests: 0, kinds: "", warnings: []};
  try {
    const s = await pushDoc(id, parse(`<!-- goog doc ${id} -->\n${sc.start}`));
    if (sc.setup) await sc.setup(id);
    let pulled = await fetchDoc(id);
    const startText = body(serialize(pulled.doc));
    res.setupOk = canon(startText) === norm(id, sc.start);
    if (!res.setupOk) {
      res.diff = "SETUP:\n" + lineDiff(canon(startText), norm(id, sc.start));
      res.warnings = s.warnings;
    }
    const target = typeof sc.edit === "string" ? sc.edit : sc.edit(startText);
    const kinds: string[] = [];
    if (sc.between) await sc.between(id);
    const r = await pushDoc(id, parse(`<!-- goog doc ${id} -->\n${target}`), {
      rev: pulled.doc.rev,
      first: sc.between ? undefined : pulled,
      onPass: (p, n) => {
        if (p.pass === "done") return;
        const count = new Map<string, number>();
        for (const q of p.requests) {
          const k = Object.keys(q)[0];
          count.set(k, (count.get(k) ?? 0) + 1);
        }
        kinds.push(`${p.pass}:${[...count].map(([k, v]) => `${k.replace(/^(update|insert|delete|create)/, (m) => m[0])}${v > 1 ? "x" + v : ""}`).join(",")}`);
        if (verbose) console.log(`--- ${sc.name} pass ${n} (${p.pass})\n${JSON.stringify(p.requests)}`);
      },
    });
    res.passes = r.passes;
    res.requests = r.requests;
    res.kinds = kinds.join(" | ");
    res.warnings.push(...r.warnings);
    const final = await fetchDoc(id);
    const got = canon(body(serialize(final.doc)));
    const want = canon(typeof sc.expect === "function" ? sc.expect(startText) : sc.expect ?? target);
    res.ok = got === want;
    if (!res.ok) res.diff = (res.diff ? res.diff + "\n" : "") + lineDiff(got, want);
    if (sc.check) {
      const msg = sc.check(final, r);
      if (msg) {
        res.ok = false;
        res.diff = (res.diff ?? "") + "\n  check: " + msg;
      }
    }
  } catch (e: any) {
    if (sc.expectError?.test(e.message)) res.ok = res.setupOk = true;
    else res.error = e.message;
  } finally {
    if (!keep) await remove(id).catch(() => {});
    else console.log(`kept ${sc.name}: ${id}`);
  }
  return res;
}

const todo = SCENARIOS.filter((s) => filter.test(s.name));
const results: Result[] = [];
let next = 0;
async function worker() {
  while (next < todo.length) {
    const sc = todo[next++];
    let r = await run(sc);
    for (let k = 0; k < 4 && r.error && /Quota exceeded|429/.test(r.error); k++) {
      await new Promise((res) => setTimeout(res, 62_000));
      r = await run(sc);
    }
    results.push(r);
    const tag = r.error ? "ERR " : r.ok ? (r.setupOk ? "ok  " : "ok* ") : "FAIL";
    console.log(`${tag} ${r.name}  passes=${r.passes} reqs=${r.requests}  ${r.kinds}`);
    if (r.warnings.length) console.log(`     warn: ${r.warnings.join(" / ")}`);
    if (r.error) console.log(`     error: ${r.error}`);
    if (r.diff) console.log(r.diff);
  }
}
await Promise.all(Array.from({length: Number(process.env.J ?? 3)}, worker));
const bad = results.filter((r) => !r.ok || r.error);
console.log(`\n${results.length - bad.length}/${results.length} ok`);
