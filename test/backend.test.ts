// The Docs backend's own steps around pushDoc, with Google played by the
// simulator behind a stubbed fetch.

import assert from "node:assert/strict";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {SimDoc} from "./sim.ts";

const tmp = mkdtempSync(join(tmpdir(), "goog-backend-test-"));
process.env.GOOG_CACHE_DIR = join(tmp, "cache");
process.env.GOOG_CONFIG_DIR = join(tmp, "config");
process.env.GOOG_TOKEN = "offline-test";
const {backends} = await import("../src/backend.ts");
const {parse} = await import("../src/format.ts");
const {toRemote} = await import("../src/gdocs.ts");

// Serves the Docs API from `google.sim`, and Drive's markdown export as `google.markdown`.
const google = {sim: SimDoc.from(""), markdown: ""};
function serve() {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    const json = (j: unknown) => new Response(JSON.stringify(j), {status: 200, headers: {"content-type": "application/json"}});
    if (u.includes(":batchUpdate")) {
      const replies = google.sim.apply(JSON.parse(init.body).requests);
      return json({replies, writeControl: {requiredRevisionId: `r${google.sim.rev}`}});
    }
    if (u.includes("/export?")) return new Response(google.markdown, {status: 200});
    if (u.includes("docs.googleapis.com")) return json(google.sim.toApi());
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  return () => (globalThis.fetch = real);
}

test("a new checklist item the file ticks warns that it came out unticked", async (t) => {
  t.after(serve());
  const head = `<!-- goog doc sim -->\n`;
  const pushTo = (start: string, file: string) => {
    google.sim = SimDoc.from(start);
    google.markdown = "old\n\n- [ ] new task\n";
    const first = {text: "", rev: `r${google.sim.rev}`, remote: toRemote(google.sim.toApi())};
    return backends.doc.push("sim", parse(head + file), {first});
  };
  const ticked = await pushTo("old", 'old\n<li type="check" checked>new task</li>');
  assert.match(ticked.warnings.join(), /ticking or unticking checklist items/);
  // Written unticked, it doesn't.
  assert.deepEqual((await pushTo("old", 'old\n<li type="check">new task</li>')).warnings, []);
});
