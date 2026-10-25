// Signal-based kill-resume convergence: fire SIGINT at each write boundary
// mid-typing (the handler snapshots the doc, as sync's onSignal does), then a
// fresh typed push resumes from the partial doc. Final state must equal the
// uninterrupted typed end state, and a repush of the rewritten file plans
// zero. Run: node --experimental-strip-types test/convergence-signal.ts

import {parse, serialize} from "../src/format.ts";
import {fromApi} from "../src/gdocs-read.ts";
import {normalizeTarget} from "../src/gdocs-plan.ts";
import {pushDoc, toRemote, type DocsIO} from "../src/gdocs.ts";
import {ApiError} from "../src/google.ts";
import type {Block} from "../src/model.ts";
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

function io(sim: SimDoc): DocsIO & {batches: any[][]} {
  const batches: any[][] = [];
  return {
    batches,
    get: async () => sim.toApi(),
    batch: async (_id, b) => {
      if (b.writeControl?.requiredRevisionId && b.writeControl.requiredRevisionId !== `r${sim.rev}`) {
        throw new ApiError(400, "The required revision ID does not match the latest revision.");
      }
      batches.push(b.requests);
      const replies = sim.apply(b.requests);
      return {replies, ...(b.writeControl ? {writeControl: {requiredRevisionId: `r${sim.rev}`}} : {})};
    },
  };
}

function fakeSignal() {
  const handlers = new Map<string, Function[]>();
  const killed: string[] = [];
  return {
    killed,
    fire: (sig: string) => handlers.get(sig)?.forEach((h) => h(sig)),
    on: (sig: string, fn: Function) => handlers.set(sig, [...(handlers.get(sig) ?? []), fn]),
    off: (sig: string, fn: Function) => handlers.set(sig, (handlers.get(sig) ?? []).filter((h) => h !== fn)),
    kill: (sig: string) => killed.push(sig),
  };
}

const A1 = "A cell is the basic unit of life. All living things are made of cells.";
const A2 = "The mitochondrion makes energy for the cell, powering every process inside it.";

const CASES = [
  {name: "plain", start: "Q1?\nQ2?", file: `Q1?\n${A1}\nQ2?\n${A2}`},
  {name: "bold mid-answer", start: "Q?", file: `Q?\n${A1.replace("basic unit", "<b>basic unit</b>")}`},
  {name: "chips", start: "Q?", file: `Q?\nAsk <chip type="person" email="ada@example.com" name="Ada"> about the due date <chip type="date" date="2026-11-05"> today.`},
  {name: "table cell", start: "<table><tr><td>Q</td><td></td></tr></table>", file: `<table><tr><td>Q</td><td>${A1}</td></tr></table>`},
  {name: "list", start: "<li>q</li>", file: `<li>q</li>\n<li>${A1}</li>\n<li>${A2}</li>`},
  {name: "replace text", start: "Draft answer that is wrong and must go away entirely now.", file: A1},
];

let failures = 0;
for (const c of CASES) {
  // uninterrupted reference
  const ref = SimDoc.from(c.start);
  const xr = io(ref);
  await pushDoc("sim", parse(HEAD + c.file), {io: xr, typing: {wpm: 45, sleep: async () => {}, random: rng(7)}});
  const T = canon(pulled(ref));
  const totalWrites = xr.batches.length;

  // Fire the signal after write k lands. The typing loop sleeps before each
  // chunk; count batch calls and fire once the k-th has completed.
  for (let k = 1; k <= totalWrites; k++) {
    const sim = SimDoc.from(c.start);
    const x = io(sim);
    const sig = fakeSignal();
    let calls = 0;
    const counting: DocsIO = {
      get: x.get,
      batch: async (id, b) => {
        const r = await x.batch(id, b);
        calls++;
        // The k-th write just landed; Ctrl+C arrives now, wherever the typist
        // is (mid-sleep, between passes, or before the trailing flush). The
        // handler freezes the typing and snapshots before anything else sends.
        if (calls === k) sig.fire("SIGINT");
        return r;
      },
    };
    let snapshotted: string | undefined;
    await pushDoc("sim", parse(HEAD + c.file), {
      io: counting,
      typing: {wpm: 45, sleep: async () => {}, random: rng(7)},
      signal: sig as any,
      onSignal: async () => {
        // What sync's onSignal does: snapshot the doc as the new base.
        snapshotted = pulled(sim);
      },
    });
    if (sig.killed.length !== 1) {
      failures++;
      console.log(`FAIL ${c.name} kill@${k}: handler didn't re-signal (${sig.killed.length})`);
      break;
    }
    if (!snapshotted) {
      failures++;
      console.log(`FAIL ${c.name} kill@${k}: onSignal never ran`);
      break;
    }
    // Resume from the partial doc.
    const x2 = io(sim);
    await pushDoc("sim", parse(HEAD + c.file), {io: x2, typing: {wpm: 45, sleep: async () => {}, random: rng(7)}});
    const t = canon(pulled(sim));
    if (t !== T) {
      failures++;
      console.log(`FAIL ${c.name} kill@${k}/${totalWrites}: resume diverged\n--- expected ---\n${T}\n--- got ---\n${t}`);
      break;
    }
    const r3 = await pushDoc("sim", parse(fileAfter(sim)), {io: x2});
    if (r3.requests !== 0) {
      failures++;
      console.log(`FAIL ${c.name} kill@${k}: repush after resume planned ${r3.requests}`);
      break;
    }
    if (k === totalWrites) console.log(`ok   ${c.name} (${totalWrites} signal-abort points)`);
  }
}

console.log(failures ? `\n${failures} FAILURES` : "\nall signal kill-resume cases clean");
process.exit(failures ? 1 : 0);
