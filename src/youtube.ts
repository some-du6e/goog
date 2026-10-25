// YouTube transcripts, for schoolwork that lives in a video.
//
// YouTube won't give a script the captions its web player shows: their URLs
// answer an empty body without a token the player computes, and the
// transcript panel's API fails its precondition check. Its player API asked
// as the iOS app gives caption URLs that work without one, as yt-dlp found;
// that's about a second for an hour of video. If YouTube shuts that door,
// youtube-transcript.ai's cache of transcripts its visitors have fetched
// (word timings, lower case) covers videos someone has looked up there.

const PLAYER = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const IOS = {clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82"};
const IOS_AGENT = "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)";
const CACHE = "https://vttapi.sky9457.workers.dev";

export interface Word {
  start: number; // seconds
  end: number;
  word: string;
}

export interface Transcript {
  id: string;
  url: string;
  title?: string;
  lang: string;
  auto: boolean; // YouTube's automatic captions, not the uploader's
  duration: number; // seconds, to the last word
  words: Word[];
  languages?: string[]; // every caption language the video has
}

// youtu.be/ID, youtube.com/watch?v=ID, /embed/ID, /shorts/ID, /live/ID, or the
// bare 11-character id. Null when it isn't a YouTube video.
export function parseVideo(arg: string): string | null {
  const s = arg.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  if (!/^(https?:\/\/)?([\w-]+\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(s)) return null;
  const u = new URL(/^https?:/.test(s) ? s : `https://${s}`);
  const id = u.hostname.endsWith("youtu.be") ? u.pathname.slice(1).split("/")[0]
    : u.searchParams.get("v") ?? /^\/(?:embed|shorts|live|v)\/([\w-]{11})/.exec(u.pathname)?.[1];
  if (id === "videoseries") throw new Error(`"${arg}" is a playlist, not a video`);
  if (!id || !/^[\w-]{11}$/.test(id)) throw new Error(`can't find a video id in "${arg}"`);
  return id;
}

const get = async (url: string, init: RequestInit = {}) => {
  try {
    return await fetch(url, {...init, signal: AbortSignal.timeout(30_000)});
  } catch (e: any) {
    throw new Error(`can't reach YouTube (${e?.cause?.code ?? e?.message}); check the network connection`);
  }
};

interface Track {
  baseUrl: string;
  languageCode: string;
  kind?: string; // "asr" for automatic captions
}

// The uploader's captions in the language asked for, else automatic ones in
// it; with no language, the uploader's in the spoken language, else the
// automatic, else the first. The spoken language is the audio's when YouTube
// says (a video dubbed into other languages has automatic captions in each),
// else the automatic captions'.
export function pickTrack(tracks: Track[], lang?: string, audio?: string): Track | undefined {
  const human = (t: Track) => t.kind !== "asr";
  const is = (t: Track, l: string) => t.languageCode === l || t.languageCode.startsWith(`${l}-`);
  if (lang) return tracks.find((t) => is(t, lang) && human(t)) ?? tracks.find((t) => is(t, lang));
  const spoken = (audio ?? tracks.find((t) => !human(t))?.languageCode)?.split("-")[0];
  const asr = (spoken ? tracks.find((t) => !human(t) && is(t, spoken)) : undefined) ?? tracks.find((t) => !human(t));
  return (spoken ? tracks.find((t) => human(t) && is(t, spoken)) : undefined) ?? asr ?? tracks[0];
}

// YouTube's json3 caption format: events with segments, each offset from its
// event's start. Automatic captions have a segment per word.
export function json3Words(j: any): Word[] {
  const words: Word[] = [];
  for (const e of j?.events ?? []) {
    const at = (e.tStartMs ?? 0) / 1000;
    const end = at + (e.dDurationMs ?? 0) / 1000;
    for (const seg of e.segs ?? []) {
      const start = at + (seg.tOffsetMs ?? 0) / 1000;
      for (const word of String(seg.utf8 ?? "").split(/\s+/).filter(Boolean)) words.push({start, end, word});
    }
  }
  for (let i = 0; i + 1 < words.length; i++) words[i].end = Math.max(words[i].start, Math.min(words[i].end, words[i + 1].start));
  return words;
}

// Captions saved as Windows-1252 and read back as Mac Roman turn ’ “ ” …
// into í ì î Ö ("Iím", "andÖ"), and – — into ñ ó. English has no í, so in
// an English track that shows the pattern a few times, put them back. A real
// ñ or ó in such a track would have come out as Ò or Û, so every one is a dash.
export function fixQuotes(words: Word[], lang: string): Word[] {
  if (!lang.startsWith("en")) return words;
  const odd = words.filter((w) => /\wí\w|Ö$/.test(w.word)).length;
  if (odd < 3) return words;
  const map: Record<string, string> = {"í": "’", "ì": "“", "î": "”", "Ö": "…", "ñ": "–", "ó": "—"};
  return words.map((w) => ({...w, word: w.word.replace(/[íìîÖñó]/g, (c) => map[c])}));
}

async function fromYouTube(id: string, lang?: string): Promise<Transcript | {error: string}> {
  const r = await get(PLAYER, {
    method: "POST",
    headers: {"Content-Type": "application/json", "User-Agent": IOS_AGENT},
    body: JSON.stringify({context: {client: {...IOS, hl: "en"}}, videoId: id}),
  });
  if (!r.ok) return {error: `YouTube answered ${r.status}`};
  const p: any = await r.json();
  const status = p.playabilityStatus?.status;
  if (status !== "OK") return {error: p.playabilityStatus?.reason ?? `YouTube says ${status ?? "nothing"}`};
  const list = p.captions?.playerCaptionsTracklistRenderer;
  const tracks: Track[] = list?.captionTracks ?? [];
  const audio: string | undefined = list?.audioTracks?.[list?.defaultAudioTrackIndex ?? 0]?.audioTrackId?.split(".")[0];
  const languages = [...new Set(tracks.map((t) => t.languageCode))];
  if (!tracks.length) return {error: "it has no captions"};
  const t = pickTrack(tracks, lang, audio);
  if (!t) return {error: `it has no captions in "${lang}"; it has ${languages.join(", ")}`};
  const c = await get(`${t.baseUrl}&fmt=json3`, {headers: {"User-Agent": IOS_AGENT}});
  const body = c.ok ? await c.text() : "";
  if (!body.trimStart().startsWith("{")) return {error: "YouTube refused the captions"};
  const words = fixQuotes(json3Words(JSON.parse(body)), t.languageCode);
  if (!words.length) return {error: "its captions are empty"};
  return {
    id, url: `https://youtu.be/${id}`, title: p.videoDetails?.title, lang: t.languageCode, auto: t.kind === "asr",
    duration: Math.round(words[words.length - 1].end), words, languages,
  };
}

async function fromCache(id: string, lang: string): Promise<Transcript | null> {
  const r = await fetch(`${CACHE}/get?videoId=${encodeURIComponent(id)}&lang=${encodeURIComponent(lang)}`, {signal: AbortSignal.timeout(30_000)}).catch(() => null);
  if (!r?.ok) return null;
  const words: Word[] | undefined = (await r.json().catch(() => null))?.words;
  if (!words?.length) return null;
  return {id, url: `https://youtu.be/${id}`, lang, auto: true, duration: Math.round(words[words.length - 1].end), words};
}

export async function transcript(id: string, opts: {lang?: string} = {}): Promise<Transcript> {
  const yt = await fromYouTube(id, opts.lang);
  if (!("error" in yt)) return yt;
  // Only worth asking when YouTube itself refused; a video with no captions
  // has none there either.
  if (/refused|answered/.test(yt.error)) {
    const c = await fromCache(id, opts.lang ?? "en");
    if (c) return c;
  }
  throw new Error(`no transcript for https://youtu.be/${id}: ${yt.error}`);
}

export const clock = (s: number) => {
  const t = Math.floor(s);
  const hms = [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60];
  return (hms[0] ? `${hms[0]}:${String(hms[1]).padStart(2, "0")}` : String(hms[1])) + `:${String(hms[2]).padStart(2, "0")}`;
};

// One line per `every` seconds, each starting with its time: "[1:30] …".
export function timed(words: Word[], every = 30): string {
  const lines: string[] = [];
  let at = -1;
  let line: string[] = [];
  for (const w of words) {
    const slot = Math.floor(w.start / every);
    if (slot !== at && line.length) {
      lines.push(line.join(" "));
      line = [];
    }
    if (!line.length) line.push(`[${clock(w.start)}]`);
    at = slot;
    line.push(w.word);
  }
  if (line.length) lines.push(line.join(" "));
  return lines.join("\n");
}
