import {spawn} from "node:child_process";
import {closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync} from "node:fs";
import {basename, dirname, join, relative, resolve} from "node:path";
import {parseArgs} from "node:util";
import {authStatus, BROKER_MANIFEST, BROKER_SOURCE, forgetToken, getToken, importAuthorizedUser, keepSignIn, loginWithClient} from "./auth.ts";
import {withBrowser} from "./browser.ts";
import {loadConfig, saveConfig} from "./config.ts";
import {installSkill, removeSkill, skillMissing, skillStatus} from "./skill.ts";
import {backendOfText, backends, kindOf} from "./backend.ts";
import {FormatError} from "./format.ts";
import {createDoc} from "./gdocs.ts";
import {createDeck} from "./slides.ts";
import {DEFAULT_WPM, type Typing} from "./typing.ts";
import {DRIVE, api} from "./google.ts";
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
  goog check <file>             parse the file and report format errors

Drive
  goog ls [query]               recent docs and slides
  goog new <title> [--slides]   create a doc (or a deck) and print its id
  goog open <doc>               print the doc's URL
  goog auth [status|import <token.json>|script [URL]|client <client_secret.json>]
  goog skill [install|remove]   the skill that teaches coding agents (Claude Code,
                                Codex) to edit docs with goog; status if none given
      --force                   install over a skill of the same name that isn't goog's

<doc> is a doc or deck id, a docs.google.com or drive.google.com URL, or a .goog file.
--json gives machine-readable output on status, wait, push, pull, diff, check,
ls, new, stop, skill, edit (one event per line), log, and errors ({"ok":false,"error":…}).
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
so change only what you mean to. Pull also saves each slide as a picture
(<file>.files/slide-N.png); look at it before moving things.

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

async function cmdAuth(args: string[]) {
  const [sub, arg] = args;
  if (!sub || sub === "status") {
    out(`goog auth: ${authStatus()}`);
    if (authStatus() === "not set up") {
      out(`\nSet it up one of three ways:
  goog auth script     uses an Apps Script in your own Drive; works with school
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
    if (!arg) {
      out(`1. Open https://script.new in the signed-in Chrome.
2. Paste this as Code.gs:

${BROKER_SOURCE}

3. Project Settings → "Show appsscript.json in editor", then set appsscript.json to:

${JSON.stringify(BROKER_MANIFEST, null, 2)}

4. Deploy → New deployment → Web app, execute as Me, access Only myself.
   Authorize it when asked.
5. Run: goog auth script <the web app URL>`);
      return;
    }
    const cfg = loadConfig();
    const before = structuredClone(cfg);
    cfg.broker = arg;
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
      if (asJson) json({ok: true, file, id, pid: child.pid, status, message: s?.message, images: savedImages(file)});
      else {
        out(`watching ${show(file)} (pid ${child.pid}): ${status}${s?.message ? `: ${s.message}` : ""}`);
        out(`after saving: goog wait ${show(file)}   activity: goog log ${show(file)}   stop: goog stop ${show(file)}`);
        outImages(savedImages(file));
        outContents(file);
      }
      return;
    }
  }
}

function savedImages(file: string): string[] {
  const dir = imagesDir(file);
  return existsSync(dir) ? readdirSync(dir).map((f) => join(dir, f)) : [];
}

function outImages(images: string[]) {
  const isSlide = (f: string) => /(^|\/)slide-\d+\.png$/.test(f);
  const n = (f: string) => Number(/slide-(\d+)/.exec(f)![1]);
  const slides = images.filter(isSlide).sort((a, b) => n(a) - n(b));
  const pics = images.filter((f) => !isSlide(f));
  if (slides.length) out(`slides as pictures (look before moving things): ${slides.map(show).join("  ")}`);
  if (pics.length) out(`images (named by their id): ${pics.map(show).join("  ")}`);
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

export async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
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
      type: {type: "boolean"},
      wpm: {type: "string"},
    },
  });
  const asJson = !!flags.json;
  if (flags.help && cmd) return out(HELP);
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
      return cmdAuth(pos);
    case "edit": {
      const ref = resolveRef(need(pos[0], "goog edit <doc> [-o FILE] [--bg]"));
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
      const ref = resolveRef(need(pos[0], "goog pull <doc> [-o FILE] [--force]"));
      const file = flags.out ?? ref.file ?? `${ref.id}.goog`;
      const r = await pull(ref.id, file, {force: flags.force, kind: ref.kind});
      if (asJson) return json({ok: true, ...r, file: resolve(file)});
      out(`${r.replaced ? "replaced" : "pulled into"} ${file}${r.slides ? " (a Slides deck: goog help slides has the format)" : ""}`);
      outImages([...(r.slides ?? []), ...r.images]);
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
      if (r.savedDuring && r.status === "unchanged") return out(again);
      const dry = r.dryRun;
      if (r.status === "conflict") {
        return out(dry
          ? `would conflict: the doc changed in the same places as the file (${r.conflicts} conflict(s)). A real push writes <<<<<<< markers into ${file}.`
          : `the doc changed in the same places as the file: ${r.conflicts} conflict(s) are marked with <<<<<<< in ${file}. Keep what you want, delete the marker lines, and push again.`);
      }
      if (r.status === "pulled") {
        if (dry) out(`nothing to push; the doc has edits ${file} doesn't. A real push (or goog pull) brings them in:`);
        else return out(`nothing to push; pulled edits made in the doc into ${file}`);
        return out(r.patch ?? "");
      }
      if (r.status === "unchanged") return out(r.rewrote ? `nothing to push; ${file} updated to match the doc` : "nothing to push; the doc already matches");
      const notes = [r.merged ? "merged with edits made in the doc" : "", r.noBase ? `first push of ${file}, so the doc now matches it exactly` : "", r.rewrote ? `${file} updated to match` : ""].filter(Boolean);
      if (dry) {
        out(`would send ${r.requests} edit(s)${r.merged ? ", merged with edits made in the doc" : ""}${r.noBase ? `; ${file} was never synced, so the doc would be made to match it exactly` : ""}`);
        return out(r.patch ?? "");
      }
      out(`pushed ${r.requests} edit(s)${notes.length ? `; ${notes.join("; ")}` : ""}`);
      if (r.savedDuring) out(again);
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
    case "wait":
      return cmdWait(pos[0], seconds(flags.timeout, 120), asJson);
    case "cat": {
      const ref = resolveRef(need(pos[0], "goog cat <doc>"));
      return process.stdout.write((await backends[await kindOf(ref.id, ref.kind)].fetch(ref.id)).text);
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
    case "new": {
      const title = need(pos.join(" "), "goog new <title> [--slides]");
      const id = flags.slides ? await createDeck(title) : await createDoc(title);
      return asJson ? json({ok: true, id, url: backends[flags.slides ? "slides" : "doc"].url(id)}) : out(id);
    }
    case "open": {
      const ref = resolveRef(need(pos[0], "goog open <doc>"));
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

