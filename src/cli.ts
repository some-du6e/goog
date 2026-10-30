import {spawn} from "node:child_process";
import {closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync} from "node:fs";
import {basename, dirname, join, relative, resolve} from "node:path";
import {parseArgs} from "node:util";
import {authStatus, BROKER_MANIFEST, BROKER_SOURCE, BROKER_TEMPLATE, forgetToken, getToken, importAuthorizedUser, keepSignIn, loginWithClient} from "./auth.ts";
import {withBrowser} from "./browser.ts";
import {loadConfig, saveConfig} from "./config.ts";
import {installSkill, removeSkill, skillMissing, skillStatus} from "./skill.ts";
import {backendOfText, backends, kindOf} from "./backend.ts";
import {FormatError} from "./format.ts";
import {courses, editable, getWork, isBlank, isDone, isTodo, listWork, measure, parseCourseRef, parseWorkRef, type Attachment, type Work} from "./classroom.ts";
import {createDoc} from "./gdocs.ts";
import {clock, parseVideo, timed, transcript} from "./youtube.ts";
import {createDeck, drawNow, drawingPid, waitForDrawing} from "./slides.ts";
import {DEFAULT_WPM, type Typing} from "./typing.ts";
import {DRIVE, api} from "./google.ts";
import {cmdApi} from "./api-cmd.ts";
import {
  bodyOf, canonBody, imagesDir, isAlive, listStates, logPath, patch, pull, push, readBase, readState, readText, reconcile,
  resolveRef, watcherOf, forgetState, forgetBase,
} from "./sync.ts";
import {edit} from "./watch.ts";

// Exit codes, for scripts and agents.
export const EXIT = {ok: 0, error: 1, conflict: 2, timeout: 3} as const;

const HELP = `goog: edit Google Docs and Slides as local .goog files

Editing a doc
  1. goog edit <doc> --bg       pulls the doc into ./<id>.goog (one name per doc, so
                                it never clashes) and prints its path, its images,
                                and (when piped) its contents
  2. edit that file             any editor or tool; rewriting it whole is fine
  3. goog wait <file>           after each save. "synced" means the doc now matches
                                the file: that's the check, and you're done. Any
                                warnings after it name edits Docs couldn't take, and
                                the file now shows what the doc really has
  4. goog stop                  when you're finished
  A Slides deck works the same way; goog help slides has its format.

Live sync
  goog edit <doc> [-o FILE]     pull the doc into FILE (default <id>.goog) and keep it
                                synced: each save is pushed, browser edits are pulled
                                in and merged. Ctrl+C stops (after a last push).
      --bg                      run in the background: returns once the first sync is
                                done and prints the file; stop it with goog stop
      --pull | --push           FILE exists but was never synced: take the doc's
                                version, or make the doc match the file
      --poll SECONDS            how often to check the doc for edits (default 10)
  goog wait [file|doc]          after saving, block until goog edit has pushed that
                                save (all watched files if none given)
      --timeout SECONDS         default 120
  goog status [file|doc]        sync state of one file, or every known file
  goog stop [file|doc]          stop background goog edits (all if none given)
  goog log [file|doc] [-n N]    recent sync activity (pushes, pulls, errors)

One-shot
  goog pull <doc> [-o FILE]     download the doc into FILE. Refuses to drop unpushed
                                changes, or a file goog never synced that differs
                                from the doc, unless --force
  goog push <file> [--dry-run] [--type [--wpm N]]
                                send the file's changes to the doc once, merging with
                                edits made in the doc since the last sync
      --type                    type new text in, a few words a write at about 45
                                words a minute, so version history shows it typed
                                (docs only; slow — run it in the background)
      --wpm N                   typing speed for --type (default 45)
  goog diff <file>              what a push would change in the doc, as a unified diff
  goog cat <doc>                print the doc as .goog without writing a file
  goog pics <file>              a deck's slides as pictures, once they're drawn
      --timeout SECONDS         default 300
  goog check <file>             parse the file and report format errors

Drive
  goog ls [query]               recent docs and slides
  goog new <title> [--slides]   create a doc (or a deck) and print its id
  goog open <doc>               print the doc's URL
  goog auth [status|script [URL|FILE|-|--manual]|import <token.json>|client <client_secret.json>]

Any API call
  goog api <path>               call a Google API with goog's sign-in and print the JSON
                                answer, like gh api. <path> is <service>/<version>/…
                                (docs/v1/documents/ID, slides/v1/presentations/ID,
                                drive/v3/files, classroom/v1/courses) or a full
                                https://*.googleapis.com URL. A GET unless -X says
                                otherwise, or a POST with --input. Bodies are JSON.
                                Errors print Google's error and exit 1; other answers
                                (exports, alt=media) print as they are
      -X METHOD                 GET, POST, PUT, PATCH or DELETE
      -f key=value              a string field: a query parameter on GET and DELETE, a
                                JSON body field otherwise (a[b]=v nests, a[]=v lists).
                                fields=, alt= and Google's other standard parameters
                                always go in the query
      -F key=value              the same, but true, false, null and numbers keep their
                                type, and @FILE (@- for stdin) reads the value from FILE
      --query key=value         a query parameter whatever the method
                                (supportsAllDrives=true, updateMask=…)
      --input FILE              the JSON body (- for stdin); -f and -F then go in the
                                query
      -H 'Name: value'          an extra header
      --paginate                follow nextPageToken and join the pages' lists (GETs)
      --silent                  print nothing on success

Classroom
  goog classroom [class]        what's left to do in your classes (or one, by name, id
                                or link): work not turned in that's due in the last two
                                weeks or later, or undated and set this month, with
                                your copy of each file. Most urgent first: due next,
                                then missing, then undated
      --all                     everything not turned in, however old
      --done                    turned-in and returned work too
      --due DAYS                only work due within DAYS days (7 or 7d), missing
                                work included
      --full                    each assignment's whole instructions, not one line
      --progress                how much of each copy of yours is filled in: "blank",
                                or the words, images and ticks added to the teacher's
                                template (reads each doc, so a few seconds)
  goog classroom <assignment>   one assignment: instructions, the teacher's files,
                                and yours, with its progress
  goog classroom classes        your active classes
  goog transcript <video|assignment>
                                what a YouTube video says, a line per 30s with its
                                time ([12:30] …); for an assignment, every video it
                                attaches or its files link to. The uploader's captions
                                when there are some, else YouTube's automatic ones;
                                --lang es picks another language the video has;
                                --from 2:00 --to 15:35 keeps just that part
  <assignment> is its classroom.google.com link or the COURSE/WORK pair listed.
  goog edit, pull, cat and open take an <assignment> too, for your Doc or Slides
  copy in it. States: not turned in, missing (past due), turned-in, returned.
  Times are this machine's time zone; --json gives due in UTC and dueLocal.
  goog skill [install|remove]   the skill that teaches coding agents (Claude Code,
                                Codex) to edit docs with goog; status if none given
      --force                   install over a skill of the same name that isn't goog's

<doc> is a doc or deck id, a docs.google.com or drive.google.com URL, or a .goog file.
--json gives machine-readable output on status, wait, push, pull, diff, check,
pics, ls, new, stop, skill, classroom, transcript, edit (one event per line), log,
and errors ({"ok":false,"error":…}). A deck's pull and push say "drawing":true
while the slide pictures are drawn (false if the draw couldn't start), as does
edit --bg while a draw runs; goog pics --json lists them once they're done.
Exit codes: 0 ok, 1 error, 2 conflict (markers written to the file), 3 timed out.

Conflicts: when the doc and the file changed the same lines, the file gets
  <<<<<<< your file / ======= / >>>>>>> google doc
blocks and nothing is pushed. Edit them into the version you want, delete the
marker lines, and save (or goog push). That version replaces the doc's.

Run \`goog help format\` for the file format.`;

