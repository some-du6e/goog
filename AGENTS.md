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

Slides takes the same path through backend.ts, which sync and watch call for
both kinds: slides-format.ts → slides-read.ts → slides-plan.ts → pushDeck in
slides.ts. Shape and cell text reuses the doc format's paragraph parser.

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
  the planner tests catch it offline.
- `node test/plan-live.ts [regex]` runs test/plan-scenarios.ts against real
  docs. Live runs use up the shared per-minute write quota, so reuse one doc
  for ad-hoc probes.
- Delete throwaway docs for good with `DELETE drive/v3/files/<id>`, the way
  plan-live.ts does. Trashing them fills the user's Drive trash; one run left
  619 docs there.

## Docs API ground truth

- The discovery doc
  (`https://docs.googleapis.com/$discovery/rest?version=v1`) is the source of
  truth for what's possible. insertPerson, insertDate, insertRichLink, the
  dropdown requests, and createFootnote are all listed there.
- Out of reach through the API: creating an hr or an equation, ticking a
  checklist item, and setting a list's start number. Checked state is read
  from Drive's text/markdown export (`markChecked` in gdocs.ts).
- Chip inserts reply `{}`. `adoptNew` picks up their ids after the refetch.

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
- `updateSlidesPosition`'s insertionIndex counts positions before the move.
- Image and thumbnail contentUrls are pre-signed: fetched without the token
  they come back several times faster.
- The imported token has no presentations scope; its drive scope covers the
  Slides API.
- Test against a Drive copy of a deck (`POST drive/v3/files/<id>/copy`) and
  delete it for good afterwards, as with docs.

## The user's docs and auth

- The scratch doc `18C0ykVGzbSM5BZMq9m9PrMwpxp7qMBn-H2Z6NyB7Tbg` belongs to
  the user: read it, or copy it and push to the copy.
  test/fixtures/scratch.json is its raw API response.
- Auth is the imported token (`goog auth status`; `$GOOG_TOKEN` overrides
  it). Tokens stay out of tool output and the repo.
