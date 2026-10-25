import assert from "node:assert/strict";
import {test} from "node:test";
import {clock, fixQuotes, json3Words, parseVideo, pickTrack, timed} from "../src/youtube.ts";

test("parseVideo: every YouTube link shape, and not other links", () => {
  const id = "j8YfUEzBQ20";
  for (const u of [id, `https://youtu.be/${id}?t=30`, `https://www.youtube.com/watch?v=${id}&list=x`, `youtube.com/embed/${id}`,
    `https://m.youtube.com/shorts/${id}`, `https://www.youtube-nocookie.com/embed/${id}`, `HTTPS://WWW.YouTube.com/watch?v=${id}`]) assert.equal(parseVideo(u), id, u);
  assert.equal(parseVideo("https://docs.google.com/document/d/abc/edit"), null);
  assert.equal(parseVideo("notes.goog"), null);
  assert.throws(() => parseVideo("https://www.youtube.com/channel/UCxyz"), /can't find a video id/);
});

test("timed: a line per 30 seconds, each with its time", () => {
  const w = (start: number, word: string) => ({start, end: start + 0.3, word});
  assert.equal(timed([w(0.2, "hi"), w(12, "there"), w(31, "next"), w(95, "later"), w(96, "on")]), "[0:00] hi there\n[0:31] next\n[1:35] later on");
  assert.equal(clock(3725.9), "1:02:05");
  assert.equal(clock(935), "15:35");
});

test("pickTrack: the uploader's captions in the spoken language, else automatic", () => {
  const t = (languageCode: string, kind?: string) => ({baseUrl: languageCode + (kind ?? ""), languageCode, kind});
  const tracks = [t("de-DE"), t("en", "asr"), t("en"), t("ja")];
  assert.equal(pickTrack(tracks)?.baseUrl, "en");
  assert.equal(pickTrack(tracks, "de")?.baseUrl, "de-DE");
  assert.equal(pickTrack([t("es", "asr")])?.baseUrl, "esasr");
  assert.equal(pickTrack([t("ko")], "en"), undefined);
  const dubbed = [t("ar", "asr"), t("en-US", "asr"), t("es", "asr")]; // automatic captions for each dub
  assert.equal(pickTrack(dubbed, undefined, "es-US")?.baseUrl, "esasr");
});

test("json3Words: per-word offsets, and caption lines split into words", () => {
  const j = {events: [
    {tStartMs: 1000, dDurationMs: 3000, segs: [{utf8: "Before"}, {utf8: " we", tOffsetMs: 240}]},
    {tStartMs: 1430, dDurationMs: 2410, aAppend: 1, segs: [{utf8: "\n"}]},
    {tStartMs: 5000, dDurationMs: 2000, segs: [{utf8: "♪ You know\nthe rules ♪"}]},
  ]};
  const w = json3Words(j);
  assert.deepEqual(w.map((x) => x.word), ["Before", "we", "♪", "You", "know", "the", "rules", "♪"]);
  assert.deepEqual([w[0].start, w[1].start, w[2].start], [1, 1.24, 5]);
  assert.ok(w[0].end <= w[1].start);
});

test("fixQuotes: mis-decoded smart quotes in English captions, and only there", () => {
  const w = (word: string) => ({start: 0, end: 0, word});
  const bad = ["Iím", "doing", "weíre", "andÖ", "Itís", "ìhelloî"].map(w);
  assert.deepEqual(fixQuotes(bad, "en").map((x) => x.word), ["I’m", "doing", "we’re", "and…", "It’s", "“hello”"]);
  assert.deepEqual(fixQuotes(bad, "es").map((x) => x.word), bad.map((x) => x.word));
  assert.deepEqual(fixQuotes([...bad, w("itóthe"), w("ñ")], "en").slice(-2).map((x) => x.word), ["it—the", "–"]);
  const fine = ["María", "María", "María", "Peña"].map(w); // names, not mis-decoding
  assert.deepEqual(fixQuotes(fine, "en"), fine);
});
