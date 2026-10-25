// Google Classroom, read-only: what's due, and which files are yours to edit.
//
// A student's own copy of a "make a copy for each student" doc is in the
// submission's attachments, not the assignment's materials; that copy is the
// one to goog edit. The imported token has the classroom.*.readonly and
// coursework.me scopes.

import {backends} from "./backend.ts";
import {parseVideo} from "./youtube.ts";
import {DRIVE, api} from "./google.ts";

export const CLASSROOM = "https://classroom.googleapis.com/v1";

export interface Attachment {
  title: string;
  url: string;
  kind: string; // doc, slides, sheet, form, drawing, file, link, youtube
  id?: string; // Drive file id
  share?: string; // a teacher's file: view, edit, or student-copy
  readable: boolean; // goog can read it (a Doc or Slides)
  // With progress: the words in your copy, and how many of them aren't in
  // the teacher's template; likewise pictures, charts and other objects, and
  // ticked checklist items. No template, no `*Added`.
  // The totals count the template's own text too: a blank copy of a long
  // worksheet has many words and 0 added.
  wordsTotal?: number;
  added?: number;
  objectsTotal?: number;
  objectsAdded?: number;
  ticksTotal?: number;
  ticksAdded?: number;
}

export interface Work {
  course: string;
  courseId: string;
  id: string;
  title: string;
  url: string;
  type: string; // assignment, question, …
  due?: string; // ISO time in UTC, when there's a due date
  dueLocal?: string; // the same in this machine's time zone, as text shows it
  created: string;
  points?: number;
  state: "assigned" | "turned-in" | "returned"; // assigned: not turned in (or taken back)
  missing: boolean; // past due and not turned in
  daysLate?: number; // when missing
  description?: string;
  materials: Attachment[]; // the teacher's
  yours: Attachment[]; // the submission's: your copies and what you attached
  // With progress: YouTube videos linked from inside the teacher's files,
  // which the work often depends on.
  videos?: {url: string; in: string}[];
}

export const isDone = (w: Work) => w.state !== "assigned";

// What's left to do: not turned in, and due in the last two weeks or later,
// or undated and set in the last month. Older work is usually abandoned.
export function isTodo(w: Work, now = Date.now()): boolean {
  if (isDone(w)) return false;
  const since = (days: number) => new Date(now - days * 86_400_000).toISOString();
  return w.due ? w.due >= since(14) : w.created >= since(30);
}

const lower = (s: string) => s.toLowerCase().replace(/_/g, "-");