const FORMAT_HELP = `.goog format (one paragraph per line)

The file mirrors the doc: whatever you leave as pulled stays exactly as it is in
Docs, odd-looking spans included, so change only the text you mean to change.
New text takes the style of the tags around it; untagged text gets the paragraph's
default style, so to match neighbouring text, write inside the same tags.

  first line      <!-- goog doc DOC_ID · "Name" -->   (keep it; it says which doc)
  plain line      a normal paragraph
  <p></p>         an empty paragraph; <p align="center">…</p> for alignment
  <title> <subtitle> <h1>…<h6>      paragraph styles (also take align=)
  attributes      <p indent="36" first="0" dir="rtl" align="justify">;
                  <h2 id="h.x"> marks a link target (ids come from the doc; leave them as pulled)
  <li>…</li>      bullet; level="2" nests
  lists           <li type="1|01|a|A|i|I"> numbered, type="check" checklist,
                  type="★" etc. other bullets; start="N" marks where a separate list begins
                  (Docs can't set the number it starts counting from);
                  <li style="h2"> is a list item with a heading style
  <table>         rows on their own lines: <tr><td>a</td><td>b</td></tr>
                  multi-paragraph cells: <td><p>one</p><p>two</p></td>; <th> reads like <td>
                  <td colspan="2" rowspan="2" bg="#ffe699">; cells hidden by a merge are left out,
                  or written <td covered> when they hold something
  inline          <b> <i> <u> <s> <sup> <sub> <br> <a href="…">
                  <mark> (yellow) or <mark color="#00ff00"> highlight
                  <span color="#c00" font="Arial" size="14" weight="300" smallcaps> text style
                  <ins>/<del> are suggestions (read-only)
  checklists      <li type="check" checked> is a ticked item (read only; tick it in Docs)
  links           href="https://…", "#heading=h.x", "#bookmark=id", "#tab=t.1"
  objects         <img id="…">, <hr>, <footnote>, <chip type="person|link|date|dropdown">,
                  <equation>, <columnbreak>, <autotext type="page-number">, <obj type="…">:
                  keep or delete them. Ones you can add (leave out the id):
                    <img src="https://…">   <pagebreak> (not in tables)
                    <footnote text="…">      <chip type="person" email="…">
                    <chip type="date" date="2026-12-25">   <chip type="link" href="https://…">
                    <chip type="dropdown" value="Done">  (reuses a dropdown that has that option)
                    <chip type="dropdown" value="High" options="Low|Medium|High">  (a new kind)
                  Change a dropdown's value, or a date/person/link chip's date/email/href, in place.
                  The rest of the objects above are keep-or-delete.
  images          goog edit and goog pull save each image as <file>.files/<img id>.<ext>
                  (cer.goog -> cer.files/kix.x.png) so you can look at it
  blocks          <object kind="section-break" type="next-page">, <object kind="toc">
  segments        <header id>…</header>, <footer id>…</footer>, <footnote-text id>…</footnote-text>
                  (the text of <footnote id>); each on its own lines, after the tab's body
  tabs            <tab id="t.0" title="…" parent="…" icon="…"> on its own line starts each
                  tab (only when the doc has several); no closing tag. New tabs, headers
                  and footers can't be added from the file
  float="…"       on a paragraph: the ids of images positioned around it (keep as pulled)
  escaping        &lt; &gt; &amp; for literal < > &; &nbsp; &#x200b; etc. for invisible
                  characters; a line starting with ======= is written &#61;======
  blank lines     ignored; they're just spacing
`;

const SLIDES_HELP = `.goog format for Google Slides

The file mirrors the deck: whatever you leave as pulled stays exactly as it is,
so change only what you mean to. Pull and push also draw each slide as a
picture (<file>.files/slide-N.png) in the background; goog pics <file> waits
for them. Look at them before moving things.

  <slide id="…" layout="title-and-body">   one per slide, in order; <slide … skip>
                                           is skipped when presenting
  …objects, back to front…
  <notes>speaker notes, one paragraph per line</notes>
  </slide>

Objects (positions and sizes in points; the slide is usually 720 x 405):
  <shape id type="text-box" x y w h fill="#fff2cc" font size color>
  one paragraph per line, written as in a doc: <p align="center">, <b>, <li>,
  <span size="20">, <mark>, <a href>, <br>
  </shape>
  <image id x y w h alt="…">        the picture is <file>.files/<id>.png (or .jpg …);
                                    alt is its alt text
  <line id x1 y1 x2 y2 arrow="end">  from (x1,y1) to (x2,y2)
  <table id x y>
  <tr><td bg="#ead1dc">text</td></tr>
  </table>
  <video id x y w h youtube="…">  (or drive="FILE_ID")
  <group id>…</group>    <object id type=…>

  Shape types are Slides' shape names in lower case with dashes: text-box,
  rectangle, round-rectangle, ellipse, triangle, right-triangle, diamond,
  pentagon, hexagon, star-5, heart, cloud, right-arrow, chevron, moon, …
  fill="#d97757" fills a shape and outline="#000000" outline-width="1.5" (in
  points) draws its border; a shape without them has none.
  x y w h is the box before rotating: rot="-90" turns it clockwise (degrees)
  about its center, so a bar centered on (cx,cy) has x = cx - w/2, y = cy - h/2
  whatever its angle. flip="h" or "v" mirrors.
  font, size and color on a shape, table or notes tag are the text's usual
  style; spans inside only say where it differs. Colors are #rrggbb, a name
  like red, or a theme color: dark1 light1 dark2 light2 accent1…accent6.

Changing a deck
  edit text, move or resize (x y w h), recolor (fill, outline), move a line's ends, add
  or delete table rows or columns (at the right edge), write speaker notes, skip
  or unskip a slide.
  Delete a line to delete the object or slide; delete a <group> line and its
  </group> to ungroup what's inside.
  Group: wrap two or more objects in <group>…</group>, and move lines to add,
  remove or restack a group's members, at any depth (goog remakes the groups
  around it, a pass per level). Groups can't hold tables, videos or layout
  placeholders; a group that would is left as it is, with a warning.
  Add: a tag without an id. <shape> and <table> need nothing else;
  <image src="https://…"> needs a picture anyone can open; <video youtube="…">
  or <video drive="FILE_ID">;
  <line x1 y1 x2 y2>. A new <slide layout="…"> takes a layout from the
  comment at the top; its <shape placeholder="title"> or "body" fills the
  layout's boxes.
  Copy: paste a <slide> block or an object's line again, ids included; the
  copy gets new ids on push. An <object> can't be copied on its own.
  Order: move <slide> blocks to reorder slides, object lines to restack them.
  Can't: change a slide's layout or a shape's type, make <object>s.`;

