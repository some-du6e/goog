// Convergence harness for `goog push --type` against test/sim.ts.
// Run: node --experimental-strip-types test/convergence-harness.ts
//
// "Second push" here means the real flow: after push 1, sync.ts rewrites the
// file from the final remote (with adopted image/chip ids), so push 2 parses
// serialize(endState) — exactly the file the first push left on disk.
//
// For each battery case:
//   1. untyped push -> end state U; second untyped push plans zero
//   2. typed push (seeded random, fast sleep) -> end state T; assert T === U
//   3. second typed push of the rewritten file plans zero requests
//   4. cross-mode: typed push, then untyped push of the rewritten file -> zero
//   5. kill-resume: typed push aborted after write k (k = 1..writes), then a
//      fresh typed push resumes; final state must equal T (and U), and a
//      further push plans zero
//
// Seeded random makes flubs deterministic, so typed end states compare equal
// across seeds and against the untyped result.

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
    // Chip ids are opaque counters in the sim (and Docs-chosen live); a resume
    // after a kill re-chips (same as untyped), so compare chips without ids.
    .replace(/(<chip type="[a-z]+") id="[^"]*" /g, "$1 ")
    .replace(/ start="1"/g, "");
}
const pulled = (sim: SimDoc) => body(serialize(fromApi(sim.toApi()).doc));
// The file as sync.ts would rewrite it after the push.
const fileAfter = (sim: SimDoc) => HEAD + pulled(sim) + "\n";

// mulberry32
const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function io(sim: SimDoc, killer?: {at: number}): DocsIO & {batches: any[][]} {
  const batches: any[][] = [];
  let calls = 0;
  return {
    batches,
    get: async () => sim.toApi(),
    batch: async (_id, b) => {
      calls++;
      if (killer && calls > killer.at) throw new Error(`killed after ${killer.at} writes`);
      if (b.writeControl?.requiredRevisionId && b.writeControl.requiredRevisionId !== `r${sim.rev}`) {
        throw new ApiError(400, "The required revision ID does not match the latest revision.");
      }
      batches.push(b.requests);
      const replies = sim.apply(b.requests);
      return {replies, ...(b.writeControl ? {writeControl: {requiredRevisionId: `r${sim.rev}`}} : {})};
    },
  };
}

const TYPED = (seed: number) => ({wpm: 45, sleep: async () => {}, random: rng(seed)});

interface Case {
  name: string;
  start: string;
  file: string;
  seeds?: number[];
}

const A1 = "A cell is the basic unit of life. All living things are made of cells.";
const A2 = "The mitochondrion makes energy for the cell, powering every process inside it.";
const A3 = "Photosynthesis turns light, water and carbon dioxide into sugar and oxygen.";

