import assert from "node:assert/strict";
import {test} from "node:test";
import {parse, serialize} from "../src/format.ts";
import {fromApi} from "../src/gdocs-read.ts";
import {normalizeTarget, plan, ticksDiffer} from "../src/gdocs-plan.ts";
import {readFileSync, readdirSync} from "node:fs";
import {pushDoc, toRemote, type DocsIO} from "../src/gdocs.ts";
import {ApiError} from "../src/google.ts";
import type {Block} from "../src/model.ts";
import {SCENARIOS} from "./plan-scenarios.ts";
import {SimDoc} from "./sim.ts";
import {MIN_GAP_MS, chunks, flubs} from "../src/typing.ts";

const HEAD = "<!-- goog doc sim -->\n";
const body = (s: string) => s.slice(s.indexOf("\n") + 1).trim();

// Docs' filler paragraphs made explicit and image ids masked, so files that
// mean the same doc compare equal.
function canonBlocks(blocks: Block[]): Block[] {
  return normalizeTarget(blocks).map((b) => (b.type === "table" ? {...b, rows: b.rows.map((r) => r.map(canonBlocks))} : b));
}
function canon(text: string): string {
  const d = parse(HEAD + text);
  d.blocks = canonBlocks(d.blocks);
  return body(serialize(d)).replace(/<img [^>]*>/g, "<img>").replace(/ start="1"/g, "");
}

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
      // The real API only returns writeControl when the request had one.
      return {replies, ...(b.writeControl ? {writeControl: {requiredRevisionId: `r${sim.rev}`}} : {})};
    },
  };
}

// Typing without the waits.
const TYPING = {wpm: 45, sleep: async () => {}};

async function push(sim: SimDoc, target: string, opts: {typing?: boolean} = {}) {
  const x = io(sim);
  const r = await pushDoc("sim", parse(HEAD + target), {io: x, typing: opts.typing ? TYPING : undefined});
  return {...r, out: body(serialize(fromApi(sim.toApi()).doc)), batches: x.batches};
}

const pulled = (sim: SimDoc) => body(serialize(fromApi(sim.toApi()).doc));

// ---------- the live scenarios, against the simulator ----------