// Shown to whoever runs plain `goog` while an agent on this machine lacks the
// skill. It's usually an agent, and installing changes the user's agent
// setup, so the agent asks first.
const SKILL_HINT = `Agents: goog has a skill that makes editing docs faster for you. Ask the
user whether to install it; if they say yes, run \`goog skill install\`.`;

function cmdSkill(sub: string | undefined, force: boolean, asJson: boolean) {
  if (sub === "install") {
    const r = installSkill(force);
    if (asJson) return json({ok: true, agents: r});
    if (!r.length) return out("no coding agents found (looked for ~/.claude and ~/.codex)");
    for (const a of r) {
      out(a.done ? `installed for ${a.agent}: ${a.dir}`
        : a.state === "installed" ? `already installed for ${a.agent}`
        : `${a.dir} already exists and isn't goog's; goog skill install --force replaces it`);
    }
    return;
  }
  if (sub === "remove") {
    const r = removeSkill();
    if (asJson) return json({ok: true, agents: r});
    for (const a of r) out(a.done ? `removed from ${a.agent}` : `not installed for ${a.agent}`);
    return;
  }
  if (sub && sub !== "status") throw new Error(`unknown goog skill command "${sub}"; use install, remove, or nothing for status`);
  const st = skillStatus();
  if (asJson) return json({ok: true, agents: st});
  if (!st.length) return out("no coding agents found (looked for ~/.claude and ~/.codex)");
  for (const a of st) out(`${a.agent}: ${a.state === "installed" ? "installed" : a.state === "missing" ? "not installed (goog skill install)" : `${a.dir} is someone else's skill`}`);
}

function out(s: string) {
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}

const json = (v: unknown) => out(JSON.stringify(v, null, 2));

async function cmdAuth(args: string[], manual = false) {
  const [sub, arg] = args;
  if (!sub || sub === "status") {
    out(`goog auth: ${authStatus()}`);
    if (authStatus() === "not set up") {
      out(`\nSet it up one of three ways:
  goog auth script     copies an Apps Script into your Drive and deploys it;
                       no browser needed afterwards, works with school
                       accounts that don't allow Cloud projects (recommended)
  goog auth client F   uses a Google Cloud OAuth client (Desktop app) JSON
  goog auth import F   reuses a refresh token from another tool (authorized_user token.json)`);
    }
    return;
  }
  // The checks below test the new sign-in, which $GOOG_TOKEN would stand in for.
  delete process.env.GOOG_TOKEN;
  // A file that isn't JSON may be a token; JSON.parse's error would quote it.
  const readJsonFile = (f: string) => {
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch (e: any) {
      throw new Error(e instanceof SyntaxError ? `${f} isn't a JSON file` : e.message);
    }
  };
  if (sub === "script") {
    if (manual) {
      out(`Without the template, the user makes the script by hand:

1. Open https://script.new, signed in to the account goog should use.
2. Paste this as Code.gs:

${BROKER_SOURCE}

3. Project Settings → "Show appsscript.json in editor", then set appsscript.json to:

${JSON.stringify(BROKER_MANIFEST, null, 2)}

4. Then deploy it as in steps 3-4 of \`goog auth script\`.`);
      return;
    }
    if (!arg) {
      out(`goog needs the user to sign in once (about a minute). Put these steps in
your reply to them as they are, link included, then get the URL from them.

1. Open this link, signed in to the Google account goog should use, and
   click "Make a copy":
   ${BROKER_TEMPLATE}
2. In the copy: Extensions → Apps Script → Deploy → New deployment → Deploy.
3. Authorize access → Advanced → Go to googity goog (unsafe) → Select all →
   Continue. "Unsafe" because Google hasn't reviewed it; it's their own copy.
4. Copy the Web app URL (the bottom one, ending in /exec) and send it back.

The URL works like a password. If you have a tool for asking the user for a
secret, ask for it with that instead of in the chat, and hand goog the file
(or stdin) rather than the URL itself.

If Apps Script won't open, they're signed in to several Google accounts:
a private window with only this one fixes it.

Then run: goog auth script <the /exec URL, or a file holding it, or - to
read it from stdin>
Never put the URL in files, commits or logs.
To revoke it: Deploy → Manage deployments → Archive.
No template: goog auth script --manual.`);
      return;
    }
    // The URL works like a password, so it can come from a file (or stdin, as
    // "-") and stay out of the command line and the agent's transcript.
    const url = arg === "-" ? readFileSync(0, "utf8").trim() : /^https?:/.test(arg) ? arg : readFileSync(arg, "utf8").trim();
    if (!/^https:\/\/script\.google\.com\/.*\/exec$/.test(url)) throw new Error("that isn't an Apps Script web app URL (https://script.google.com/…/exec)");
    const cfg = loadConfig();
    const before = structuredClone(cfg);
    cfg.broker = url;
    delete cfg.client;
    saveConfig(cfg);
    forgetToken(); // the cached token came from the old sign-in
    out("saved; checking it works…");
    let me: any;
    try {
      me = await api("GET", `${DRIVE}/about?fields=user(emailAddress)`);
    } catch (e: any) {
      saveConfig(before);
      forgetToken();
      throw new Error(`${e.message}; went back to the previous sign-in`);
    }
    out(`goog auth: OK, signed in as ${me.user.emailAddress}`);
    return;
  }
  if (sub === "import") {
    if (!arg) throw new Error("usage: goog auth import <token.json>");
    const cfg = loadConfig();
    const before = structuredClone(cfg);
    const restore = keepSignIn();
    cfg.client = importAuthorizedUser(readJsonFile(arg));
    saveConfig(cfg);
    out("saved; checking it works…");
    let me: any;
    try {
      await getToken();
      me = await api("GET", `${DRIVE}/about?fields=user(emailAddress)`);
    } catch (e: any) {
      saveConfig(before);
      restore();
      throw new Error(`${e.message}; went back to the previous sign-in`);
    }
    out(`goog auth: OK, signed in as ${me.user.emailAddress}`);
    return;
  }
  if (sub === "client") {
    if (!arg) throw new Error("usage: goog auth client <client_secret.json>");
    const j = readJsonFile(arg);
    const c = j.installed ?? j.web ?? j;
    const client = {client_id: c.client_id, client_secret: c.client_secret};
    await loginWithClient(client, async (url) => {
      out(`Opening the sign-in page in Chrome. If nothing appears, open:\n${url}`);
      await withBrowser(async (ctx) => {
        const page = await ctx.newPage();
        await page.goto(url);
      }).catch(() => {});
    });
    const cfg = loadConfig();
    cfg.client = client;
    saveConfig(cfg);
    out("goog auth: OK");
    return;
  }
  throw new Error(`unknown auth command "${sub}"`);
}


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (file: string) => {
  const r = relative(process.cwd(), file);
  return r && !r.startsWith("..") ? r : file;
};

// Files that status/wait/stop/log should look at.
function targets(arg: string | undefined, onlyWatched: boolean): string[] {
  if (!arg) return listStates().filter((s) => !onlyWatched || watcherOf(s.file)).map((s) => s.file);
  if (arg.endsWith(".goog") || existsSync(arg)) return [resolve(arg)];
  const ref = resolveRef(arg);
  return listStates().filter((s) => s.id === ref.id && (!onlyWatched || watcherOf(s.file))).map((s) => s.file);
}

interface FileStatus {
  file: string;
  id?: string;
  watching: boolean;
  pid?: number;
  status: string;
  unpushed: boolean | null; // null: can't tell (never synced, or doesn't parse)
  message?: string;
  line?: number;
  at?: string;
}

function fileStatus(file: string): FileStatus {
  const s = readState(file);
  const w = watcherOf(file);
  if (!existsSync(file)) return {file, id: s?.id, watching: !!w, pid: w?.pid, status: "missing", unpushed: null, message: "the file doesn't exist"};
  const ft = readText(file);
  if (w) {
    const fresh = w.hash === ft.hash;
    const status = fresh ? w.status : "pushing";
    return {
      file, id: w.id, watching: true, pid: w.pid, status, unpushed: !(fresh && w.status === "synced"),
      message: fresh ? w.message : "saved; goog edit is about to push it", line: fresh ? w.line : undefined, at: w.at,
    };
  }
  const id = /goog\s+\w+\s+(\S+)/.exec(ft.text)?.[1] ?? s?.id;
  const base = readBase(file, id);
  if (!base) return {file, id, watching: false, status: "not synced", unpushed: null, message: "goog has no record of syncing this file"};
  let unpushed: boolean | null = null;
  try {
    unpushed = canonBody(ft.text) !== bodyOf(base.text);
  } catch (e: any) {
    return {file, id, watching: false, status: "error", unpushed: null, message: e.message, line: e.line};
  }
  return {file, id, watching: false, status: "not watched", unpushed, message: unpushed ? "has changes not pushed yet" : "matches the last sync", at: base.at};
}

function printStatus(st: FileStatus) {
  const where = st.watching ? `goog edit pid ${st.pid}` : "";
  out(`${show(st.file)}: ${st.status}${st.message ? ` (${st.message})` : ""}${where ? ` [${where}]` : ""}`);
}

async function cmdWait(arg: string | undefined, timeoutS: number, asJson: boolean) {
  const files = targets(arg, !arg);
  if (!files.length) throw new Error(arg ? `nothing is syncing ${arg}; run goog edit ${arg} first (or goog push for a one-off)` : "no goog edit is running");
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const res = files.map((file) => {
      const s = watcherOf(file);
      if (!s) {
        return {file, done: true, code: EXIT.error, status: "not watched", message: `no goog edit is running for ${show(file)}; goog push ${show(file)} sends it once`};
      }
      if (!existsSync(file)) return {file, done: true, code: EXIT.error, status: "missing", message: `${show(file)} doesn't exist`};
      const fresh = s.hash === readText(file).hash;
      if (fresh && s.status === "synced") return {file, done: true, code: EXIT.ok, status: "synced", message: s.message};
      if (fresh && s.status === "conflict") return {file, done: true, code: EXIT.conflict, status: "conflict", message: s.message, line: s.line};
      if (fresh && s.status === "error") return {file, done: true, code: EXIT.error, status: "error", message: s.message, line: s.line};
      return {file, done: false, code: EXIT.timeout, status: fresh ? s.status : "pushing", message: fresh ? s.message : "waiting for goog edit to pick up the save"};
    });
    const timedOut = Date.now() > deadline;
    if (res.every((r) => r.done) || timedOut) {
      const code = Math.max(...res.map((r) => (r.done ? r.code : EXIT.timeout)));
      if (asJson) json({ok: code === 0, files: res.map(({done: _d, code: _c, ...r}) => ({...r, file: r.file}))});
      else {
        for (const r of res) {
          const what = r.done ? r.status : `still ${r.status} after ${timeoutS}s`;
          out(`${res.length > 1 ? `${show(r.file)}: ` : ""}${what}${r.message ? `: ${r.message}` : ""}`);
        }
      }
      process.exitCode = code;
      return;
    }
    await sleep(200);
  }
}

