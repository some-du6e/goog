// How goog push --type paces text into a doc: a word or a few per write, at
// about a person's speed, so the version history shows it being typed rather
// than pasted. Docs allows about 60 writes a minute per user, and a write takes
// a request each, so writes are never closer together than MIN_GAP_MS.

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
