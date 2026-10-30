// goog api's argument handling, offline. The live calls were checked by hand
// against the scratch doc and a Drive copy of it.

import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {apiUrl, fieldsBody, mergePages, parseFields, parseHeader} from "../src/api-cmd.ts";

test("paths map to the service's host", () => {
  assert.equal(apiUrl("docs/v1/documents/abc").href, "https://docs.googleapis.com/v1/documents/abc");
  assert.equal(apiUrl("/slides/v1/presentations/abc/pages/p1").href, "https://slides.googleapis.com/v1/presentations/abc/pages/p1");
  assert.equal(apiUrl("drive/v3/files?q=x").href, "https://www.googleapis.com/drive/v3/files?q=x");
  assert.equal(apiUrl("upload/drive/v3/files").href, "https://www.googleapis.com/upload/drive/v3/files");
  assert.equal(apiUrl("classroom/v1/courses").href, "https://classroom.googleapis.com/v1/courses");
  assert.equal(apiUrl("Sheets/v4/spreadsheets/x").href, "https://sheets.googleapis.com/v4/spreadsheets/x");
  assert.equal(apiUrl("docs/v1/documents/abc:batchUpdate").href, "https://docs.googleapis.com/v1/documents/abc:batchUpdate");
  assert.equal(apiUrl("docs/$discovery/rest?version=v1").href, "https://docs.googleapis.com/$discovery/rest?version=v1");
  assert.equal(apiUrl("docs.googleapis.com/v1/documents/abc").href, "https://docs.googleapis.com/v1/documents/abc");
  assert.equal(apiUrl("https://www.googleapis.com/drive/v3/about").href, "https://www.googleapis.com/drive/v3/about");
});