async function cmdEditBackground(id: string, file: string, extra: string[], asJson: boolean) {
  const other = watcherOf(file);
  if (other) {
    if (asJson) return json({ok: true, file, id, pid: other.pid, status: other.status, already: true});
    return out(`${show(file)} is already being synced (pid ${other.pid}); goog stop ${show(file)} ends it`);
  }
  const errPath = logPath(file).replace(/\.log$/, ".err");
  mkdirSync(dirname(errPath), {recursive: true});
  const errFd = openSync(errPath, "w");
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "edit", id, "-o", file, "--quiet", ...extra], {
    detached: true,
    stdio: ["ignore", "ignore", errFd],
  });
  closeSync(errFd);
  let exited: number | null = null;
  child.on("exit", (code) => (exited = code ?? 1));
  const deadline = Date.now() + 120_000;
  for (;;) {
    await sleep(150);
    if (exited !== null) {
      const err = readFileSync(errPath, "utf8").trim().replace(/^goog: /, "");
      throw new Error(err || `goog edit exited (${exited}) before syncing`);
    }
    const s = readState(file);
    const ready = s?.pid === child.pid && ["synced", "conflict", "error", "offline", "retrying"].includes(s!.status);
    if (ready || Date.now() > deadline) {
      child.unref();
      const status = ready ? s!.status : "starting";
      const drawing = drawingPid(imagesDir(file)) ? true : undefined;
      if (asJson) json({ok: true, file, id, pid: child.pid, status, message: s?.message, images: savedImages(file), drawing});
      else {
        out(`watching ${show(file)} (pid ${child.pid}): ${status}${s?.message ? `: ${s.message}` : ""}`);
        out(`after saving: goog wait ${show(file)}   activity: goog log ${show(file)}   stop: goog stop ${show(file)}`);
        if (drawing) out(DRAWING_NOTE(file));
        else outImages(savedImages(file));
        outContents(file);
      }
      return;
    }
  }
}

function savedImages(file: string): string[] {
  const dir = imagesDir(file);
  return existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".")).map((f) => join(dir, f)) : [];
}

const DRAWING_NOTE = (file: string) => `slides as pictures: being drawn in the background into ${show(imagesDir(file))}/slide-N.png; goog pics ${show(file)} waits for them and lists them (look before moving things)`;

