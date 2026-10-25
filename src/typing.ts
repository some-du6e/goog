// How goog push --type paces text into a doc: a word or a few per write, at
// about a person's speed, so the version history shows it being typed rather
// than pasted. Docs allows about 60 writes a minute per user, and a write takes
// a request each, so writes are never closer together than MIN_GAP_MS.
//
// Real typing isn't clean: people typo, backspace, rephrase. The Revision
// History extension flags a doc whose inserted:deleted ratio is under 5% as an
// inhuman "editing pattern", so typing here interleaves small mistakes and
// fixes (see flubs) to land around 8-12% deletions.

export const DEFAULT_WPM = 45;
export const MIN_GAP_MS = 1100;

export interface Typing {
  wpm: number;
  // Tests replace these to run without waiting and with fixed pauses.
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onChunk?: (typed: number, total: number) => void;
}

const SENTENCE_END = /[.!?]["')\]]?\s*$/;

export interface Chunk {
  text: string;
  wait: number; // ms to wait before sending it
}

// One step in typing out `text`: insert a piece, or backspace `del` chars
// (after a typo).
export type Step =
  | {insert: string; wait: number}
  | {del: number; wait: number};

// Splits `text` at word ends into chunks, each with the time a person would
// take to type it, plus the pauses they'd make: before starting, after a
// sentence or a comma, and now and then for no reason.
export function chunks(text: string, t: Pick<Typing, "wpm" | "random">): Chunk[] {
  const random = t.random ?? Math.random;
  const between = (lo: number, hi: number) => lo + (hi - lo) * random();
  const msPerChar = 60_000 / (Math.max(1, t.wpm) * 5);
  const words = text.match(/\s*\S+\s*/g) ?? [text];
  const out: Chunk[] = [];
  let pause = between(1500, 4000);
  for (let i = 0; i < words.length; ) {
    let n = Math.min(words.length - i, 1 + Math.floor(random() * 3));
    // A chunk stops at the end of a sentence, where the typist pauses.
    const end = words.slice(i, i + n).findIndex((w) => SENTENCE_END.test(w));
    if (end >= 0) n = end + 1;
    const piece = words.slice(i, i + n).join("");
    i += n;
    const wait = pause + piece.length * msPerChar * between(0.75, 1.35);
    out.push({text: piece, wait: Math.max(MIN_GAP_MS, Math.round(wait))});
    pause = SENTENCE_END.test(piece) ? between(1000, 4000)
      : /[,;:]\s*$/.test(piece) ? between(200, 800)
      : random() < 0.04 ? between(2000, 6000)
      : 0;
  }
  return out;
}

// A plausible typo for `word`: swap two letters, double one, drop one, or hit
// the key next to one on a qwerty row.
function typo(word: string, random: () => number): string {
  if (word.length < 3) return word;
  const at = 1 + Math.floor(random() * (word.length - 2));
  const kind = random();
  if (kind < 0.35) {
    // transposition: "the" → "teh"
    return word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2);
  }
  if (kind < 0.55) {
    // doubling: "look" → "loook"
    return word.slice(0, at + 1) + word[at] + word.slice(at + 1);
  }
  if (kind < 0.75) {
    // dropped letter: "because" → "becuse"
    return word.slice(0, at) + word.slice(at + 1);
  }
  // nearby key: "and" → "amd" (within the same keyboard row)
  const rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
  const c = word[at].toLowerCase();
  for (const row of rows) {
    const i = row.indexOf(c);
    if (i < 0) continue;
    const shift = random() < 0.5 ? -1 : 1;
    const j = Math.min(row.length - 1, Math.max(0, i + shift));
    const rep = row[j];
    return word.slice(0, at) + (word[at] === c ? rep : rep.toUpperCase()) + word.slice(at + 1);
  }
  return word;
}

// Takes the chunks for one paragraph's text and sprinkles in mistakes: some
// words go in wrong, then get deleted a moment later and retyped right. The
// result is a list of insert/delete steps whose net text equals the input,
// and whose deletes total around 10% of the inserts — the shape Revision
// History expects of a person, not a paste.
export function flubs(chs: Chunk[], t: Pick<Typing, "random">): Step[] {
  const random = t.random ?? Math.random;
  const between = (lo: number, hi: number) => lo + (hi - lo) * random();
  const out: Step[] = [];
  const total = chs.reduce((n, c) => n + c.text.length, 0);
  // Deletions to spread across this paragraph: aim for ~10% of typed chars.
  // Short paragraphs get a little more (20%): at exactly 10% even a 30-char
  // one couldn't delete a 4-letter word, and zero deletions across the doc is
  // what revision-history checkers flag. 20% can't overshoot the ratio
  // ceiling below by itself (it allows del ≤ 0.2·total, and the ceiling trips
  // at del/(text + del) > 0.25, i.e. del > 0.25·text/0.75 ≈ 0.33·text), so it
  // never buys a flub the check has to skip — only ever one small one.
  let budget = Math.max(3, Math.round(total * 0.2));
  let deleted = 0;
  let inserted = 0;
  let skip = 0; // chunks to leave alone after a mistake, so they don't bunch up
  for (const c of chs) {
    const plain = () => {
      out.push({insert: c.text, wait: c.wait});
      inserted += c.text.length;
    };
    if (budget <= 0 || skip > 0 || c.text.length < 6) {
      plain();
      skip--;
      continue;
    }
    // Mangle a word inside the chunk: the lead-in and the trailing space go
    // in normally, then the typo, then (after a beat) it's backspaced out and
    // retyped right. Punctuation on the word stays out of the typo.
    const m = c.text.match(/^(.*?)(\s*)([A-Za-z][a-z']{2,})(\W*)$/s);
    if (!m) {
      plain();
      continue;
    }
    const [, head, gap, word, tail] = m;
    const wrong = typo(word, random);
    // Skip the flub rather than bust the budget or the ratio ceiling: the
    // check above only gates the NEXT mistake, so without these a 10-char
    // paragraph (budget 1) would still delete 7 chars for a 41% ratio.
    const del = wrong.length + tail.length;
    if (wrong === word || del > budget || (deleted + del) / (inserted + c.text.length + del) > 0.25) {
      plain();
      continue;
    }
    out.push({insert: head + gap + wrong + tail, wait: c.wait});
    // The reader notices after a beat and deletes back to the start of the
    // word (typo + any trailing punctuation), then types it right.
    out.push({del, wait: Math.max(MIN_GAP_MS, Math.round(between(600, 1400)))});
    out.push({insert: word + tail, wait: Math.max(MIN_GAP_MS, Math.round(between(700, 1600)))});
    budget -= del;
    deleted += del;
    inserted += c.text.length + del;
    skip = 2 + Math.floor(random() * 3);
  }
  return out;
}