test("the token only goes to https googleapis.com", () => {
  for (const bad of ["https://evil.com/v1", "https://googleapis.com.evil.com/v1", "http://docs.googleapis.com/v1", "evil.com/v1/x", "https://u:p@docs.googleapis.com/v1"]) {
    assert.throws(() => apiUrl(bad), /googleapis\.com|user name/, bad);
  }
  assert.throws(() => apiUrl("https://docs.google.com/document/d/abc/edit"), /link for the browser/);
  assert.throws(() => apiUrl("docs"), /isn't an API path/);
  assert.throws(() => apiUrl("docs/"), /isn't an API path/);
  assert.throws(() => apiUrl("d?cs/v1"), /isn't an API path/);
  assert.throws(() => apiUrl(" "), /needs a path/);
});

test("-f keeps strings, -F types them and reads @files", () => {
  const files: Record<string, string> = {"a.txt": "from a file\n"};
  const f = parseFields(["n=10", "eq=a=b", "empty="], ["n2=10", "t=true", "f=false", "z=null", "x=1.5", "big=12345678901234567890", "zero=007", "s=hi", "file=@a.txt"], (p) => files[p]);
  assert.deepEqual(Object.fromEntries(f.map((x) => [x.key, x.value])), {
    n: "10", eq: "a=b", empty: "", n2: 10, t: true, f: false, z: null, x: 1.5, big: "12345678901234567890", zero: "007", s: "hi", file: "from a file\n",
  });
  assert.throws(() => parseFields(["novalue"], [], () => ""), /-f takes key=value/);
  assert.throws(() => parseFields(["=x"], [], () => ""), /-f takes key=value/);
  assert.throws(() => parseFields([], ["k"], () => ""), /-F takes key=value/);
});

test("fields nest into a body", () => {
  const body = fieldsBody([
    {key: "name", value: "x"},
    {key: "a[b][c]", value: 1},
    {key: "a[b][d]", value: true},
    {key: "tags[]", value: "one"},
    {key: "tags[]", value: "two"},
    {key: "o[list][]", value: 3},
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(body)), {name: "x", a: {b: {c: 1, d: true}}, tags: ["one", "two"], o: {list: [3]}});
  assert.throws(() => fieldsBody([{key: "a", value: 1}, {key: "a", value: 2}]), /given twice/);
  assert.throws(() => fieldsBody([{key: "a", value: 1}, {key: "a[b]", value: 2}]), /already a value/);
  assert.throws(() => fieldsBody([{key: "a[]", value: 1}, {key: "a[b]", value: 2}]), /already a list/);
  assert.throws(() => fieldsBody([{key: "a[][b]", value: 1}]), /only goes at the end/);
  assert.throws(() => fieldsBody([{key: "a]b", value: 1}]), /isn't a field name/);
  // Keys like __proto__ stay plain keys.
  assert.equal(JSON.stringify(fieldsBody([{key: "x[constructor]", value: 1}, {key: "__proto__[y]", value: 2}])), '{"x":{"constructor":1},"__proto__":{"y":2}}');
  assert.equal(({} as any).y, undefined);
});

test("headers", () => {
  assert.deepEqual(parseHeader("Accept: text/plain"), ["Accept", "text/plain"]);
  assert.deepEqual(parseHeader("X-A:b:c"), ["X-A", "b:c"]);
  assert.throws(() => parseHeader("no colon"), /Name: value/);
  assert.throws(() => parseHeader(": v"), /Name: value/);
  assert.throws(() => parseHeader("authorization: Bearer x"), /its own Authorization/);
});

test("pages join their lists", () => {
  assert.deepEqual(mergePages([{kind: "k", files: [1, 2], nextPageToken: "t"}, {kind: "k2", files: [3], incompleteSearch: true}]), {kind: "k", files: [1, 2, 3], incompleteSearch: true});
  assert.deepEqual(mergePages([{files: []}]), {files: []});
});

const tmp = mkdtempSync(join(tmpdir(), "goog-api-test-"));
const bin = new URL("../bin/goog.ts", import.meta.url).pathname;
const env = {...process.env, GOOG_CACHE_DIR: join(tmp, "cache"), GOOG_CONFIG_DIR: join(tmp, "config"), GOOG_TOKEN: "offline-test"};
const goog = (args: string[], input?: string) => spawnSync(process.execPath, [bin, "api", ...args], {cwd: tmp, env, encoding: "utf8", input});

test("goog api refuses bad arguments before calling Google", () => {
  writeFileSync(join(tmp, "bad.json"), "{");
  writeFileSync(join(tmp, "empty.json"), "  \n");
  const cases: [string[], RegExp, string?][] = [
    [[], /needs a path/],
    [["docs/v1/a", "docs/v1/b"], /takes one path/],
    [["https://example.com/x"], /only sends the sign-in/],
    [["docs/v1/x", "-X", "FOO"], /-X takes GET/],
    [["docs/v1/x", "-X", "GET", "--input", "-"], /GET can't have a body/, "{}"],
    [["docs/v1/x", "--input", "nope.json"], /can't read nope\.json for --input: no such file/],
    [["docs/v1/x", "--input", "bad.json"], /bad\.json isn't JSON/],
    [["docs/v1/x", "--input", "empty.json"], /is empty/],
    [["docs/v1/x", "--input", "-", "-F", "a=@-"], /only one of --input and -F/, "{}"],
    [["docs/v1/x", "-F", "a=@missing.txt"], /can't read missing\.txt for -F/],
    [["docs/v1/x", "-X", "POST", "--paginate"], /--paginate only follows GETs/],
    [["docs/v1/x", "-f", "a=1", "-f", "a=2", "-X", "PATCH"], /given twice/],
    [["docs/v1/x", "-q", "novalue"], /-q takes key=value/],
    [["docs/v1/x", "-H", "Authorization: x"], /its own Authorization/],
    [["docs/v1/x", "--json"], /always prints JSON/],
  ];
  for (const [args, want, input] of cases) {
    const r = goog(args, input);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, want, args.join(" "));
  }
});

test("goog api --help shows its part of the help", () => {
  const r = goog(["-X", "POST", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^  goog api <path>/);
  assert.match(r.stdout, /--paginate/);
  assert.doesNotMatch(r.stdout, /goog wait/);
});