async function cmdPics(arg: string | undefined, timeoutS: number, asJson: boolean) {
  const file = need(arg, "goog pics <file>");
  if (!existsSync(file)) throw new Error(`${file} doesn't exist`);
  const dir = imagesDir(file);
  if (!existsSync(dir)) throw new Error(`${file} has no pictures yet; goog pull ${show(file)} draws them`);
  const w = await waitForDrawing(dir, timeoutS * 1000);
  if (w.status === "failed") throw new Error(w.message);
  if (w.status === "drawing") {
    process.exitCode = EXIT.timeout;
    return asJson ? json({ok: false, file, status: "drawing", message: w.message}) : out(w.message);
  }
  if (asJson) return json({ok: true, file, status: "done", images: savedImages(file)});
  outImages(savedImages(file));
}

function outImages(images: string[]) {
  const isSlide = (f: string) => /(^|\/)slide-\d+\.png$/.test(f);
  const n = (f: string) => Number(/slide-(\d+)/.exec(f)![1]);
  const slides = images.filter(isSlide).sort((a, b) => n(a) - n(b));
  const pics = images.filter((f) => !isSlide(f));
  // Long lists as a folder and a pattern, so they don't bury the file.
  if (slides.length > 4) out(`slides as pictures (look before moving things): ${show(dirname(slides[0]))}/slide-1.png … slide-${slides.length}.png`);
  else if (slides.length) out(`slides as pictures (look before moving things): ${slides.map(show).join("  ")}`);
  if (pics.length > 6) out(`${pics.length} images in ${show(dirname(pics[0]))}/, named by their id (<id>.png, .jpg …)`);
  else if (pics.length) out(`images (named by their id): ${pics.map(show).join("  ")}`);
}

// When output goes to a program (an agent's shell), it gets the file too, so
// reading the doc doesn't take another command. A terminal just gets the path.
function outContents(file: string) {
  if (!process.stdout.isTTY && existsSync(file)) out(`\n${readFileSync(file, "utf8")}`);
}

async function cmdStop(arg: string | undefined, asJson: boolean) {
  const files = targets(arg, true);
  const stopped: {file: string; pid: number; clean: boolean}[] = [];
  for (const file of files) {
    const s = watcherOf(file);
    if (!s) continue;
    process.kill(s.pid, "SIGTERM");
    const deadline = Date.now() + 60_000;
    while (isAlive(s.pid) && Date.now() < deadline) await sleep(100);
    stopped.push({file, pid: s.pid, clean: !isAlive(s.pid)});
  }
  if (asJson) return json({ok: true, stopped});
  if (!stopped.length) return out(arg ? `nothing is syncing ${arg}` : "no goog edit is running");
  for (const s of stopped) out(`${s.clean ? "stopped" : "still stopping"} ${show(s.file)} (pid ${s.pid})`);
}

function cmdLog(arg: string | undefined, n: number, asJson: boolean) {
  const files = targets(arg, false);
  if (arg && !files.length) throw new Error(`no log for ${arg}`);
  const events: any[] = [];
  for (const f of files) {
    if (!existsSync(logPath(f))) continue;
    for (const line of readFileSync(logPath(f), "utf8").split("\n")) {
      try {
        if (line) events.push(JSON.parse(line));
      } catch {}
    }
  }
  events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const last = events.slice(-n);
  if (asJson) return json(last);
  if (!last.length) return out("no activity logged yet");
  for (const e of last) {
    const t = new Date(e.at);
    const stamp = `${t.toLocaleDateString("en-CA")} ${t.toTimeString().slice(0, 8)}`;
    out(`${stamp} ${files.length > 1 ? `${basename(e.file)} ` : ""}${e.event} ${e.message}`);
  }
}

// A Classroom assignment link stands for your own copy of its doc.
async function docRef(arg: string) {
  const w = parseWorkRef(arg);
  return w ? resolveRef(editable(await getWork(w)).url) : resolveRef(arg);
}

function outWork(w: Work, full: boolean, instructions = false) {
  // Undated work says when it was set, which also tells apart assignments
  // that share a title.
  const due = w.dueLocal ? `due ${w.dueLocal}` : `no due date, set ${new Date(w.created).toLocaleDateString("en-US", {month: "short", day: "numeric"})}`;
  const state = w.missing ? `missing, ${w.daysLate} day${w.daysLate === 1 ? "" : "s"} late` : w.state === "assigned" ? "not turned in" : w.state;
  out(`${w.course} › ${w.title}`);
  out(`  ${[due, state, w.points ? `${w.points} pts` : "", `id ${w.courseId}/${w.id}`].filter(Boolean).join(" · ")}`);
  const about = w.description?.trim().replace(/\s+/g, " ");
  if (!full && about) out(instructions ? `  ${w.description!.trim().replace(/\n\s*\n/g, "\n").replace(/\n/g, "\n  ")}` : `  ${about.length > 100 ? `${about.slice(0, 99)}… (--full)` : about}`);
  const unreadable = (a: Attachment) => (a.readable || a.kind === "youtube" || a.kind === "link" ? "" : " (goog can't open it)");
  if (full) {
    out(`  ${w.url}`);
    out(w.description?.trim() ? `\n${w.description.trim().replace(/^/gm, "  ")}\n` : `  no instructions on the assignment${w.materials.length ? "; they're likely in the teacher's files" : ""}`);
    const share: Record<string, string> = {"student-copy": " (template: you get your own copy)", edit: " (shared to edit)"};
    for (const a of w.materials) out(`  teacher's ${a.kind}${share[a.share ?? ""] ?? ""}: ${a.title}  ${a.url}${unreadable(a)}`);
    for (const v of w.videos ?? []) out(`  video linked in "${v.in}": ${v.url}`);
    if (w.videos?.length || w.materials.some((a) => a.kind === "youtube")) out(`  goog transcript ${w.courseId}/${w.id} prints what the videos say`);
  }
  for (const a of w.yours) {
    const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
    const progress = isBlank(a) ? "blank, "
      : a.added !== undefined ? `${[n(a.added, "word"), a.objectsAdded ? n(a.objectsAdded, "image/object") : "", a.ticksAdded ? n(a.ticksAdded, "tick") : ""].filter(Boolean).join(", ")} added, `
      : a.wordsTotal !== undefined ? `${n(a.wordsTotal, "word")} (no template to compare with, so some may be the teacher's), ` : "";
    out(`  your ${a.kind}: ${progress}${a.title}  ${a.url}${unreadable(a)}`);
  }
  if (!w.yours.length && !full) {
    const kinds = new Map<string, number>();
    for (const a of w.materials) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
    const noun = (k: string, n: number) => {
      const one = k === "slides" ? "deck" : k === "youtube" ? "video" : k;
      return `${n} ${one}${n > 1 ? "s" : ""}`;
    };
    const attached = kinds.size ? `; the teacher attached ${[...kinds].map(([k, n]) => noun(k, n)).join(", ")}` : "";
    const template = w.materials.some((a) => a.share === "student-copy");
    out(template ? `  no files of yours yet${attached}; your copy is made when you open the assignment in Classroom once`
      : `  nothing of yours to edit${attached ? `${attached} to read` : ""}; the work is done elsewhere (a form, on paper, or a file you attach)`);
  }
}

