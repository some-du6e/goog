# goog

Edit Google Docs and Slides as local text files. `goog edit <doc>` pulls a doc
or deck into `<id>.goog` and keeps it synced: save the file and only what
changed goes up; edits made in the browser come back down. Agents can edit the
file with plain find-and-replace.

```sh
goog edit https://docs.google.com/document/d/DOC_ID/edit   # pull + live sync (Ctrl+C stops)
goog edit DOC_ID --bg      # same, in the background; returns once the first sync is done
goog wait DOC_ID.goog      # after a save: wait for the push; exit 1 on error, 2 on conflict
goog status                # every file goog knows about and whether it's synced
goog stop                  # stop background syncs (each pushes its last save first)
goog push DOC_ID.goog      # one-shot push, no watcher (--dry-run shows the diff)
goog diff DOC_ID.goog      # what a push would change in the doc
goog classroom             # Classroom work left to do, with your copy of each doc
goog transcript VIDEO      # what a YouTube video says, with times
goog help                  # everything else
```

### For agents and scripts

- Start with `goog edit <doc> --bg`. It prints the file once it's synced and
  leaves a watcher running.
- Edit the file any way you like: in place, by rename (vim, VS Code, `sed -i`,
  Write tools), or by rewriting it whole.
- After each save, run `goog wait <file>`. It only reports `synced` once the
  watcher has pushed that exact content. A status about an earlier save never
  counts.