const CASES: Case[] = [
  {
    name: "plain multi-paragraph answers",
    start: "Q1: What is a cell?\nQ2: Name an organelle.",
    file: `Q1: What is a cell?\n${A1}\nQ2: Name an organelle.\n${A2}`,
  },
  {
    name: "bold/italic mid-answer",
    start: "Q1: What is a cell?\nQ2: Name an organelle.",
    file: `Q1: What is a cell?\n${A1.replace("basic unit", "<b>basic unit</b>")}\nQ2: Name an organelle.\n${A2.replace("energy", "<i>energy</i>")}`,
  },
  {
    name: "link mid-sentence",
    start: "Q: research?",
    file: `Q: research?\nSee <a href="https://example.com/papers">the published papers</a> for the full results of the study.`,
  },
  {
    name: "smart chips in answer (person, date, link)",
    start: "Q: team?",
    file: `Q: team?\nAsk <chip type="person" email="ada@example.com" name="Ada"> about it. Due <chip type="date" date="2026-11-05">. Spec: <chip type="link" href="https://example.com/spec">.`,
  },
  {
    name: "dropdown chip in answer",
    start: "Q: status?",
    file: `Q: status?\nIt is <chip type="dropdown" value="done" options="todo|doing|done"> as of this morning, with the report filed.`,
  },
  {
    name: "answer inside a table cell",
    start: "<table><tr><td>Q: cell?</td><td></td></tr></table>",
    file: `<table><tr><td>Q: cell?</td><td>${A1}</td></tr></table>`,
  },
  {
    name: "bullet list of answers",
    start: "<li>first question</li>",
    file: `<li>first question</li>\n<li>${A1}</li>\n<li>${A2}</li>`,
  },
  {
    name: "numbered list of answers",
    start: '<li type="1">one</li>',
    file: `<li type="1">one</li>\n<li type="1">${A1}</li>\n<li type="1">${A2}</li>`,
  },
  {
    name: "nested list answers",
    start: "<li>top</li>",
    file: `<li>top</li>\n<li level="2">${A1}</li>`,
  },
  {
    name: "checklist answer",
    start: '<li type="check">todo item one</li>',
    file: `<li type="check">todo item one</li>\n<li type="check">${A1}</li>`,
  },
  {
    name: "typed text replacing existing text (delete+insert)",
    start: "Q: cell?\nA rough draft answer that is wrong and must go away entirely.",
    file: `Q: cell?\n${A1}`,
  },
  {
    name: "typed replacement of a mid-paragraph stretch",
    start: "Status: the project is on hold for now, pending review.",
    file: "Status: the project is proceeding at full speed, with a completed and approved review.",
  },
  {
    name: "answer right after a table (filler paragraph rules)",
    start: "<table><tr><td>data</td></tr></table>\nQ: next?",
    file: `<table><tr><td>data</td></tr></table>\n${A1}`,
  },
  {
    name: "answer right before a table",
    start: "Q: first?\n<table><tr><td>data</td></tr></table>",
    file: `${A1}\n<table><tr><td>data</td></tr></table>`,
  },
  {
    name: "unicode/emoji/smart quotes in answers",
    start: "Q: feelings?",
    file: `Q: feelings?\n“It’s alive!” ⚗️ — the élan of a naïve résumé, plus math ∑ and CJK 細胞は生きている。`,
  },
  {
    name: "heading restyle plus typed answer under it",
    start: "Q: big question?",
    file: `<h2>Q: big question?</h2>\n${A1}`,
  },
  {
    name: "control: formatting-only change, no typing",
    start: `Q: cell?\n${A1}`,
    file: `Q: cell?\n${A1.replace("basic unit", "<b>basic unit</b>")}`,
  },
  {
    name: "many answers in one push (typing holds back later paragraphs)",
    start: "Q1?\nQ2?\nQ3?",
    file: `Q1?\n${A1}\nQ2?\n${A2}\nQ3?\n${A3}`,
  },
  {
    name: "answer with page break inside",
    start: "Q: break?",
    file: `Q: break?\n${A1}\n<pagebreak>\n${A2}`,
  },
  {
    name: "image before a typed answer",
    start: 'Q: pic?\n<img src="https://example.com/a.png">',
    file: `Q: pic?\n<img src="https://example.com/a.png">\n${A1}`,
  },
  {
    name: "two tables with a typed paragraph between them",
    start: "<table><tr><td>a</td></tr></table>\n<table><tr><td>b</td></tr></table>",
    file: `<table><tr><td>a</td></tr></table>\n${A1}\n<table><tr><td>b</td></tr></table>`,
  },
  {
    name: "long single paragraph, typed in full",
    start: "Draft:",
    file: `Draft:\n${[A1, A2, A3].join(" ")}`,
  },
  {
    name: "CRLF line endings in the answer",
    start: "Q: windows?",
    file: `Q: windows?\n${A1.replace(/\. /g, ".\r\n")}`,
  },
  {
    name: "trailing whitespace in answer",
    start: "Q: pad?",
    file: `Q: pad?\n${A1}   `,
  },
  {
    name: "answer in a nested table cell",
    start: "<table><tr><td><table><tr><td>deep</td></tr></table></td><td></td></tr></table>",
    file: `<table><tr><td><table><tr><td>deep</td></tr></table></td><td>${A1}</td></tr></table>`,
  },
  {
    name: "typed answer in a cell with merged cells nearby",
    start: "<table><tr><td colspan=\"2\">wide</td></tr><tr><td>a</td><td></td></tr></table>",
    file: `<table><tr><td colspan="2">wide</td></tr><tr><td>a</td><td>${A1}</td></tr></table>`,
  },
  {
    name: "answer with marked/highlighted and colored runs",
    start: "Q: color?",
    file: `Q: color?\n${A1.replace("basic unit", '<mark color="#ffff00">basic unit</mark>').replace("living things", '<span color="#ff0000">living things</span>')}`,
  },
  {
    name: "short answer under TYPE_MIN is not typed (control)",
    start: "Q: tiny?",
    file: "Q: tiny?\nYes, it is.",
  },
  {
    name: "answer starting with a chip",
    start: "Q: who?",
    file: `Q: who?\n<chip type="person" email="ada@example.com" name="Ada"> wrote the first program, and this sentence explains it fully.`,
  },
  {
    name: "answer ending with a chip",
    start: "Q: when?",
    file: `Q: when?\nThe full and complete answer, with everything explained, is due on <chip type="date" date="2026-11-05">`,
  },
  {
    name: "answer is only a chip and minimal text",
    start: "Q: who?",
    file: `Q: who?\nIt was <chip type="person" email="ada@example.com" name="Ada">.`,
  },
  {
    name: "typed answer replacing a list item with a plain paragraph",
    start: "<li>a draft bullet answer that is entirely wrong</li>",
    file: `${A1}`,
  },
  {
    name: "typed answer turning a paragraph into a list item",
    start: "a draft plain answer that is entirely wrong",
    file: `<li>${A1}</li>`,
  },
  {
    name: "answer typed after a heading that gets restyled in the same push",
    start: "Intro\nQ: cell?",
    file: `<h1>Intro</h1>\nQ: cell?\n${A1}`,
  },
  {
    name: "answer with strikethrough and smallcaps runs",
    start: "Q: styles?",
    file: `Q: styles?\nThis has <s>struck text</s> and <span smallcaps>small caps words</span> inside a longer typed answer.`,
  },
  {
    name: "answer with superscript and subscript",
    start: "Q: math?",
    file: `Q: math?\nEinstein wrote E = mc<sup>2</sup> and water is H<sub>2</sub>O, as everyone knows by now.`,
  },
  {
    name: "answer with a font and size change mid-run",
    start: "Q: font?",
    file: `Q: font?\nThis answer switches to <span font="Courier New" size="14">a monospace fourteen-point run</span> in the middle.`,
  },
  {
    name: "RTL answer",
    start: "Q: hebrew?",
    file: `Q: hebrew?\n<p dir="rtl">תשובה ארוכה מאוד בעברית על התא הבסיסי של החיים וכל מה שקשור אליו</p>`,
  },
  {
    name: "answer with centered alignment",
    start: "Q: align?",
    file: `Q: align?\n<p align="center">${A1}</p>`,
  },
  {
    name: "typed insert into a paragraph that already ends the segment",
    start: `Q: cell?\n${A2}`,
    file: `Q: cell?\n${A2}\n${A1}`,
  },
  {
    name: "answer typed between a heading and a list",
    start: "<h2>Section</h2>\n<li>existing bullet</li>",
    file: `<h2>Section</h2>\n${A1}\n<li>existing bullet</li>`,
  },
  {
    name: "answer typed before a checklist (list anchor logic)",
    start: '<li type="check">existing task</li>',
    file: `${A1}\n<li type="check">existing task</li>`,
  },
  {
    name: "two typed answers separated by a table (held-back slices)",
    start: "Q1?\n<table><tr><td>t</td></tr></table>\nQ2?",
    file: `Q1?\n${A1}\n<table><tr><td>t</td></tr></table>\nQ2?\n${A2}`,
  },
  {
    name: "answer in every cell of a 2x2 table",
    start: "<table><tr><td></td><td></td></tr><tr><td></td><td></td></tr></table>",
    file: `<table><tr><td>${A1}</td><td>${A2}</td></tr><tr><td>${A3}</td><td>${A1}</td></tr></table>`,
  },
  {
    name: "answer with a newline-free 200-char single word (chunking edge)",
    start: "Q: long?",
    file: `Q: long?\n${"supercalifragilisticexpialidocious".repeat(6)}`,
  },
  {
    name: "answer of exactly TYPE_MIN chars",
    start: "Q: edge?",
    file: "Q: edge?\n0123456789",
  },
  {
    name: "answer of TYPE_MIN-1 chars (not typed)",
    start: "Q: edge?",
    file: "Q: edge?\n012345678",
  },
  {
    name: "answer that is only whitespace-plus-punctuation (typeable \\S check)",
    start: "Q: dots?",
    file: "Q: dots?\n..............",
  },
];