async function cmdClassroom(pos: string[], opts: {all: boolean; done: boolean; progress: boolean; full: boolean; due?: string}, asJson: boolean) {
  if (pos[0] === "classes") {
    const cs = await courses();
    if (asJson) return json(cs);
    for (const c of cs) out(`${c.id}  ${c.name}`);
    return;
  }
  const course = pos.length === 1 ? parseCourseRef(pos[0]) : null;
  const ref = pos.length === 1 && !course ? parseWorkRef(pos[0]) : null;
  if (ref) {
    const w = await getWork(ref);
    await measure([w], {materials: true});
    return asJson ? json(w) : outWork(w, true);
  }
  let days: number | undefined;
  if (opts.due !== undefined) {
    const m = /^(\d+)d?$/.exec(opts.due.trim());
    if (!m) throw new Error(`--due takes a number of days, like 7 or 7d (got "${opts.due}")`);
    days = Number(m[1]);
  }
  const listed = (await listWork(course ?? (pos.join(" ") || undefined)))
    .filter((w) => days === undefined || (!!w.due && Date.parse(w.due) < Date.now() + days * 86_400_000));
  const ws = listed.filter((w) => (opts.done || !isDone(w)) && (opts.all || opts.done || isTodo(w)));
  // Older work the default leaves out, so nobody takes the list for everything.
  const hidden = listed.filter((w) => !opts.all && !opts.done && !isDone(w) && !isTodo(w));
  if (opts.progress) await measure(ws);
  if (asJson) return json(ws);
  const older = hidden.length
    ? `${hidden.length} older not turned in (${hidden.filter((w) => w.missing).length} missing) not shown; --all lists them`
    : "";
  if (!ws.length && older) return out(`nothing recent to do; ${older}`);
  if (!ws.length) return out(days !== undefined ? `nothing due in the next ${days} day${days === 1 ? "" : "s"}` : opts.done ? "no assignments" : "nothing to do (--done lists turned-in work too)");
  const done = ws.filter(isDone).length;
  const left = ws.filter((w) => !isDone(w));
  const missing = left.filter((w) => w.missing).length;
  const week = left.filter((w) => !w.missing && w.due && Date.parse(w.due) < Date.now() + 7 * 86_400_000).length;
  out(`${left.length} not turned in: ${missing} missing, ${week} due in the next 7 days, ${left.filter((w) => !w.due).length} with no due date${done ? `; plus ${done} turned in` : ""}`);
  if (older) out(older);
  out("");
  // Most urgent first: what can still be handed in on time, then late work
  // (most recent first, as the likeliest to still count), then undated work.
  const soon = left.filter((w) => w.due && !w.missing);
  const late = left.filter((w) => w.missing).reverse();
  const undated = left.filter((w) => !w.due).sort((a, b) => b.created.localeCompare(a.created));
  const sections: [string, Work[]][] = [["Due next", soon], ["Missing", late], ["No due date", undated], ["Turned in", ws.filter(isDone)]];
  for (const [name, list] of sections) {
    if (!list.length) continue;
    out(`== ${name} (${list.length})`);
    for (const w of list) {
      outWork(w, false, opts.full);
      out("");
    }
  }
}

// A video, or every video an assignment shows or links from its files.
async function cmdTranscript(arg: string, opts: {lang?: string; from?: string; to?: string}, asJson: boolean) {
  const at = (v: string | undefined, flag: string) => {
    if (v === undefined) return undefined;
    const m = /^(?:(\d+):)?(\d+):(\d{1,2})$|^(\d+)$/.exec(v.trim());
    if (!m) throw new Error(`${flag} takes a time like 15:35, 1:02:00 or 90 (seconds); got "${v}"`);
    return m[4] !== undefined ? Number(m[4]) : Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  };
  const from = at(opts.from, "--from") ?? 0;
  const to = at(opts.to, "--to") ?? Infinity;
  const lang = opts.lang;
  const work = parseWorkRef(arg);
  let videos: {id: string; title?: string}[];
  if (work) {
    const w = await getWork(work);
    await measure([w], {materials: true, yours: false});
    const urls = [...w.materials.filter((a) => a.kind === "youtube").map((a) => ({url: a.url, title: a.title})), ...(w.videos ?? []).map((v) => ({url: v.url, title: `linked in "${v.in}"`}))];
    const idOf = (url: string) => {
      try {
        return parseVideo(url);
      } catch {
        return null; // a playlist
      }
    };
    videos = urls.map((v) => ({id: idOf(v.url)!, title: v.title})).filter((v, i, all) => v.id && all.findIndex((o) => o.id === v.id) === i);
    if (!videos.length) throw new Error(`"${w.title}" has no YouTube videos, attached or linked from the teacher's files`);
  } else {
    const id = parseVideo(arg);
    if (!id) throw new Error(`"${arg}" isn't a YouTube link, video id, or Classroom assignment`);
    videos = [{id}];
  }
  // One video without captions shouldn't cost the others.
  const got = (await Promise.allSettled(videos.map((v) => transcript(v.id, {lang})))).map((r, i) => ({
    ...videos[i],
    from: videos[i].title,
    t: r.status === "fulfilled" ? {...r.value, words: r.value.words.filter((w) => w.start >= from && w.start < to)} : undefined,
    error: r.status === "rejected" ? String(r.reason?.message ?? r.reason) : undefined,
  }));
  const failed = got.flatMap((g) => (g.error ? [g.error] : []));
  if (failed.length === got.length) {
    if (!asJson) throw new Error(failed.join("\n"));
    process.exitCode = 1;
  }
  if (asJson) {
    return json(got.map((g) => (g.t ? {...g.t, ...(g.from ? {from: g.from} : {}), text: g.t.words.map((w) => w.word).join(" ")}
      : {id: g.id, url: `https://youtu.be/${g.id}`, ...(g.from ? {from: g.from} : {}), error: g.error})));
  }
  for (const f of failed) process.stderr.write(`goog: ${f}\n`);
  got.flatMap((g) => (g.t ? [{t: g.t, from: g.from}] : [])).forEach(({t, from: linked}, i) => {
    if (i) out("");
    const title = [t.title ? `"${t.title}"` : "", linked].filter(Boolean).join(", ");
    const kind = t.auto ? "automatic captions, so expect misheard words" : "the uploader's captions";
    const others = t.languages && t.languages.length > 1 ? `; also ${t.languages.filter((l) => l !== t.lang).join(", ")} (--lang)` : "";
    const part = from || to < Infinity ? `, ${clock(from)}–${to < Infinity ? clock(to) : "end"} of it` : "";
    out(`# ${t.url}${title ? `  ${title}` : ""}  (${clock(t.duration)}${part}, ${t.words.length} words, ${t.lang}, ${kind}${others})`);
    out(timed(t.words));
  });
}