- Exit codes: 0 ok, 1 error, 2 conflict, 3 timed out. `--json` works on
  `status`, `wait`, `push`, `pull`, `diff`, `check`, `pics`, `ls`, `new`, `stop`,
  `skill`, `classroom`, `transcript`, `log` and `edit`. With `--json`, errors are printed as
  `{"ok":false,"error":…}`. A deck's `pull` and `push` say `"drawing":true` while the
  slide pictures are drawn (`false` if the draw couldn't start), as does `edit --bg`
  while a draw runs.
- `goog log <file>` shows what the watcher did: pushes, pulls, conflicts,
  retries.

- `goog skill install` gives Claude Code and Codex a skill with the
  pull/edit/push steps and the format, so they skip reading `goog help`
  (about 15s faster per doc in testing). Plain `goog` asks agents to offer it.

### Sync rules

- goog keeps a sync record (the base) for each file path, not for each doc.
  Several files can follow one doc. A copied, renamed, or `goog cat`-ed file
  has no record, so `goog push` makes the doc match it exactly. `goog edit`
  won't guess for a file like that: pass `--pull` (take the doc's version) or
  `--push` (take the file's).
- If the doc and the file both changed, they're merged line by line. When both
  changed the same lines, the file gets `<<<<<<< your file` / `=======` /
  `>>>>>>> google doc` blocks and nothing is pushed. Edit them into the
  version you want, delete the marker lines, and save. That version is pushed
  over the doc as it was when the conflict happened.
- The first line names the doc. If it's edited to name another doc, or
  deleted, goog refuses to push.
- `goog pull` won't overwrite unpushed changes, or a file it never synced that
  differs from the doc, unless you pass `--force`.
- A deleted file is never pushed as an empty doc. The watcher waits for the
  file to come back.
- Blank lines, CRLF line endings, a BOM, and a missing final newline don't
  count as changes. CRLF is kept when goog rewrites the file.
- Network failures, rate limits (429), and 5xx errors are retried with backoff.
  While offline the watcher keeps your saves and pushes them once Google is
  reachable again.
- Accepted `<doc>` forms: an id, a `.goog` file, or any docs.google.com or
  drive.google.com URL (`/edit?tab=…`, `/u/1/`, `?usp=sharing`, `open?id=`,
  `/file/d/…`).

## The .goog format

One paragraph per line, HTML-ish tags for formatting. Highlights are `<mark>`.

```html
<!-- goog doc 1sqFUMQ… · "Bio HW 3" -->

<title align="center">Cellular Respiration</title>

Answer every question in <b>complete sentences</b>. Due <u>Friday</u>.
<li>Glycolysis: <mark>happens in the cytoplasm</mark></li>
<li level="2" type="1">numbered, nested</li>

<table>
<tr><td><b>Stage</b></td><td>ATP</td></tr>
<tr><td>Krebs</td><td><mark color="#00ff00">2</mark></td></tr>
</table>

<img id="kix.8f2k1" alt="mitochondrion"> See <a href="https://…">notes</a>.
```

`goog help format` has the full list, including list types, table cell
spans, headers, footers, footnote text, and doc tabs (`<tab …>` lines).

New images (`<img src="https://…">`), footnotes (`<footnote text="…">`), and
smart chips (`<chip type="person" email="…">`, `type="date" date="2026-12-25"`,
`type="link" href="…"`, `type="dropdown" value="…"`) can be added by writing
them without an id. Horizontal rules, equations, drawings, charts, and the
table of contents can only be kept or deleted: the Docs API has no way to make
them. Ticked checklist items read as `<li type="check" checked>`, but ticking
one from the file isn't possible either. Tabs, headers and footers can be
edited, renamed or deleted, but new ones can't be added from the file.

## Slides

A deck is one `<slide>` block per slide, holding its objects back to front,
with positions and sizes in points (a slide is usually 720×405):

```html
<!-- goog slides 1V_Oj… · "HDI Practice" -->
<!-- layouts for new slides: title (Title slide), title-and-body, blank -->

<slide id="h280c39f37343028d_1_116" layout="title-and-body">
<shape id="g1f7…_22" type="text-box" x="59.2" y="144" w="142.46" h="28.87" font="Playfair Display" size="18" color="dark2">
<p align="center">64th <b>(higher)</b></p>
</shape>
<image id="g1f7…_20" x="59.52" y="58.49" w="142.46" h="85.49">
<line id="h280…_125" x1="217" y1="155" x2="391" y2="58" arrow="end">
<table id="h280…_122" x="19.48" y="113.46" font="Century Gothic" size="11">
<tr><td bg="#ead1dc">GDP Per Capita</td></tr>
</table>
<notes>
Speaker notes, one paragraph per line.
</notes>
</slide>
```

Text inside a shape, table cell or `<notes>` is written as in a doc. The
font, size and color most of an object's text shares go on its tag, so the
text itself stays readable. Pulling and pushing also draw each slide as a
picture (`<id>.files/slide-N.png`) next to the deck's images. That happens in
the background, since it's most of a pull's time, and only for slides that
changed; `goog pics <file>` waits for it. With `mutool` installed (apt's
`mupdf-tools`), many slides are drawn from one PDF export instead of slide by
slide, which Google limits to about 60 a minute: an 88-slide deck takes about
25s instead of a minute and a half.

From the file you can edit text, move, resize and rotate objects, recolor
fills and outlines (`#rrggbb` or theme colors like `accent1`), move a line's ends, add or
remove table rows and columns (at the right edge), set alt text, write speaker
notes, group objects (wrap them in `<group>`), change or restack what's in any
group, and delete, reorder or skip (`<slide skip>`) slides. A group
needs two or more objects and can't hold tables, videos or layout
placeholders.
New shapes, tables, lines, images (`src="https://…"`), YouTube or Drive videos, and
slides (`<slide layout="…">`, with `<shape placeholder="title">` filling the
layout's boxes) are tags without an id. Pasting a slide block or an object's
line a second time duplicates it (except an `<object>`, such as a chart). The
API can't change a slide's layout or a shape's type. `goog help slides` has the details.

## Classroom

`goog classroom` lists what's left to do across your active classes, most
urgent first (due next, then missing, then undated): work you haven't turned in that was due in the last two weeks or
later, or has no due date and was set this month. It says how much older
unfinished work it left out. Each one shows your own copy
of its files (the "make a copy for each student" kind). `--all` lists
everything not turned in however old, `--done` adds finished work, a class name, id or link narrows it (`goog classroom science`), `--due 7`
keeps work due in the next week (missing work included), and
`--progress` reads each copy to say whether it's still blank or how many words
you've added to the teacher's template.

`goog classroom <assignment link>` shows one assignment's instructions, the
teacher's files and yours, with how far along yours are (words, images and
ticked boxes added to the template) and any YouTube videos the teacher's files
link to. `goog edit`, `pull`, `cat` and `open` take an
assignment link too and open your Doc or Slides copy in it. It's read-only:
turning work in stays in Classroom.

`goog transcript <youtube link or assignment>` prints what a video says, a line
per 30 seconds with its time (`[15:35] …`), for worksheets that hang off a
video. Given an assignment it does every video the assignment attaches or its
files link to. It asks YouTube as its iOS app does (the
web player's caption links need a token a script can't make), which takes
about a second for an hour of video, and uses the uploader's captions when
there are some. `--lang es` picks another language the video has, and
`--from 0:00 --to 15:35` keeps just the part a worksheet covers.

## How it writes

goog talks to the Docs API. Each push fetches the doc, diffs it against the
file, and sends a `batchUpdate`, repeating until the doc matches: text and
styles first, then list structure. Edits are done per character inside a
paragraph, so images, comments, and suggestions anchored to text you didn't
touch stay put.

goog remembers the last version both sides agreed on. If the doc changed in
the browser, it does a three-way merge with your file, the way git does.
Overlapping changes get `<<<<<<<` markers in the file and aren't pushed until
you fix them.

## Auth

`goog auth` sets up a token. Three options:

- `goog auth import token.json`: reuse a refresh token another tool already
  has (a google-auth `authorized_user` file). Its scopes need `drive`, and
  `goog classroom` needs `classroom.courses.readonly` and
  `classroom.coursework.me.readonly` (or `classroom.coursework.me`).
- `goog auth script`: an Apps Script web app in your own Drive returns an
  OAuth token, and goog calls it through your signed-in Chrome (CDP on
  `127.0.0.1:9223`). No Google Cloud project needed, which matters for school
  accounts.
- `goog auth client client_secret.json`: a normal Desktop OAuth client.

Config is in `~/.config/goog/`. Sync records, watcher state, and logs are in
`~/.cache/goog/`. `GOOG_CONFIG_DIR` and `GOOG_CACHE_DIR` override both.

## Development

```sh
npm test            # formats, planners (Docs against a simulated API), sync, CLI
npm run typecheck
```

Runs on Node 24's built-in TypeScript support, with no build step.

Planned: Sheets.