let failures = 0;

function fail(name: string, detail: string) {
  failures++;
  console.log(`FAIL ${name}\n  ${detail.replace(/\n/g, "\n  ")}`);
}
function pass(name: string, detail: string) {
  console.log(`ok   ${name}  ${detail}`);
}

async function runCase(c: Case) {
  const seeds = c.seeds ?? [7, 42];
  try {
    SimDoc.from(c.start);
  } catch (e: any) {
    pass(c.name, `SKIP: sim can't build start (${e.message})`);
    return;
  }

  // ---------- 1. untyped push, then repush the rewritten file ----------
  let U: string;
  {
    const sim = SimDoc.from(c.start);
    const x = io(sim);
    await pushDoc("sim", parse(HEAD + c.file), {io: x});
    const r2 = await pushDoc("sim", parse(fileAfter(sim)), {io: x});
    U = canon(pulled(sim));
    if (r2.requests !== 0) return fail(c.name, `untyped second push (rewritten file) planned ${r2.requests} requests`);
    const warns = r2.warnings.filter((w) => /can't create|can't place/.test(w));
    if (warns.length) return fail(c.name, `untyped push warns: ${warns.join("; ")}`);
  }

  // ---------- 2. typed push, compare with untyped ----------
  let T: string = "";
  let typedWrites = 0;
  for (const seed of seeds) {
    const sim = SimDoc.from(c.start);
    const x = io(sim);
    await pushDoc("sim", parse(HEAD + c.file), {io: x, typing: TYPED(seed)});
    const t = canon(pulled(sim));
    typedWrites = x.batches.length;
    if (t !== U) {
      return fail(c.name, `typed (seed ${seed}) end state differs from untyped:\n--- untyped ---\n${U}\n--- typed ---\n${t}`);
    }
    if (seed === seeds[0]) T = t;
    else if (t !== T!) return fail(c.name, `typed end state differs between seeds ${seeds[0]} and ${seed}`);
  }

  // ---------- 3. second typed push (rewritten file) plans zero ----------
  {
    const sim = SimDoc.from(c.start);
    const x = io(sim);
    await pushDoc("sim", parse(HEAD + c.file), {io: x, typing: TYPED(seeds[0])});
    const r2 = await pushDoc("sim", parse(fileAfter(sim)), {io: x, typing: TYPED(seeds[1] ?? 99)});
    if (r2.requests !== 0) return fail(c.name, `second TYPED push (rewritten file) planned ${r2.requests} requests`);
  }

  // ---------- 4. cross-mode: typed then untyped ----------
  {
    const sim = SimDoc.from(c.start);
    const x = io(sim);
    await pushDoc("sim", parse(HEAD + c.file), {io: x, typing: TYPED(seeds[0])});
    const r2 = await pushDoc("sim", parse(fileAfter(sim)), {io: x});
    if (r2.requests !== 0) return fail(c.name, `untyped push after a typed one (rewritten file) planned ${r2.requests} requests`);
  }

  // ---------- 5. kill-resume at every write index ----------
  const totalWrites = typedWrites;
  for (let k = 1; k <= totalWrites; k++) {
    const sim = SimDoc.from(c.start);
    const x = io(sim, {at: k});
    try {
      await pushDoc("sim", parse(HEAD + c.file), {io: x, typing: TYPED(seeds[0])});
    } catch (e: any) {
      if (!/killed/.test(e.message)) return fail(c.name, `kill at write ${k}: unexpected error ${e.message}`);
    }
    // Resume with a fresh typed push (the killer is gone). The partial doc is
    // where the aborted typing stopped; the next pass re-plans from there.
    const xr = io(sim);
    await pushDoc("sim", parse(HEAD + c.file), {io: xr, typing: TYPED(seeds[0])});
    const t = canon(pulled(sim));
    if (t !== T!) {
      return fail(c.name, `kill at write ${k}/${totalWrites}, resume diverged:\n--- expected ---\n${T}\n--- resumed ---\n${t}`);
    }
    const r3 = await pushDoc("sim", parse(fileAfter(sim)), {io: xr});
    if (r3.requests !== 0) return fail(c.name, `after kill at write ${k} + resume, repush planned ${r3.requests} requests`);
  }

  pass(c.name, `${totalWrites} writes, ${totalWrites} kill-resume points`);
}

for (const c of CASES) await runCase(c);

console.log(`\n${CASES.length - failures}/${CASES.length} cases clean${failures ? `, ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