// Typed (goog push --type), every scenario must end the same way.
for (const {sc, typing} of SCENARIOS.flatMap((sc) => [{sc, typing: false}, {sc, typing: true}])) {
  if (sc.setup || sc.between || sc.expectError) continue;
  test(`sim${typing ? " typed" : ""}: ${sc.name}`, async () => {
    let sim: SimDoc;
    try {
      sim = SimDoc.from(sc.start);
    } catch (e: any) {
      if (/sim can't build/.test(e.message)) return; // hr, footnotes, …
      throw e;
    }
    assert.equal(canon(pulled(sim)), canon(sc.start), "sim built the start doc wrong");
    const target = typeof sc.edit === "string" ? sc.edit : sc.edit(pulled(sim));
    const r = await push(sim, target, {typing});
    if (r.warnings.some((w) => /can't create <(hr|footnote)/.test(w))) return;
    assert.equal(canon(r.out), canon(typeof sc.expect === "function" ? sc.expect(pulled(sim)) : sc.expect ?? target));
    assert.ok(!r.warnings.some((w) => /stopped after|some changes can't be made/.test(w)), r.warnings.join("\n"));
  });
}

// ---------- regressions ----------

test("untouched fixture docs (tabs, segments, lists, merged cells, chips) plan nothing", () => {
  const dir = new URL("./fixtures/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json") && !x.startsWith("slides-"))) {
    const remote = toRemote(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
    const p = plan(remote, parse(serialize(remote.doc)));
    assert.equal(p.requests.length, 0, `${f}: ${JSON.stringify(p.requests).slice(0, 300)}`);
    assert.deepEqual(p.warnings, [], f);
  }
});

test("a typed push types answers top to bottom, a few words a write, then styles them", async () => {
  const sim = SimDoc.from("Q1: What is a cell?\nQ2: Name an organelle.");
  const a1 = "A cell is the basic unit of life. All living things are made of cells.";
  const a2 = "The mitochondrion, which makes energy for the cell.";
  const r = await push(sim, `Q1: What is a cell?\n${a1.replace("basic unit", "<b>basic unit</b>")}\nQ2: Name an organelle.\n${a2}`, {typing: true});
  assert.equal(r.out, `Q1: What is a cell?\n${a1.replace("basic unit", "<b>basic unit</b>")}\nQ2: Name an organelle.\n${a2}`);
  // Net text (inserts minus deletes) equals the original; some inserts are
  // typos that get backspaced out, so don't expect a literal join.
  const inserts = r.batches.flat().filter((q) => q.insertText).map((q) => q.insertText.text);
  const deletes = r.batches.flat().filter((q) => q.deleteContentRange).map((q) => q.deleteContentRange.range.endIndex - q.deleteContentRange.range.startIndex);
  const insertedChars = inserts.reduce((n, s) => n + s.length, 0);
  const deletedChars = deletes.reduce((n, d) => n + d, 0);
  assert.equal(insertedChars - deletedChars, `\n${a1}\n${a2}`.length);
  assert.ok(inserts.every((t) => t.split(" ").filter(Boolean).length <= 3), inserts.join("|"));
  // Each piece of typing is a write of its own; the bold comes after the words.
  const typed = r.batches.filter((b) => b.some((q) => q.insertText && q.insertText.text !== "\n"));
  assert.ok(typed.every((b) => b.length === 1));
  const bold = r.batches.findIndex((b) => b.some((q) => q.updateTextStyle?.textStyle?.bold));
  assert.ok(bold > r.batches.findIndex((b) => b[0].insertText?.text.includes("cells.")));
  // Short fixes aren't typed: they go in one write as usual.
  const fix = await push(sim, `Q1: What is a cell?\n${a1.replace("basic unit", "<b>basic unit</b>").replace("life", "all life")}\nQ2: Name an organelle.\n${a2}`, {typing: true});
  assert.equal(fix.batches.length, 1);
});

test("typing chunks cover the text, end at sentences, and keep to the write quota", () => {
  const text = "  Plants make food. They use light, water and air!  Then they grow. ";
  for (const seed of [0.01, 0.5, 0.99]) {
    const c = chunks(text, {wpm: 300, random: () => seed});
    assert.equal(c.map((x) => x.text).join(""), text);
    assert.ok(c.every((x) => x.wait >= MIN_GAP_MS));
    for (const x of c) assert.ok(!/[.!?]\s+\S/.test(x.text), x.text);
  }
});


test("flubs: net text equals the original, with a plausible deletion ratio", () => {
  const text = "The quick brown fox jumps over the lazy dog. It was a bright cold day in April, and the clocks were striking thirteen. ";
  for (const seed of [0.05, 0.3, 0.6, 0.95]) {
    let i = 0;
    const rand = () => [0.05, 0.3, 0.6, 0.95][i++ % 4];
    const steps = flubs(chunks(text, {wpm: 300, random: rand}), {random: rand});
    let net = "";
    let inserted = 0;
    let deleted = 0;
    for (const s of steps) {
      assert.ok(s.wait >= MIN_GAP_MS, JSON.stringify(s));
      if ("insert" in s) {
        net += s.insert;
        inserted += s.insert.length;
      } else {
        net = net.slice(0, net.length - s.del);
        deleted += s.del;
      }
    }
    assert.equal(net, text);
    // The extension flags under 5%; land comfortably above, without looking
    // like a maniac either.
    assert.ok(deleted / inserted >= 0.06, `del ratio ${deleted}/${inserted} = ${deleted / inserted}`);
    assert.ok(deleted / inserted <= 0.25, `del ratio ${deleted}/${inserted} = ${deleted / inserted}`);
  }
});

test("flubs: short paragraphs (down to TYPE_MIN) keep a sane deletion ratio", () => {
  // mulberry32 so the sweep is deterministic; the old budget check let
  // "Short one." delete 41% of its keystrokes at seed 27.
  const rng = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // [text, expect a flub at some seed?]. The cap may price flubs out of a
  // tiny paragraph (better none than a 28% spike), but not out of longer
  // ones: a doc with no deletions at all is what the checkers flag.
  const cases: [string, boolean][] = [
    ["Short one.", true],
    ["A ten-char answer.", false],
    ["Mitochondria is the powerhouse of the cell, at thirty-five characters or so.", true],
  ];
  for (const [text, expectFlub] of cases) {
    let sawFlub = false;
    for (let seed = 1; seed <= 500; seed++) {
      const steps = flubs(chunks(text, {wpm: 300, random: rng(seed)}), {random: rng(seed)});
      let inserted = 0;
      let deleted = 0;
      for (const s of steps) {
        if ("insert" in s) inserted += s.insert.length;
        else deleted += s.del;
      }
      sawFlub ||= deleted > 0;
      assert.ok(deleted / inserted <= 0.25, `seed ${seed} on ${JSON.stringify(text)}: del ratio ${deleted}/${inserted} = ${deleted / inserted}`);
    }
    assert.equal(sawFlub, expectFlub, `flub presence for ${JSON.stringify(text)}`);
  }
});

test("a stale-guard 400 retries without the guard only when the doc's rev is unchanged", async () => {
  // Docs forgot the rev: io.batch rejects once with "required revision" even
  // though the sim's rev never moved. The retry (unguarded) must land.
  const sim = SimDoc.from("Q: life?\n");
  const x = io(sim);
  let dropped = false;
  const flaky: DocsIO = {
    get: x.get,
    batch: async (id, b) => {
      if (!dropped && b.writeControl?.requiredRevisionId === `r${sim.rev}` && b.requests.some((r: any) => r.insertText)) {
        dropped = true;
        throw new ApiError(400, "The required revision ID does not match the latest revision.");
      }
      return x.batch(id, b);
    },
  };
  const answer = "The answer to life, the universe and everything is forty-two.";
  const r = await pushDoc("sim", parse(HEAD + `Q: life?\n${answer}`), {io: flaky, typing: TYPING});
  assert.equal(body(serialize(fromApi(sim.toApi()).doc)), `Q: life?\n${answer}`);
  assert.ok(dropped, "the stale-guard path never fired");
});

test("a real edit mid-typing stops the push instead of typing into it", async () => {
  // io.batch rejects once with "required revision" AND the sim's rev has
  // advanced (someone else wrote). The retry must rethrow, not type on.
  const sim = SimDoc.from("Q: life?\n");
  const x = io(sim);
  let fired = false;
  const hostile: DocsIO = {
    get: x.get,
    batch: async (id, b) => {
      if (!fired && b.requests.some((r: any) => r.insertText && r.insertText.text.length > 3)) {
        fired = true;
        sim.rev++; // the other writer's edit moved the rev
        throw new ApiError(400, "The required revision ID does not match the latest revision.");
      }
      return x.batch(id, b);
    },
  };
  const answer = "The answer to life, the universe and everything is forty-two.";
  await assert.rejects(
    pushDoc("sim", parse(HEAD + `Q: life?\n${answer}`), {io: hostile, typing: TYPING}),
    /required revision/i,
  );
  assert.ok(fired, "the edit never landed");
});

test("a revision clash mid-typing does NOT save the base: the retry must merge the other edit in", async () => {
  // Same hostile io as above, but with onWrote wired (as sync.ts does). The
  // doc now holds someone else's edit; saving it as the base would make the
  // automatic retry see theirs-equals-base and push the file over that edit.
  const sim = SimDoc.from("Q: life?\n");
  const x = io(sim);
  let fired = false;
  const hostile: DocsIO = {
    get: x.get,
    batch: async (id, b) => {
      if (!fired && b.requests.some((r: any) => r.insertText && r.insertText.text.length > 3)) {
        fired = true;
        sim.rev++; // the other writer's edit moved the rev
        throw new ApiError(400, "The required revision ID does not match the latest revision.");
      }
      return x.batch(id, b);
    },
  };
  const saved: string[] = [];
  const answer = "The answer to life, the universe and everything is forty-two.";
  await assert.rejects(
    pushDoc("sim", parse(HEAD + `Q: life?\n${answer}`), {
      io: hostile,
      typing: TYPING,
      onWrote: (r) => saved.push(body(serialize(r.doc))),
    }),
    /required revision/i,
  );
  assert.ok(fired, "the edit never landed");
  assert.equal(saved.length, 0, "the clash saved a poisoned base");
});

// A fake signal source/sink: the handler's re-kill is a REAL signal, so a
// test can't fire the handler through process.emit without dying from it.
function fakeSignal() {
  const handlers = new Map<string, Function[]>();
  const killed: string[] = [];
  return {
    killed,
    count: (sig: string) => handlers.get(sig)?.length ?? 0,
    fire: (sig: string) => handlers.get(sig)?.forEach((h) => h(sig)),
    on: (sig: string, fn: Function) => handlers.set(sig, [...(handlers.get(sig) ?? []), fn]),
    off: (sig: string, fn: Function) => handlers.set(sig, (handlers.get(sig) ?? []).filter((h) => h !== fn)),
    kill: (sig: string) => killed.push(sig),
  };
}

test("pushDoc registers its signal handler only for the push's duration", async () => {
  const sim = SimDoc.from("Q: life?\n");
  const sig = fakeSignal();
  const answer = "The answer to life, the universe and everything is forty-two.";
  // Hold the first sleep so the assertion lands mid-pass, however fast the sim is.
  let release: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let slept = false;
  const p = pushDoc("sim", parse(HEAD + `Q: life?\n${answer}`), {
    io: io(sim),
    typing: {
      wpm: 45,
      sleep: async () => {
        if (!slept) {
          slept = true;
          await gate;
        }
      },
    },
    onSignal: async () => {},
    signal: sig,
  });
  await new Promise((r) => setTimeout(r, 10)); // let the push reach the held sleep
  assert.equal(sig.count("SIGTERM"), 1);
  release!();
  await p;
  assert.equal(sig.count("SIGTERM"), 0);
});

test("a signal mid-typing freezes the typing before the base is snapshot", async () => {
  // The handler's fetch must not race a chunk landing after it: hold the
  // second write on the wire, fire the signal, and check the snapshot was
  // taken only after that write finished — and that no further write goes out.
  const sim = SimDoc.from("Q: life?\n");
  const x = io(sim);
  let calls = 0;
  let release: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const writes: string[] = [];
  const slow: DocsIO = {
    get: x.get,
    batch: async (id, b) => {
      calls++;
      writes.push(JSON.stringify(b.requests));
      if (calls === 2) await gate; // the write the signal catches on the wire
      return x.batch(id, b);
    },
  };
  const answer = "The answer to life, the universe and everything is forty-two.";
  const order: string[] = [];
  const sig = fakeSignal();
  const p = pushDoc("sim", parse(HEAD + `Q: life?\n${answer}`), {
    io: slow,
    typing: TYPING,
    onSignal: async () => {
      order.push("signal");
      const r = toRemote(await slow.get("sim"));
      order.push(`snapshot:${body(serialize(r.doc)).length}`);
    },
    signal: sig,
  });
  await new Promise((r) => setTimeout(r, 20)); // reach the gated second write
  sig.fire("SIGINT");
  await new Promise((r) => setTimeout(r, 20)); // give a racing sleep a chance to fire
  release!();
  await p;
  // After the signal, at most the in-flight write completes; nothing new sends.
  assert.equal(calls, 2, `writes after the signal: ${writes.join(" | ")}`);
  assert.deepEqual(order[0], "signal");
  // The snapshot saw the gated write's text (it was awaited first), i.e. more
  // than the doc had before it.
  const len = Number(order[1].split(":")[1]);
  assert.ok(len > "Q: life?".length, `snapshot too early: ${order.join(", ")}`);
  assert.deepEqual(sig.killed, ["SIGINT"], "the handler must re-signal after saving");
});

test("a mid-typing failure saves the partial doc via onWrote so the next push resumes", async () => {
  // typeBatch throws after some chunks landed; pushDoc's catch must refetch
  // and call onWrote with the partial state before rethrowing.
  const sim = SimDoc.from("Q: life?\n");
  const x = io(sim);
  let calls = 0;
  const killer: DocsIO = {
    get: x.get,
    batch: async (id, b) => {
      calls++;
      if (calls === 3) throw new Error("killed");
      return x.batch(id, b);
    },
  };
  const saved: string[] = [];
  const answer = "The answer to life, the universe and everything is forty-two.";
  await assert.rejects(
    pushDoc("sim", parse(HEAD + `Q: life?\n${answer}`), {
      io: killer,
      typing: TYPING,
      onWrote: (r) => saved.push(body(serialize(r.doc))),
    }),
    /killed/,
  );
  // onWrote fired with the partial doc (some chunks of the answer typed).
  assert.equal(saved.length, 1);
  assert.ok(saved[0].startsWith("Q: life?"), saved[0]);
  assert.ok(saved[0].length > "Q: life?".length, "no partial typing was saved");
  assert.ok(saved[0].length < `Q: life?\n${answer}`.length, "saved the full text?");

  // Resume: the next pushDoc starts from the partial doc and finishes.
  const r = await pushDoc("sim", parse(HEAD + `Q: life?\n${answer}`), {io: x, typing: TYPING});
  assert.equal(body(serialize(fromApi(sim.toApi()).doc)), `Q: life?\n${answer}`);
});

test("typed progress counts keystrokes, so done never overshoots total and lands on it", async () => {
  const sim = SimDoc.from("Q: life?\n");
  const answer = "The answer to life, the universe and everything is forty-two.";
  const seen: Array<[number, number]> = [];
  await pushDoc("sim", parse(HEAD + `Q: life?\n${answer}`), {
    io: io(sim),
    typing: {wpm: 45, sleep: async () => {}, onChunk: (d, t) => seen.push([d, t])},
  });
  // total includes typo surplus (a doubling typo inserts one extra char), so
  // done ends at total, not at the plain text length — and never overshoots.
  for (const [d, t] of seen) assert.ok(d <= t, `done ${d} > total ${t}`);
  const last = seen.at(-1)!;
  assert.equal(last[0], last[1]);
  assert.ok(last[0] >= answer.length, `done ${last[0]} < text ${answer.length}`);
});

test("small edits send few requests, in one pass", async () => {
  const sim = SimDoc.from("<h1>Title</h1>\nSome <b>bold</b> words here.\nlast");
  const r = await push(sim, "<h1>Title</h1>\nSome <b>very bold</b> words here.\nlast");
  assert.equal(r.passes, 1);
  // The insert inherits bold; the one restyle is for the new text only.
  assert.deepEqual(r.batches[0].map((q) => Object.keys(q)[0]), ["insertText", "updateTextStyle"]);
});

test("rewriting a paragraph to unrelated text is one delete and one insert, not letter-by-letter edits", async () => {
  const sim = SimDoc.from("Paragraph 523: the quick brown fox jumps over the lazy dog.\nkeep");
  const r = await push(sim, "Totally new line 523\nkeep");
  assert.equal(r.out, "Totally new line 523\nkeep");
  assert.ok(r.requests <= 4, `${r.requests} requests: ${JSON.stringify(r.batches)}`);
});

test("removing a link styles from the link's start (Docs ignores unlinks that start on plain text)", async () => {
  const sim = SimDoc.from(`go to <a href="https://example.com">site</a> now`);
  const r = await push(sim, "go to site now");
  assert.equal(r.out, "go to site now");
  assert.equal(r.passes, 1);
});

test("new <img src> gets its id from the reply and converges", async () => {
  const sim = SimDoc.from("one two");
  const r = await push(sim, `one <img src="https://example.com/a.png"> two`);
  assert.match(r.out, /^one <img id="kix\.sim\d+"> two$/);
  assert.equal(r.passes, 1);
});

test("moving an image copies it and deletes the original", async () => {
  const sim = SimDoc.from(`pic <img src="https://example.com/a.png"> here\nother`);
  const start = pulled(sim);
  const img = /<img [^>]+>/.exec(start)![0];
  const r = await push(sim, start.replace(` ${img}`, "").replace("other", `other ${img}`));
  assert.match(r.out, /^pic here\nother <img id="kix\.sim\d+">$/);
  assert.notEqual(/<img [^>]+>/.exec(r.out)![0], img);
  assert.ok(r.warnings.some((w) => /copied/.test(w)));
});

test("a new table at the very start keeps Docs' paragraph before it, and fills in one pass", async () => {
  const sim = SimDoc.from("<h1>Head</h1>\ntext");
  const r = await push(sim, "<table>\n<tr><td>x</td><td><b>y</b></td></tr>\n</table>\n<h1>Head</h1>\ntext");
  assert.equal(canon(r.out), canon("<table>\n<tr><td>x</td><td><b>y</b></td></tr>\n</table>\n<h1>Head</h1>\ntext"));
  assert.ok(r.passes <= 2, `passes ${r.passes}`);
});

test("inserting a table between paragraphs takes one pass", async () => {
  const sim = SimDoc.from("a\nb");
  const r = await push(sim, "a\n<table>\n<tr><td>1</td><td>2</td></tr>\n<tr><td>3</td><td>4</td></tr>\n</table>\nb");
  assert.equal(r.passes, 1);
});

test("deleting the last paragraph doesn't leave its heading style on the one before", async () => {
  const sim = SimDoc.from("Para\n<h2>End</h2>");
  const r = await push(sim, "Para");
  assert.equal(r.out, "Para");
  assert.equal(r.passes, 1);
});

test("deleting a trailing list item doesn't turn the previous paragraph into one", async () => {
  const sim = SimDoc.from("Intro\n<li>a</li>");
  const r = await push(sim, "Intro");
  assert.equal(r.out, "Intro");
  assert.equal(r.passes, 1);
});

test("a paragraph inserted after a heading or bullet doesn't inherit it", async () => {
  for (const [start, want] of [
    ["<h1>H</h1>\nbody", "<h1>H</h1>\nnew\nbody"],
    ["<li>a</li>\nafter", "<li>a</li>\nplain\nafter"],
    ["<li>a</li>", "<li>a</li>\nplain"],
  ]) {
    const sim = SimDoc.from(start);
    const r = await push(sim, want);
    assert.equal(canon(r.out), canon(want));
  }
});

test("inserting before an edited paragraph edits it in place instead of recreating it", async () => {
  const sim = SimDoc.from(`first <img src="https://example.com/a.png"> para`);
  const start = pulled(sim);
  const r = await push(sim, "brand new\n" + start.replace("para", "para, edited"));
  assert.equal(r.out, "brand new\n" + start.replace("para", "para, edited"));
  assert.ok(!r.batches.flat().some((q) => q.insertInlineImage), "the image was recreated");
});

test("adding a column on the left inserts one column, not a rewrite", async () => {
  const sim = SimDoc.from("<table>\n<tr><td>a</td><td>b</td></tr>\n<tr><td>c</td><td>d</td></tr>\n</table>");
  const r = await push(sim, "<table>\n<tr><td>z</td><td>a</td><td>b</td></tr>\n<tr><td>z</td><td>c</td><td>d</td></tr>\n</table>");
  assert.equal(canon(r.out), canon("<table>\n<tr><td>z</td><td>a</td><td>b</td></tr>\n<tr><td>z</td><td>c</td><td>d</td></tr>\n</table>"));
  assert.ok(!r.batches.flat().some((q) => q.deleteContentRange), "cells were rewritten");
  assert.deepEqual(r.batches[0].map((q) => Object.keys(q)[0]), ["insertTableColumn"]);
});

test("adding a row and a column at once is one reshape pass", async () => {
  const sim = SimDoc.from("<table>\n<tr><td>a</td><td>b</td></tr>\n</table>");
  const want = "<table>\n<tr><td>a</td><td>b</td><td>c</td></tr>\n<tr><td>d</td><td>e</td><td>f</td></tr>\n</table>";
  const r = await push(sim, want);
  assert.equal(canon(r.out), canon(want));
  assert.equal(r.passes, 2);
});

test("page break mid-paragraph takes one pass", async () => {
  const sim = SimDoc.from("Third and last.");
  const r = await push(sim, "Third<pagebreak> and last.");
  assert.equal(r.out, "Third<pagebreak> and last.");
  assert.equal(r.passes, 1);
});

test("moving a paragraph that's only an uncopyable object leaves it in place, without a stray empty paragraph", async () => {
  const sim = SimDoc.from("a\nb\nc");
  // A chip the sim can't build: splice one into the API JSON instead.
  const api = sim.toApi();
  const remote = toRemote(api);
  const para = remote.body[0] as any;
  para.block.runs = [{atom: {kind: "chip", key: "kix.chip", attrs: {type: "dropdown", id: "kix.chip"}, len: 1}, style: {}}];
  const p = plan(remote, parse(HEAD + "b\nc\n" + `<chip type="dropdown" id="kix.chip">`));
  assert.ok(p.warnings.some((w) => /can't move <chip/.test(w)), p.warnings.join("\n"));
  assert.ok(!p.requests.some((q) => q.insertText?.text?.includes("\n")), JSON.stringify(p.requests));
});

test("when a move can't happen, the list pass still lines paragraphs up by content", () => {
  const sim = SimDoc.from(`<h1>T</h1>\nhello\n<li>first</li>\n<li level="2">nested</li>\nx`);
  const remote = toRemote(sim.toApi());
  (remote.body.at(-1) as any).block.runs = [{atom: {kind: "chip", key: "kix.chip", attrs: {type: "dropdown", id: "kix.chip"}, len: 1}, style: {}}];
  const target = parse(HEAD + `<h1>T</h1>\n<chip type="dropdown" id="kix.chip">\nhello\n<li>first</li>\n<li level="2">nested</li>`);
  const p = plan(remote, target);
  assert.equal(p.pass, "done", JSON.stringify(p.requests));
});

test("objects that can't be created are skipped with a warning, without breaking the rest", async () => {
  const sim = SimDoc.from("Third last.");
  const r = await push(sim, "Third <hr> <b>last</b>.");
  assert.equal(r.out, "Third  <b>last</b>.");
  assert.ok(r.warnings.some((w) => /can't create <hr>/.test(w)));
  assert.ok(!r.warnings.some((w) => /some changes can't be made/.test(w)));
});

test("new chips are created, get the doc's ids, and converge", async () => {
  const sim = SimDoc.from("Meet then.");
  const r = await push(sim, `Meet <chip type="person" email="ana@example.com"> on <chip type="date" date="2026-12-25">, see <chip type="link" href="https://docs.google.com/document/d/abc/edit"> then.`);
  assert.match(r.out, /^Meet <chip type="person" id="kix\.sim\d+" name="ana" email="ana@example.com"> on <chip type="date" id="kix\.sim\d+" text="2026-12-25" date="2026-12-25T00:00:00Z">, see <chip type="link" id="kix\.sim\d+" title="Sim file" href="https:\/\/docs.google.com\/document\/d\/abc\/edit"> then\.$/);
  assert.ok(!r.warnings.length, r.warnings.join("\n"));
  assert.equal(r.passes, 1);
});

test("dropdowns: a new one with options, one reusing those options, and a value change", async () => {
  const sim = SimDoc.from("a\nb");
  let r = await push(sim, `a <chip type="dropdown" value="High" options="Low|Medium|High">\nb`);
  assert.match(r.out, /^a <chip type="dropdown" id="kix\.sim\d+" value="High">\nb$/);
  assert.equal(Object.keys(sim.dropdownDefinitions).length, 1);
  // Copying a dropdown without its id reuses its definition.
  r = await push(sim, r.out.replace("\nb", `\nb <chip type="dropdown" value="Low">`));
  assert.equal(Object.keys(sim.dropdownDefinitions).length, 1);
  assert.match(r.out, /\nb <chip type="dropdown" id="kix\.sim\d+" value="Low">$/);
  const id = /id="(kix\.sim\d+)" value="High"/.exec(r.out)![1];
  r = await push(sim, r.out.replace(`value="High"`, `value="Medium"`));
  assert.ok(r.out.includes(`id="${id}" value="Medium"`), r.out);
  assert.deepEqual(r.batches.flat().map((q) => Object.keys(q)[0]), ["updateDropdownProperties"]);
  r = await push(sim, r.out.replace(`value="Medium"`, `value="Huge"`));
  assert.ok(r.warnings.some((w) => /has no option "Huge"; its options are Low, Medium, High/.test(w)), r.warnings.join("\n"));
});

test("editing a date chip's date replaces the chip", async () => {
  const sim = SimDoc.from("x");
  let r = await push(sim, `x <chip type="date" date="2026-12-25">`);
  r = await push(sim, r.out.replace(`date="2026-12-25T00:00:00Z"`, `date="2027-01-01"`));
  assert.match(r.out, /^x <chip type="date" id="kix\.sim\d+" text="2027-01-01" date="2027-01-01T00:00:00Z">$/);
  assert.ok(!r.warnings.length, r.warnings.join("\n"));
});

test("new chips missing what they're made from warn instead of failing", () => {
  const remote = toRemote(SimDoc.from("x").toApi());
  const p = plan(remote, parse(HEAD + `x <chip type="person"> <chip type="date" date="soon"> <chip type="dropdown" value="Zed">`));
  for (const w of [/needs email=/, /can't read the date "soon"/, /no dropdown in the doc has the option "Zed"/]) assert.ok(p.warnings.some((x) => w.test(x)), p.warnings.join("\n"));
});

test("a new chip that can't be made doesn't take the id of the next one of its type", async () => {
  const sim = SimDoc.from("a b c");
  const r = await push(sim, `a <chip type="date" date="next friday"> b <chip type="date" date="2026-10-31"> c`);
  assert.equal(r.out.match(/<chip /g)?.length, 1, r.out);
  assert.deepEqual(r.warnings, [`can't read the date "next friday"; write it like 2026-10-31`]);
});

test("a new <footnote> is created, and its text lands in the footnote once the id is known", () => {
  const remote = toRemote(SimDoc.from("Claim.").toApi());
  const target = parse(HEAD + `Claim<footnote text="Source: me">.`);
  const p = plan(remote, target);
  const req = p.requests.find((q) => q.createFootnote);
  assert.deepEqual(req, {createFootnote: {location: {index: 6}}});
  p.created.find((c) => c.req === req)!.apply({createFootnote: {footnoteId: "kix.fn1"}});
  assert.deepEqual(target.segments, [{kind: "footnote", id: "kix.fn1", blocks: [{type: "para", style: "p", runs: [{text: "Source: me", style: {}}]}]}]);
  assert.ok(serialize(target).includes(`Claim<footnote id="kix.fn1">.`));
});

test("checklist ticks the file changes can't be pushed, so they warn", () => {
  const remote = toRemote(SimDoc.from(`<li type="check">a</li>\n<li type="check">b</li>`).toApi());
  remote.doc.blocks.forEach((b, k) => k === 0 && b.type === "para" && (b.list!.checked = true));
  const p = plan(remote, parse(HEAD + `<li type="check">a</li>\n<li type="check" checked>b</li>`));
  assert.equal(p.pass, "done");
  assert.ok(p.warnings.some((w) => /ticking or unticking/.test(w)), p.warnings.join("\n"));
});

test("adding an item next to one at the same level keeps the list (no rebuild)", async () => {
  const listIds = (sim: SimDoc) => sim.toApi().body.content.filter((e: any) => e.paragraph?.bullet).map((e: any) => e.paragraph.bullet.listId);
  for (const [start, want] of [
    [`<li>a</li>\n<li level="2">b</li>\n<li type="1" start="1">n</li>`, `<li>a</li>\n<li level="2">b</li>\n<li level="2">b2</li>\n<li type="1" start="1">n</li>`],
    [`<li>a</li>\n<li>b</li>\nafter`, `<li>a</li>\n<li>b</li>\n<li>c</li>\nafter`],
    [`<li>a</li>\n<li>b</li>\nnot yet`, `<li>a</li>\n<li>b</li>\n<li>not yet</li>`],
  ]) {
    const sim = SimDoc.from(start);
    const before = listIds(sim)[0];
    const r = await push(sim, want);
    assert.equal(canon(r.out), canon(want));
    assert.equal(listIds(sim)[0], before, `list was rebuilt for ${want}`);
  }
});

test("level changes rebuild the list (joining a list ignores nesting tabs) and converge", async () => {
  for (const [start, want] of [
    [`<li>a</li>\n<li>b</li>\n<li>c</li>`, `<li>a</li>\n<li level="2">b</li>\n<li>c</li>`],
    [`<li>a</li>\n<li>b</li>`, `<li>a</li>\n<li>b</li>\n<li level="3">deep</li>`],
    [`<li>a</li>\n<li level="2">b</li>`, `<li>a</li>\n<li>b</li>`],
  ]) {
    const r = await push(SimDoc.from(start), want);
    assert.equal(canon(r.out), canon(want));
    assert.ok(!r.warnings.some((w) => /some changes|stopped/.test(w)), r.warnings.join("\n"));
  }
});

test("custom-glyph lists that already match aren't rebuilt", () => {
  const sim = SimDoc.from(`<li type="★">a</li>\n<li type="★">b</li>`);
  const remote = fromApi(sim.toApi());
  const p = plan(remote, parse(HEAD + pulled(sim)));
  assert.equal(p.pass, "done");
});

test("unreachable list glyphs warn once instead of looping", async () => {
  const sim = SimDoc.from("x");
  const r = await push(sim, `<li type="1">one</li>\n<li level="2" type="I">nested</li>`);
  assert.ok(r.warnings.some((w) => /type="I"/.test(w)), r.warnings.join("\n"));
  assert.ok(!r.warnings.some((w) => /some changes can't be made|stopped/.test(w)), r.warnings.join("\n"));
});

test("a doc edit between write and re-read stops the push", async () => {
  const sim = SimDoc.from("a\nb");
  const x = io(sim);
  const sneaky: DocsIO = {
    get: x.get,
    batch: async (id, b) => {
      const res = await x.batch(id, b);
      sim.apply([{insertText: {location: {index: 1}, text: "Z"}}]);
      return res;
    },
  };
  await assert.rejects(pushDoc("sim", parse(HEAD + "a\nb\n<li>c</li>"), {io: sneaky}), /required revision/);
});

test("a ticked checklist item doesn't warn on the passes after the first", async () => {
  const sim = SimDoc.from('<li type="check">task</li>\nold');
  const first = toRemote(sim.toApi());
  for (const b of first.doc.blocks) if (b.type === "para" && b.list) b.list.checked = true; // as markChecked would
  const r = await pushDoc("sim", parse(HEAD + '<li type="check" checked>task</li>\nnew'), {io: io(sim), first});
  assert.equal(pulled(sim), '<li type="check">task</li>\nnew');
  assert.deepEqual(r.warnings, []);
  // Unticking it in the file still warns.
  const sim2 = SimDoc.from('<li type="check">task</li>\nold');
  const first2 = toRemote(sim2.toApi());
  for (const b of first2.doc.blocks) if (b.type === "para" && b.list) b.list.checked = true;
  const r2 = await pushDoc("sim", parse(HEAD + '<li type="check">task</li>\nnew'), {io: io(sim2), first: first2});
  assert.match(r2.warnings.join(), /ticking or unticking/);
  // A new item the file ticks is created unticked; the backend compares the
  // doc as it ended up (ticks read by markChecked: none here) with the file.
  const sim3 = SimDoc.from("old");
  const target = parse(HEAD + 'old\n<li type="check" checked>new task</li>');
  const r3 = await pushDoc("sim", target, {io: io(sim3)});
  assert.equal(pulled(sim3), 'old\n<li type="check">new task</li>');
  assert.equal(ticksDiffer(r3.remote.doc, target), true);
  assert.equal(ticksDiffer(r3.remote.doc, parse(HEAD + 'old\n<li type="check">new task</li>')), false);
});

test("a stale revision is rejected on the first write", async () => {
  const sim = SimDoc.from("a");
  await assert.rejects(pushDoc("sim", parse(HEAD + "b"), {io: io(sim), rev: "r-old"}), /required revision/);
});

// ---------- the original plain-paragraph cases ----------

const START = [
  {text: "Cellular Respiration", ps: {namedStyleType: "HEADING_1"}},
  {text: "Answer every question in complete sentences."},
  {text: "1. Why do cells need oxygen? ANSWER HERE"},
  {text: "Thanks 🙂 bye"},
];

const cases: [string, string][] = [
  ["text edit", `<h1>Cellular Respiration</h1>\n\nAnswer every question in full sentences.\n1. Why do cells need oxygen? ANSWER HERE\nThanks 🙂 bye\n`],
  ["highlight + bold", `<h1>Cellular Respiration</h1>\n\nAnswer every question in <b>complete sentences</b>.\n1. Why do cells need oxygen? <mark>To make ATP.</mark>\nThanks 🙂 bye\n`],
  ["insert paragraphs", `<h1>Cellular Respiration</h1>\n\nAnswer every question in complete sentences.\nNew one\n<h2>And a heading</h2>\n\n1. Why do cells need oxygen? ANSWER HERE\nThanks 🙂 bye\nAt the end\n`],
  ["delete paragraphs", `<h1>Cellular Respiration</h1>\n\nThanks 🙂 bye\n`],
  ["delete last", `<h1>Cellular Respiration</h1>\n\nAnswer every question in complete sentences.\n1. Why do cells need oxygen? ANSWER HERE\n`],
  ["emoji edits", `<h1>Cellular Respiration 🧬</h1>\n\nAnswer every question in complete sentences.\n1. Why do cells need oxygen? ANSWER HERE\nThanks 🙃 bye <i>ok</i>\n`],
  ["restyle", `<p align="center">Cellular Respiration</p>\n<h3>Answer every question in complete sentences.</h3>\n\n1. Why do cells need oxygen? ANSWER HERE\nThanks 🙂 bye\n`],
  ["rewrite all", `<title>Totally</title>\n\ndifferent <a href="https://x.test">doc</a>\n<p></p>\n<p></p>\nwith blanks\n`],
  ["first paragraph", `New first\n\n<h1>Cellular Respiration</h1>\n\nAnswer every question in complete sentences.\n1. Why do cells need oxygen? ANSWER HERE\nThanks 🙂 bye\n`],
];

for (const [name, target] of cases) {
  test(`converges: ${name}`, async () => {
    const r = await push(new SimDoc(START), target);
    assert.equal(canon(r.out), canon(target));
  });
}

test("plain text edit is a single pass", async () => {
  const r = await push(new SimDoc(START), `<h1>Cellular Respiration</h1>\n\nAnswer every question in full sentences.\n1. Why do cells need oxygen? ANSWER HERE\nThanks 🙂 bye\n`);
  assert.equal(r.passes, 1);
});

test("two edits in one paragraph land in one pass (applied back to front)", async () => {
  const r = await push(SimDoc.from("The quick fox ran into the forest today."), "The quick elephant ran into the woods today.");
  assert.equal(r.out, "The quick elephant ran into the woods today.");
  assert.equal(r.passes, 1);
});
