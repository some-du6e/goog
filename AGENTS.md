# Developing goog

goog edits Google Docs and Slides as `.goog` text files through their APIs. `goog` on
PATH is a link to this checkout, so it always runs the code here. README.md is
the user's view. `goog help`, `goog help format`, `goog help slides` (HELP, FORMAT_HELP and
SLIDES_HELP in src/cli.ts), and the
agent skill in skill/SKILL.md (installed by `goog skill install`) are what
agents using goog read, so a change to a command or the format updates them and
the README's format section in the same edit.

## How a push flows

parse (format.ts) → fetch and fromApi (gdocs-read.ts) → plan (gdocs-plan.ts) →
batchUpdate, refetch and replan until a pass plans nothing (gdocs.ts) → base
and three-way line merge (sync.ts) → the `goog edit` watcher (watch.ts).
model.ts is the shape they share.

`goog push --type` plans with `typing`: each pass keeps only the topmost
paragraph edit that adds text (`slice` in gdocs-plan.ts), and `typeBatch` in
gdocs.ts sends its insertText as paced chunks (typing.ts), one write each.

Slides takes the same path through backend.ts, which sync and watch call for
both kinds: slides-format.ts → slides-read.ts → slides-plan.ts → pushDeck in
slides.ts. Shape and cell text reuses the doc format's paragraph parser.
Slide pictures are drawn after the sync by a detached `goog draw`
(`drawInBackground` in slides.ts, one at a time per deck, tracked by
`.drawing`), and `goog pics` waits for it.

## Invariants

- **Fixed point:** `serialize(parse(serialize(d))) === serialize(d)`. sync.ts
  uses it as the canonical form, and merges are line-based, so every
  structural tag (`<tab>`, segment open/close, table rows) sits on its own line.
- **Fillers:** Docs forces an empty paragraph before a leading table, between
  tables, after a trailing table, and in an empty segment. serialize leaves
  these out and parse puts them back (`isFiller`/`addFillers` in format.ts).
- **Atom identity:** both sides key atoms with `atomKey()` in model.ts.
- **Convergence:** pushing the same file a second time plans zero requests.

## Testing

Done means `npm test` and `npm run typecheck` both pass.

- test/sim.ts simulates the Docs API. Its header lists the Docs rules observed
  live. When you see a new one live, add it to the sim and to that list, so
  the planner tests catch it offline. test/slides-sim.ts does the same for
  Slides' structural requests (groups, copies, deletes, z-order).
- `node test/plan-live.ts [regex]` runs test/plan-scenarios.ts against real
  docs. Live runs use up the shared per-minute write quota, so reuse one doc
  for ad-hoc probes.
- Delete throwaway docs for good with `DELETE drive/v3/files/<id>`
  (`goog api drive/v3/files/<id> -X DELETE`), the way plan-live.ts does.
  Trashing them fills the user's Drive trash; one run left 619 docs there.

## Docs API ground truth

- The discovery doc
  (`https://docs.googleapis.com/$discovery/rest?version=v1`) is the source of
  truth for what's possible. insertPerson, insertDate, insertRichLink, the
  dropdown requests, and createFootnote are all listed there.
- Out of reach through the API: creating an hr or an equation, ticking a
  checklist item, and setting a list's start number. Checked state is read
  from Drive's text/markdown export (`markChecked` in gdocs.ts).
- Chip inserts reply `{}`. `adoptNew` picks up their ids after the refetch.
- `deleteTab` deletes the tab's child tabs too, so the planner never deletes a
  tab whose children the file keeps.
- Standard parameters (`fields`, `alt`, …) in a JSON body are ignored, by
  every Google API: a Drive copy with `{"fields":"id"}` in its body answers
  with every default field. They go in the query (`SYSTEM` in api-cmd.ts).

## Slides API ground truth

Observed live; the code depends on each:

- Slides rewrites an object's size (usually to 3000000 EMU square) and keeps
  the real size in the transform's scale. Missing transform fields are 0, so a
  vertical line has no scaleX.
- Scales are stored to 4 decimals, about 0.02pt on an object. The planner
  treats geometry within 0.05pt as equal (`near` in slides-plan.ts); exact
  comparison never converges.
