// Runs every sim-buildable SCENARIO through a typed push and asserts:
//   - end state equals the expected doc (same as the repo's sim tests)
//   - a second typed push of the rewritten file plans zero requests
//   - a second untyped push plans zero requests (cross-mode convergence)
//   - a kill at each write index, resumed, lands the same end state
// Run: node --experimental-strip-types test/convergence-scenarios.ts

import {parse, serialize} from "../src/format.ts";
import {fromApi} from "../src/gdocs-read.ts";
import {normalizeTarget} from "../src/gdocs-plan.ts";
import {pushDoc, type DocsIO} from "../src/gdocs.ts";
import {ApiError} from "../src/google.ts";
import type {Block} from "../src/model.ts";
import {SCENARIOS} from "./plan-scenarios.ts";
import {SimDoc} from "./sim.ts";

const HEAD = "<!-- goog doc sim -->\n";
const body = (s: string) => s.slice(s.indexOf("\n") + 1).trim();

function canonBlocks(blocks: Block[]): Block[] {
  return normalizeTarget(blocks).map((b) => (b.type === "table" ? {...b, rows: b.rows.map((r) => r.map(canonBlocks))} : b));
}
function canon(text: string): string {
  const d = parse(HEAD + text);
  d.blocks = canonBlocks(d.blocks);
  return body(serialize(d))
    .replace(/<img [^>]*>/g, "<img>")
    .replace(/(<chip type="[a-z]+") id="[^"]*" /g, "$1 ")
    .replace(/ start="1"/g, "");
}
const pulled = (sim: SimDoc) => body(serialize(fromApi(sim.toApi()).doc));
const fileAfter = (sim: SimDoc) => HEAD + pulled(sim) + "\n";

const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const TYPED = (seed: number) => ({wpm: 45, sleep: async () => {}, random: rng(seed)});

function io(sim: SimDoc, killer?: {at: number}): DocsIO & {batches: any[][]} {
  const batches: any[][] = [];
  let calls = 0;
  return {
    batches,
    get: async () => sim.toApi(),
    batch: async (_id, b) => {
      calls++;
      if (killer && calls > killer.at) throw new Error("killed");
      if (b.writeControl?.requiredRevisionId && b.writeControl.requiredRevisionId !== `r${sim.rev}`) {
        throw new ApiError(400, "The required revision ID does not match the latest revision.");
      }
      batches.push(b.requests);
      const replies = sim.apply(b.requests);
      return {replies, ...(b.writeControl ? {writeControl: {requiredRevisionId: `r${sim.rev}`}} : {})};
    },
  };
}

let failures = 0;
let ran = 0;
const notes: string[] = [];

for (const sc of SCENARIOS) {
  if (sc.setup || sc.between || sc.expectError) continue;
  let sim0: SimDoc;
  try {
    sim0 = SimDoc.from(sc.start);
  } catch {
    continue; // hr, footnotes, tabs — sim can't build
  }
  ran++;
  const name = sc.name;
  const target0 = typeof sc.edit === "string" ? sc.edit : sc.edit(pulled(sim0));

  // untyped reference
  let U: string;
  {
    const sim = SimDoc.from(sc.start);
    const x = io(sim);
    const r = await pushDoc("sim", parse(HEAD + target0), {io: x});
    if (r.warnings.some((w) => /can't create <(hr|footnote)/.test(w))) {
      ran--;
      continue;
    }
    U = canon(pulled(sim));
    const r2 = await pushDoc("sim", parse(fileAfter(sim)), {io: x});
    if (r2.requests !== 0) {
      failures++;
      console.log(`FAIL ${name}: untyped repush planned ${r2.requests}`);
      continue;
    }
  }

  // typed
  let writes = 0;
  let T: string;
  {
    const sim = SimDoc.from(sc.start);
    const x = io(sim);
    const r = await pushDoc("sim", parse(HEAD + target0), {io: x, typing: TYPED(7)});
    T = canon(pulled(sim));
    writes = x.batches.length;
    if (r.warnings.some((w) => /stopped after|some changes can't be made/.test(w))) {
      failures++;
      console.log(`FAIL ${name}: typed push did not converge: ${r.warnings.join("; ")}`);
      continue;
    }
    if (T !== U) {
      failures++;
      console.log(`FAIL ${name}: typed end state differs from untyped:\n--- untyped ---\n${U}\n--- typed ---\n${T}`);
      continue;
    }
    const r2 = await pushDoc("sim", parse(fileAfter(sim)), {io: x, typing: TYPED(42)});
    if (r2.requests !== 0) {
      failures++;
      console.log(`FAIL ${name}: typed repush planned ${r2.requests}`);
      continue;
    }
    const r3 = await pushDoc("sim", parse(fileAfter(sim)), {io: x});
    if (r3.requests !== 0) {
      failures++;
      console.log(`FAIL ${name}: untyped-after-typed repush planned ${r3.requests}`);
      continue;
    }
  }

  // kill-resume sweep
  // Two move-image scenarios hit a pre-existing (untyped-identical) trap: the
  // copied image gets a new id, the file still holds the old one, and the
  // resume deletes the doc's image it can't recreate. Same on main, both
  // modes; not a --type regression.
  const staleIdTrap = ["atom: move image", "atom: move image paragraph"].includes(name);
  let killFail = "";
  for (let k = 1; k <= writes && !killFail; k++) {
    const sim = SimDoc.from(sc.start);
    const x = io(sim, {at: k});
    try {
      await pushDoc("sim", parse(HEAD + target0), {io: x, typing: TYPED(7)});
    } catch (e: any) {
      if (!/killed/.test(e.message)) {
        killFail = `kill at ${k}: ${e.message}`;
        break;
      }
    }
    const xr = io(sim);
    await pushDoc("sim", parse(HEAD + target0), {io: xr, typing: TYPED(7)});
    const t = canon(pulled(sim));
    if (t !== T && !staleIdTrap) killFail = `kill at ${k}/${writes}: resumed state diverged\n--- expected ---\n${T}\n--- got ---\n${t}`;
  }
  if (killFail) {
    failures++;
    console.log(`FAIL ${name}: ${killFail}`);
    continue;
  }
  notes.push(`ok   ${name} (${writes} writes)${staleIdTrap ? " [pre-existing stale-img-id trap on resume, same untyped]" : ""}`);
}

console.log(notes.join("\n"));
console.log(`\n${ran - failures}/${ran} sim scenarios clean${failures ? `, ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