// `goog <cmd> --help`: the lines of the help about that command, or all of it.
function helpFor(cmd: string): string {
  const lines = HELP.split("\n");
  const picked: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(`  goog ${cmd}`) || /\w/.test(lines[i][`  goog ${cmd}`.length] ?? "")) continue;
    picked.push(lines[i]);
    while (i + 1 < lines.length && /^ {3,}/.test(lines[i + 1])) picked.push(lines[++i]);
  }
  return picked.length ? picked.join("\n") : HELP;
}

export async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  // Its flags are gh api's, so it parses its own (-f isn't --force there).
  if (cmd === "api") return cmdApi(rest, helpFor("api"));
  const {values: flags, positionals: pos} = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      out: {type: "string", short: "o"},
      "dry-run": {type: "boolean"},
      json: {type: "boolean"},
      poll: {type: "string"},
      timeout: {type: "string"},
      force: {type: "boolean", short: "f"},
      bg: {type: "boolean"},
      background: {type: "boolean"},
      pull: {type: "boolean"},
      push: {type: "boolean"},
      quiet: {type: "boolean"},
      lines: {type: "string", short: "n"},
      help: {type: "boolean", short: "h"},
      slides: {type: "boolean"},
      all: {type: "boolean"},
      progress: {type: "boolean"},
      due: {type: "string"},
      full: {type: "boolean"},
      done: {type: "boolean"},
      lang: {type: "string"},
      from: {type: "string"},
      to: {type: "string"},
      type: {type: "boolean"},
      wpm: {type: "string"},
      manual: {type: "boolean"},
    },
  });
  const asJson = !!flags.json;
  if (flags.help && cmd) return out(helpFor(cmd));
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      if (pos[0] === "format") return out(FORMAT_HELP);
      if (pos[0] === "slides") return out(SLIDES_HELP);
      out(HELP);
      if (skillMissing()) out(`\n${SKILL_HINT}`);
      return;
    case "skill":
      return cmdSkill(pos[0], !!flags.force, asJson);
    case "auth":
      return cmdAuth(pos, !!flags.manual);
    case "edit": {
      const ref = await docRef(need(pos[0], "goog edit <doc> [-o FILE] [--bg]"));
      if (flags.pull && flags.push) throw new Error("pick one of --pull and --push");
      const file = resolve(flags.out ?? ref.file ?? `${ref.id}.goog`);
      // setInterval can't wait longer than about 24 days.
      const pollSeconds = Math.min(86_400, Math.max(2, seconds(flags.poll, Number(loadConfig().pollSeconds) || 10, "--poll")));
      const onExisting = flags.pull ? "pull" : flags.push ? "push" : undefined;
      if (flags.bg || flags.background) {
        const extra = ["--poll", String(pollSeconds), ...(onExisting ? [`--${onExisting}`] : [])];
        return cmdEditBackground(ref.id, file, extra, asJson);
      }
      return edit(ref.id, flags.out ?? ref.file ?? `${ref.id}.goog`, {pollSeconds, json: asJson, quiet: !!flags.quiet, onExisting, kind: ref.kind});
    }
    case "stop":
      return cmdStop(pos[0], asJson);
    case "log":
      return cmdLog(pos[0], count(flags.lines, 20, "-n"), asJson);
    case "pull": {
      const ref = await docRef(need(pos[0], "goog pull <doc> [-o FILE] [--force]"));
      const file = flags.out ?? ref.file ?? `${ref.id}.goog`;
      const r = await pull(ref.id, file, {force: flags.force, kind: ref.kind});
      if (asJson) return json({ok: true, ...r, file: resolve(file)});
      // drawing is set for decks only: false when the draw couldn't start.
      const deck = r.drawing !== undefined;
      out(`${r.replaced ? "replaced" : "pulled into"} ${file}${deck ? " (a Slides deck: goog help slides has the format)" : ""}`);
      if (r.drawing) out(DRAWING_NOTE(file));
      else if (deck) out(`couldn't start drawing the slides as pictures; is ${show(imagesDir(file))} writable?`);
      else outImages(r.images);
      return outContents(file);
    }
    case "push": {
      const file = need(pos[0], "goog push <file> [--dry-run] [--type [--wpm N]]");
      const timeout = seconds(flags.timeout, 120);
      const w = watcherOf(file);
      const typing = flags.type ? typingOf(flags.wpm, asJson) : undefined;
      if (w && typing && !flags["dry-run"]) throw new Error(`goog edit (pid ${w.pid}) is syncing ${file} and would push it without typing; stop it first with goog stop ${file}`);
      if (w && !flags["dry-run"]) {
        // Two pushers would race; let the running goog edit do it.
        if (!asJson) out(`goog edit (pid ${w.pid}) is syncing ${file}; waiting for it to push`);
        return cmdWait(file, timeout, asJson);
      }
      const r = await push(file, {dryRun: flags["dry-run"], typing});
      if (r.status === "conflict") process.exitCode = EXIT.conflict;
      if (asJson) return json({ok: r.status !== "conflict", ...r});
      for (const w of r.warnings) out(`warning: ${w}`);
      const again = `${file} was saved again during the push; that save isn't in the doc yet, so run goog push again`;
      // Last, whatever happened: the deck may look different now.
      const drawing = () => {
        if (r.drawing) out(`the changed slides are being drawn again; goog pics ${show(file)} waits for them`);
        else if (r.drawing === false) out(`couldn't start drawing the slides as pictures; is ${show(imagesDir(file))} writable?`);
      };
      if (r.savedDuring && r.status === "unchanged") {
        out(again);
        return drawing();
      }
      const dry = r.dryRun;
      if (r.status === "conflict") {
        out(dry
          ? `would conflict: the doc changed in the same places as the file (${r.conflicts} conflict(s)). A real push writes <<<<<<< markers into ${file}.`
          : `the doc changed in the same places as the file: ${r.conflicts} conflict(s) are marked with <<<<<<< in ${file}. Keep what you want, delete the marker lines, and push again.`);
        return drawing();
      }
      if (r.status === "pulled") {
        if (dry) return out(`nothing to push; the doc has edits ${file} doesn't. A real push (or goog pull) brings them in:\n${r.patch ?? ""}`);
        out(`nothing to push; pulled edits made in the doc into ${file}`);
        return drawing();
      }
      if (r.status === "unchanged") {
        out(r.rewrote ? `nothing to push; ${file} updated to match the doc` : "nothing to push; the doc already matches");
        return drawing();
      }
      const notes = [r.merged ? "merged with edits made in the doc" : "", r.noBase ? `first push of ${file}, so the doc now matches it exactly` : "", r.rewrote ? `${file} updated to match` : ""].filter(Boolean);
      if (dry) {
        out(`would send ${r.requests} edit(s)${r.merged ? ", merged with edits made in the doc" : ""}${r.noBase ? `; ${file} was never synced, so the doc would be made to match it exactly` : ""}`);
        return out(r.patch ?? "");
      }
      out(`pushed ${r.requests} edit(s)${notes.length ? `; ${notes.join("; ")}` : ""}`);
      if (r.savedDuring) out(again);
      drawing();
      return;
    }
    case "diff": {
      const file = need(pos[0], "goog diff <file>");
      const ft = readText(file);
      const be = backendOfText(ft.text);
      const doc = be.parse(ft.text);
      const theirs = (await be.fetch(doc.id)).text;
      const base = readBase(file, doc.id);
      const act = reconcile(ft.text, base && base.id === doc.id ? base.text : null, theirs);
      const head = ft.text.slice(0, ft.text.indexOf("\n") + 1);
      let p = "";
      let note = "";
      if (act.action === "push") {
        p = patch(file, theirs, act.text, "doc", "after push");
        note = act.merged ? "edits made in the doc since the last sync are kept (merged)" : act.noBase ? "never synced: a push makes the doc match the file exactly" : "";
      } else if (act.action === "pull") {
        p = patch(file, head + canonBody(ft.text), act.text, "file", "doc");
        note = "nothing to push; the doc has edits the file doesn't (goog pull or goog edit brings them in)";
      } else if (act.action === "conflict") {
        p = patch(file, theirs, head + canonBody(ft.text), "doc", "file");
        note = `${act.conflicts} conflict(s): the doc and the file changed the same lines; a push writes <<<<<<< markers`;
      }
      if (asJson) return json({ok: true, file, id: doc.id, action: act.action, conflicts: act.action === "conflict" ? act.conflicts : 0, merged: act.action === "push" && act.merged, note, patch: p});
      if (act.action === "none") return out("no differences");
      if (note) out(`# ${note}`);
      return out(p);
    }
    case "check": {
      const file = need(pos[0], "goog check <file>");
      try {
        const text = readText(file).text;
        backendOfText(text).parse(text);
        return asJson ? json({ok: true, file}) : out("ok");
      } catch (e) {
        if (e instanceof FormatError) {
          process.exitCode = EXIT.error;
          return asJson ? json({ok: false, file, line: e.line, error: e.message}) : out(`${file}: ${e.message}`);
        }
        throw e;
      }
    }
    case "status": {
      const files = pos[0] ? targets(pos[0], false) : listStates().map((s) => s.file);
      if (pos[0] && !files.length) files.push(resolve(resolveRef(pos[0]).file ?? `${resolveRef(pos[0]).id}.goog`));
      const all = files.map(fileStatus).filter((s) => {
        if (pos[0] || s.watching || s.status !== "missing") return true;
        // Forget files that are gone and unwatched.
        forgetState(s.file);
        forgetBase(s.file);
        for (const f of [logPath(s.file), logPath(s.file).replace(/\.log$/, ".err")]) rmSync(f, {force: true});
        return false;
      });
      if (asJson) return json(pos[0] && all.length === 1 ? all[0] : all);
      if (!all.length) return out("no files known; goog edit <doc> starts syncing one");
      for (const s of all) printStatus(s);
      return;
    }
    case "pics":
      return cmdPics(pos[0], seconds(flags.timeout, 300), asJson);
    case "draw":
      // Run by drawInBackground, not by people.
      return drawNow(need(pos[0], "goog draw <deck> <dir>"), need(pos[1], "goog draw <deck> <dir>"));
    case "wait":
      return cmdWait(pos[0], seconds(flags.timeout, 120), asJson);
    case "cat": {
      const ref = await docRef(need(pos[0], "goog cat <doc>"));
      const kind = await kindOf(ref.id, ref.kind);
      process.stdout.write((await backends[kind].fetch(ref.id)).text);
      // cat leaves pictures out; on slides they're often the content.
      if (kind === "slides") process.stderr.write("goog: images aren't in this text; goog pull saves each slide as a picture (<file>.files/slide-N.png)\n");
      return;
    }
    case "ls": {
      const q = ["trashed = false", "(mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.google-apps.presentation')"];
      if (pos[0]) q.push(`name contains '${pos.join(" ").replace(/['\\]/g, "\\$&")}'`);
      const j = await api("GET", `${DRIVE}/files?` + new URLSearchParams({
        q: q.join(" and "), orderBy: "modifiedTime desc", pageSize: "25", fields: "files(id,name,mimeType,modifiedTime)",
      }));
      if (asJson) return json(j.files.map((f: any) => ({id: f.id, name: f.name, kind: f.mimeType.endsWith("presentation") ? "slides" : "doc", modified: f.modifiedTime})));
      for (const f of j.files) out(`${f.id}  ${f.mimeType.endsWith("presentation") ? "slides" : "doc   "}  ${f.modifiedTime.slice(0, 10)}  ${f.name}`);
      return;
    }
    case "classroom":
    case "class":
      return cmdClassroom(pos, {all: !!flags.all, done: !!flags.done, progress: !!flags.progress, full: !!flags.full, due: flags.due}, asJson);
    case "transcript":
      return cmdTranscript(need(pos[0], "goog transcript <youtube link|assignment> [--lang CODE] [--from 0:00] [--to 15:35]"), {lang: flags.lang, from: flags.from, to: flags.to}, asJson);
    case "new": {
      const title = need(pos.join(" "), "goog new <title> [--slides]");
      const id = flags.slides ? await createDeck(title) : await createDoc(title);
      return asJson ? json({ok: true, id, url: backends[flags.slides ? "slides" : "doc"].url(id)}) : out(id);
    }
    case "open": {
      const ref = await docRef(need(pos[0], "goog open <doc>"));
      return out(backends[await kindOf(ref.id, ref.kind)].url(ref.id));
    }
    default:
      throw new Error(`unknown command "${cmd}"; run goog help`);
  }
}

// --timeout 90, 90s or 2m.
function seconds(v: string | undefined, def: number, flag = "--timeout"): number {
  if (v === undefined) return def;
  const m = /^(\d+(?:\.\d+)?)(s|m)?$/.exec(v.trim());
  if (!m) throw new Error(`${flag} takes seconds, like 120 or 2m (got "${v}")`);
  return Number(m[1]) * (m[2] === "m" ? 60 : 1);
}

function count(v: string | undefined, def: number, flag: string): number {
  if (v === undefined) return def;
  if (!/^\d+$/.test(v.trim()) || !Number(v)) throw new Error(`${flag} takes a whole number from 1 (got "${v}")`);
  return Number(v);
}

// goog push --type: paced to --wpm, with a line on stderr as each paragraph
// is done, since typing a long answer takes minutes.
function typingOf(wpm: string | undefined, quiet: boolean): Typing {
  return {
    wpm: count(wpm, DEFAULT_WPM, "--wpm"),
    onChunk: (typed, total) => {
      if (!quiet && typed === total) process.stderr.write(`typed a paragraph (${total} characters)\n`);
    },
  };
}

function need(v: string | undefined, usage: string): string {
  if (!v) throw new Error(`usage: ${usage}`);
  return v;
}