- Rotations read back in (-180, 180]: a file's rot="240" comes back as -120,
  so the planner compares angles mod 360 (`nearAngle`).
- New shapes get a thin dark outline and a theme fill; the planner removes
  both on the next pass unless the file asks for them.
- A text's API length excludes its final newline, which can't be deleted.
- Groups (test/slides-sim.ts models these): `ungroupObjects` keeps the
  children's ids and positions, and only takes top-level groups;
  `groupObjects` needs at least two top-level children, and can't take
  tables, videos or placeholders (picture placeholders included). No request
  adds to or takes from an existing group, so the planner ungroups a changed
  top-level group and groups it again under the same id next pass; a change
  deeper down takes apart and remakes each group around it, a level a pass. Deleting a
  group's members down to one dissolves the group. A copy of an object in a
  group lands at the top level, in front, as do created objects. A new
  group takes the place of its frontmost member. Members keep their stacking order
  whatever order groupObjects lists them in, and updatePageElementsZOrder
  refuses grouped objects, so the planner restacks members before grouping.
- A new object's id must be unused across every page, layout, master and
  notes page, and 5-50 characters of `[a-zA-Z0-9_\-:]`, the first not `-`
  or `:` (`fresh` in slides-plan.ts).
- `updateSlidesPosition`'s insertionIndex counts positions before the move.
- `updatePageElementAltText` on a group fails the whole batch ("operation is
  not allowed on group"), so the planner warns instead of sending it.
- The thumbnail API allows about 60 calls a minute per user. Drive's PDF
  export draws a whole deck in one call (about 12s for 88 slides), so from
  `PDF_FROM` (10) stale slides `drawFromPdf` draws them with mutool instead.
  The page-count check falls back to thumbnails if the export ever leaves out
  skipped slides.
- Image and thumbnail contentUrls are pre-signed: fetched without the token
  they come back several times faster.
- The imported token has no presentations scope; its drive scope covers the
  Slides API.
- Test against a Drive copy of a deck (`POST drive/v3/files/<id>/copy`, or
  `goog api drive/v3/files/<id>/copy -X POST -f fields=id`) and
  delete it for good afterwards, as with docs.

## Apps Script broker ground truth

Observed live while building `goog auth script`:

- A web app deployed "execute as me, access Anyone" answers without cookies;
  "Only myself" redirects a cookieless request to accounts.google.com.
  `askBroker` treats any non-Google host the same way and names it in the
  error, since it may be a school's SSO (not yet seen live) or a network
  filter's block page.
- A POST to `/exec` answers 302 to `script.googleusercontent.com`, which
  fetch follows as a GET and which carries doPost's output. A doGet-only
  deployment answers POST with a 200 HTML error page on script.google.com
  that names doPost. A deployment that doesn't exist answers 404 there.
- Google indexes `script.googleusercontent.com` pages (a `site:` search
  finds them), and anything that GETs the URL (a browser, a link preview, a
  crawler) would get what doGet returns, so the template only hands out the
  token to POST (`BROKER_SOURCE`).
- The script's hidden Cloud project only enables an API that the manifest
  lists as an advanced service. Apps Script has no Forms service, so Forms
  answers 403 "has not been used in project". Its Apps Script API can't be
  enabled either, so a script can't deploy itself.
- Apps Script projects have no `/copy` link; Sheets do, and copying a Sheet
  copies its bound script. Deployments aren't copied.
- Signed in to several Google accounts, the editor often fails to open
  ("unable to open the file") for any but the first; a private window works.
- clasp's OAuth client is refused ("This app is blocked") for drive and
  gmail scopes, so it can't stand in for a broker.

## The user's docs and auth

- The scratch doc `18C0ykVGzbSM5BZMq9m9PrMwpxp7qMBn-H2Z6NyB7Tbg` belongs to
  the user: read it, or copy it and push to the copy.
  test/fixtures/scratch.json is its API response, with the id replaced by "scratch-doc".
- Auth is the imported token (`goog auth status`; `$GOOG_TOKEN` overrides
  it). Tokens stay out of tool output and the repo.