function classroomPath(arg: string): string | null {
  const s = arg.trim();
  if (!/^(https?:\/\/)?classroom\.google\.com\//i.test(s)) return null;
  return new URL(/^https?:/i.test(s) ? s : `https://${s}`).pathname.replace(/\/u\/\d+(?=\/)/, "");
}
const unBase64 = (s: string) => (/^\d+$/.test(s) ? s : Buffer.from(s, "base64url").toString("utf8"));

// classroom.google.com/c/<base64 course id>/a/<base64 work id>/details, or
// courseId/workId. Questions are /sa/ and /mc/.
export function parseWorkRef(arg: string): {courseId: string; id: string} | null {
  const plain = /^(\d+)\/(\d+)$/.exec(arg.trim());
  if (plain) return {courseId: plain[1], id: plain[2]};
  const path = classroomPath(arg);
  if (path === null) return null;
  if (/^\/c\/[\w-]+\/m\//.test(path)) throw new Error(`"${arg}" is a class material, not an assignment; goog reads assignments, so open its files' own links`);
  const m = /^\/c\/([\w-]+)\/(?:a|sa|mc)\/([\w-]+)/.exec(path);
  if (!m) throw new Error(`"${arg}" isn't a Classroom assignment link; open the assignment and copy its URL`);
  const [courseId, id] = [unBase64(m[1]), unBase64(m[2])];
  if (!/^\d+$/.test(courseId) || !/^\d+$/.test(id)) throw new Error(`can't find the course and assignment ids in "${arg}"`);
  return {courseId, id};
}

// A class's link: its stream (/c/<base64 course id>), Classwork (/w/<id>/t/all)
// or People (/r/<id>/…) page. Its id.
export function parseCourseRef(arg: string): string | null {
  const path = classroomPath(arg) ?? "";
  const m = /^\/c\/([\w-]+)\/?$/.exec(path) ?? /^\/[wr]\/([\w-]+)(?:\/|$)/.exec(path);
  const id = m ? unBase64(m[1]) : "";
  return /^\d+$/.test(id) ? id : null;
}

const KIND: Record<string, string> = {document: "doc", presentation: "slides", spreadsheets: "sheet", forms: "form", drawings: "drawing"};
const GOOGLE = new Set(Object.values(KIND));

function attachment(m: any): Attachment | null {
  const f = m.driveFile?.driveFile ?? m.driveFile;
  if (f?.id) {
    const kind = KIND[/google\.com\/(\w+)\//.exec(f.alternateLink ?? "")?.[1] ?? ""] ?? "file";
    const share = m.driveFile?.shareMode ? lower(m.driveFile.shareMode) : undefined;
    const url = f.alternateLink?.replace(/\?usp=drive_web$/, "") ?? `https://drive.google.com/file/d/${f.id}`;
    // The link's id, not f.id: for a teacher's template f.id can be one you
    // can't open.
    const id = /\/d\/([\w-]+)/.exec(url)?.[1] ?? f.id;
    return {title: f.title?.trim() || f.id, url, kind, id, ...(share ? {share} : {}), readable: kind === "doc" || kind === "slides"};
  }
  if (m.youtubeVideo) return {title: m.youtubeVideo.title ?? "video", url: m.youtubeVideo.alternateLink, kind: "youtube", readable: false};
  if (m.link) return {title: m.link.title ?? m.link.url, url: m.link.url, kind: "link", readable: false};
  if (m.form) return {title: m.form.title ?? "form", url: m.form.formUrl, kind: "form", readable: false};
  return null;
}

// Classroom gives due dates in UTC. Its JSON leaves out fields that are 0, so
// a due time of {} is midnight; only a missing one means the end of the day.
export function dueOf(cw: any): string | undefined {
  const d = cw.dueDate;
  if (!d) return undefined;
  const t = cw.dueTime ?? {hours: 23, minutes: 59};
  return new Date(Date.UTC(d.year, d.month - 1, d.day, t.hours ?? 0, t.minutes ?? 0)).toISOString();
}

export function localTime(iso: string): string {
  const d = new Date(iso);
  const zone = d.toLocaleTimeString("en-US", {timeZoneName: "short"}).split(" ").pop();
  return `${d.toLocaleDateString("en-US", {weekday: "short", month: "short", day: "numeric"})} ${d.toTimeString().slice(0, 5)} ${zone}`;
}

const courseName = (c: any) => (c.section ? `${c.name} (${c.section})` : c.name);

function toWork(course: {id: string; name: string}, cw: any, sub: any, now = Date.now()): Work {
  const due = dueOf(cw);
  const raw = sub?.state ?? "NEW";
  const state = raw === "TURNED_IN" ? "turned-in" : raw === "RETURNED" ? "returned" : "assigned";
  const missing = state === "assigned" && !!due && Date.parse(due) < now;
  return {
    course: course.name,
    courseId: course.id,
    id: cw.id,
    title: cw.title?.trim() || "(untitled)",
    url: cw.alternateLink,
    type: lower(cw.workType ?? "assignment"),
    due,
    ...(due ? {dueLocal: localTime(due)} : {}),
    created: cw.creationTime,
    points: cw.maxPoints,
    state,
    missing,
    ...(missing ? {daysLate: Math.ceil((now - Date.parse(due!)) / 86_400_000)} : {}),
    description: cw.description,
    materials: (cw.materials ?? []).map(attachment).filter(Boolean),
    yours: (sub?.assignmentSubmission?.attachments ?? []).map(attachment).filter(Boolean),
  };
}

async function all(url: string, key: string): Promise<any[]> {
  const items: any[] = [];
  let page: string | undefined;
  do {
    const j = await api("GET", url + (url.includes("?") ? "&" : "?") + new URLSearchParams({pageSize: "100", ...(page ? {pageToken: page} : {})}));
    items.push(...(j[key] ?? []));
    page = j.nextPageToken;
  } while (page);
  return items;
}

// Classroom names your copies "<your name> - <template title>"; the name is
// noise in a list of your own files.
let me: Promise<string | null> | undefined;
async function stripName(ws: Work[]): Promise<Work[]> {
  me ??= api("GET", `${DRIVE}/about?fields=user(displayName)`).then((j) => j.user?.displayName ?? null, () => null);
  const name = await me;
  if (name) for (const w of ws) for (const a of w.yours) if (a.title.startsWith(`${name} - `)) a.title = a.title.slice(name.length + 3).trim();
  return ws;
}

export async function courses(): Promise<{id: string; name: string}[]> {
  const cs = await all(`${CLASSROOM}/courses?courseStates=ACTIVE&studentId=me`, "courses");
  return cs.map((c) => ({id: c.id, name: courseName(c)}));
}

// Everything assigned in the matching active courses, soonest due first.
export async function listWork(match?: string): Promise<Work[]> {
  let cs = await courses();
  if (match) {
    cs = cs.filter((c) => c.id === match.trim() || c.name.toLowerCase().includes(match.toLowerCase()));
    if (!cs.length) throw new Error(`no active class has the id "${match}" or that in its name; goog classroom classes lists them`);
  }
  const per = await Promise.all(cs.map(async (c) => {
    const [cws, subs] = await Promise.all([
      all(`${CLASSROOM}/courses/${c.id}/courseWork?courseWorkStates=PUBLISHED`, "courseWork"),
      all(`${CLASSROOM}/courses/${c.id}/courseWork/-/studentSubmissions?userId=me`, "studentSubmissions"),
    ]);
    const byWork = new Map(subs.map((s) => [s.courseWorkId, s]));
    return cws.map((cw) => toWork(c, cw, byWork.get(cw.id)));
  }));
  // Undated work goes last.
  const key = (w: Work) => w.due ?? "~";
  return stripName(per.flat().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)));
}

export async function getWork(ref: {courseId: string; id: string}): Promise<Work> {
  const [course, cw, subs] = await Promise.all([
    api("GET", `${CLASSROOM}/courses/${ref.courseId}`),
    api("GET", `${CLASSROOM}/courses/${ref.courseId}/courseWork/${ref.id}`),
    all(`${CLASSROOM}/courses/${ref.courseId}/courseWork/${ref.id}/studentSubmissions?userId=me`, "studentSubmissions"),
  ]);
  const w = toWork({id: course.id, name: courseName(course)}, cw, subs[0]);
  return (await stripName([w]))[0];
}

// The file goog edit should open for an assignment: your own Doc or Slides
// copy, or failing that a teacher's file shared to edit.
export function editable(w: Work): Attachment {
  const mine = w.yours.filter((a) => a.readable);
  if (mine.length === 1) return mine[0];
  const list = (as: Attachment[]) => as.map((a) => `\n  ${a.kind}  ${a.url}  ${a.title}`).join("");
  if (mine.length > 1) throw new Error(`"${w.title}" has ${mine.length} files of yours; pick one:${list(mine)}`);
  // Only when nothing of yours is a Google file: a photo or PDF you attached
  // is no copy to edit, but your own Sheet is.
  const theirs = w.materials.filter((a) => a.readable && a.share === "edit");
  if (theirs.length === 1 && !w.yours.some((a) => GOOGLE.has(a.kind))) return theirs[0];
  throw new Error(`"${w.title}" has no Doc or Slides of yours to edit${w.yours.length || w.materials.length ? `. Its files:${list([...w.yours, ...w.materials])}` : ""}`);
}

// The words of a .goog file's text, without its tags.
export function words(text: string): string[] {
  const body = text.slice(text.indexOf("\n") + 1).replace(/<[^>]*>/g, " ").replace(/&[#\w]+;/g, " ");
  return body.split(/\s+/).filter(Boolean);
}

// Objects (images, charts, chips, drawings, …) and ticked checklist items,
// which words() can't see.
export function marks(text: string): {objects: number; ticks: number} {
  return {
    objects: (text.match(/<(img|image|obj|object|chip|equation|video|line|footnote)\b/g) ?? []).length,
    ticks: (text.match(/<li\b[^>]*\bchecked\b/g) ?? []).length,
  };
}

// A copy with nothing of yours in it yet.
export const isBlank = (a: Attachment) => a.added === 0 && !a.objectsAdded && !a.ticksAdded;

// How many of `mine` aren't in `template`, counting repeats.
export function addedWords(mine: string[], template: string[]): number {
  const left = new Map<string, number>();
  for (const w of template) left.set(w, (left.get(w) ?? 0) + 1);
  let added = 0;
  for (const w of mine) {
    const n = left.get(w) ?? 0;
    if (n) left.set(w, n - 1);
    else added++;
  }
  return added;
}

// The teacher's template a copy of yours came from: Classroom names copies
// "<your name> - <template title>".
// Classroom drops a leading "[Template]" from the copy's name.
function templateOf(w: Work, a: Attachment): Attachment | undefined {
  const ts = w.materials.filter((m) => m.share === "student-copy" && m.kind === a.kind && m.readable);
  const norm = (t: string) => t.replace(/^\s*\[template\]\s*/i, "").replace(/\s+/g, " ").trim().toLowerCase();
  const mine = norm(a.title);
  return ts.find((t) => mine === norm(t.title) || mine.endsWith(` - ${norm(t.title)}`)) ?? (ts.length === 1 ? ts[0] : undefined);
}

// YouTube videos a .goog text links to or embeds.
export function videosIn(text: string): string[] {
  const ids = new Set<string>();
  const links = /(?:[\w-]+\.)?(?:youtube(?:-nocookie)?\.com|youtu\.be)\/[^\s"<>]*|youtube="([\w-]{11})"/gi;
  for (const m of text.matchAll(links)) {
    if (m[1]) ids.add(m[1]);
    else {
      try {
        const id = parseVideo(m[0].replace(/&amp;/g, "&"));
        if (id) ids.add(id);
      } catch {} // a channel, playlist or search page
    }
  }
  return [...ids].map((id) => `https://youtu.be/${id}`);
}

// Fills in the progress fields on each Doc or Slides of yours in `ws`, and
// with `materials`, the videos linked from the teacher's files. `yours:
// false` skips the progress.
export async function measure(ws: Work[], opts: {materials?: boolean; yours?: boolean} = {}): Promise<void> {
  const texts = new Map<string, Promise<{words: string[]; objects: number; ticks: number; videos: string[]} | null>>();
  const read = (a: Attachment) => {
    if (!texts.has(a.id!)) {
      texts.set(a.id!, backends[a.kind as "doc" | "slides"].fetch(a.id!).then((f) => ({words: words(f.text), ...marks(f.text), videos: videosIn(f.text)}), () => null));
    }
    return texts.get(a.id!)!;
  };
  if (opts.materials) {
    await Promise.all(ws.map(async (w) => {
      const found: {url: string; in: string}[] = [];
      // Videos attached to the assignment are already listed as the teacher's.
      const files = w.materials.filter((a) => a.readable);
      const got = await Promise.all(files.map(read));
      files.forEach((a, i) => {
        for (const url of got[i]?.videos ?? []) if (!found.some((v) => v.url === url)) found.push({url, in: a.title});
      });
      w.videos = found;
    }));
  }
  if (opts.yours === false) return;
  await Promise.all(ws.flatMap((w) => w.yours.filter((a) => a.readable).map(async (a) => {
    const t = templateOf(w, a);
    const [mine, theirs] = await Promise.all([read(a), t ? read(t) : null]);
    if (!mine) return;
    Object.assign(a, {wordsTotal: mine.words.length, objectsTotal: mine.objects, ticksTotal: mine.ticks});
    if (theirs) {
      Object.assign(a, {
        added: addedWords(mine.words, theirs.words),
        objectsAdded: Math.max(0, mine.objects - theirs.objects),
        ticksAdded: Math.max(0, mine.ticks - theirs.ticks),
      });
    }
  })));
}
