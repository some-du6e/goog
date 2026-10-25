---
name: goog
description: Read and edit Google Docs and Slides from the shell with goog, as a text file, in seconds and without a browser. Use for any Google Docs or Slides link to read, fill in, answer, highlight, reformat, or rearrange, including schoolwork.
---

# goog

`goog` is on PATH and signed in. It turns a Google Doc or Slides deck into a
`.goog` text file and pushes your edits back.

1. **Pull.** In a fresh directory: `goog pull <doc url or id>`. It prints the
   file's path, then the paths of the doc's images (`<id>.files/<img id>.png`),
   then the whole file. Open every image the text refers to before writing
   about it.
2. **Edit** the file in one go (a Python replace script or `sed`), using the
   format below.
3. **Push:** `goog push <file>`. Done when it prints `pushed`: the doc now
   matches the file, and that's the check. Any `warning:` lines name edits
   Docs couldn't take, and the file now shows what the doc really has.

**Typing it in.** When the user wants text typed (autotype, "type it in",
version history that shows it written), push with
`goog push <file> --type` instead. New text goes in a few words a write at
about 45 words a minute, top to bottom, through the API: no browser. It's
slow (a 100-word answer is ~2.5 minutes), so always run it in the background
and wait for `pushed`. Leave a blank line between paragraphs — one per line
without them looks like a wall of text in the doc. If it's stopped partway,
the same command picks up where it left off. Small fixes (under 10
characters) still go in at once. `--wpm N` changes the speed. It won't run
while `goog edit` watches the file.

## Format

The file mirrors the doc: whatever you leave as pulled stays exactly as it is,
odd-looking spans and ids included, so change only the text you mean to
change. New text takes the style of the tags around it.

- One paragraph per line; `<p></p>` is an empty one. `<br>` is a line break
  inside a paragraph. The first line (`<!-- goog doc … -->`) stays.
- Inline: `<b> <i> <u> <s> <sup> <sub>`, `<a href="…">`,
  `<mark>` (yellow) or `<mark color="#00ff00">` highlight,
  `<span color="#c00" size="14" font="Arial">`.
- Headings `<h1>`…`<h6>`, `<title>`; bullets `<li>`, numbered
  `<li type="1">`, nested `level="2"`.
- Tables: one `<tr><td>…</td></tr>` per line; several paragraphs in a cell
  are `<td><p>one</p><p>two</p></td>`.
- Escape `&lt; &gt; &amp;` for literal `< > &`.

`goog help format` covers the rest: footnotes, chips, tabs, headers, and
which objects can be added.

## Decks

A Slides file (`<!-- goog slides … -->`) is one `<slide>` block per slide,
with one tag per object: `<shape>`, `<image>`, `<line x1 y1 x2 y2>`, `<table>`.
Positions and sizes are points on a 720×405 slide. Pull also saves each slide
as a picture (`<id>.files/slide-N.png`); look at those before moving
anything, since where things sit is half the slide. Text inside a shape,
table cell or `<notes>` uses the format above. `goog help slides` covers
adding, copying, grouping and reordering.
