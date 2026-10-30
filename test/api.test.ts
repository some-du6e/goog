// goog api offline: its argument handling, and the requests it sends and what
// it prints, with Google played by a stubbed fetch. The live calls were checked
// by hand against the scratch doc and a Drive copy of it.

import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
const tmp = mkdtempSync(join(tmpdir(), "goog-api-test-"));
process.env.GOOG_CACHE_DIR = join(tmp, "cache");
process.env.GOOG_CONFIG_DIR = join(tmp, "config");
process.env.GOOG_TOKEN = "offline-test";
const {apiUrl, cmdApi, fieldsBody, io, mergePages, parseFields, parseHeader} = await import("../src/api-cmd.ts");

test("paths map to the service's host", () => {
  assert.equal(apiUrl("docs/v1/documents/abc").href, "https://docs.googleapis.com/v1/documents/abc");
  assert.equal(apiUrl("/slides/v1/presentations/abc/pages/p1").href, "https://slides.googleapis.com/v1/presentations/abc/pages/p1");
  assert.equal(apiUrl("drive/v3/files?q=x").href, "https://www.googleapis.com/drive/v3/files?q=x");
  assert.equal(apiUrl("gmail/v1/users/me/profile").href, "https://gmail.googleapis.com/gmail/v1/users/me/profile");
  assert.equal(apiUrl("admin/directory/v1/users").href, "https://admin.googleapis.com/admin/directory/v1/users");
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
});

test("headers", () => {
  assert.deepEqual(parseHeader("Accept: text/plain"), ["Accept", "text/plain"]);
  assert.deepEqual(parseHeader("X-A:b:c"), ["X-A", "b:c"]);
  assert.throws(() => parseHeader("no colon"), /Name: value/);
  assert.throws(() => parseHeader(": v"), /Name: value/);
  assert.throws(() => parseHeader("authorization: Bearer x"), /its own Authorization/);
  assert.throws(() => parseHeader("X-A: a\r\nB: c"), /line break/);
  assert.throws(() => parseHeader("Content-Length: 3"), /sets Content-Length itself/);
  assert.throws(() => parseHeader("host: evil.com"), /sets host itself/);
  assert.throws(() => parseHeader("Transfer-Encoding: chunked"), /sets Transfer-Encoding itself/);
  assert.throws(() => parseHeader("connection: close"), /sets connection itself/);
  assert.throws(() => parseHeader("X-HTTP-Method-Override: DELETE"), /use -X instead/);
  assert.throws(() => parseHeader("X-Note: café ☃"), /only Latin-1 fits/);
  assert.deepEqual(parseHeader("X-Note: café"), ["X-Note", "café"]);
});

test("pages join their lists", () => {
  assert.deepEqual(mergePages([{kind: "k", files: [1, 2], nextPageToken: "t"}, {kind: "k2", files: [3], incompleteSearch: true}]), {kind: "k", files: [1, 2, 3], incompleteSearch: true});
  assert.deepEqual(mergePages([{files: []}]), {files: []});
  assert.deepEqual(mergePages([{a: [1]}, {constructor: "c", a: [2]}]), {a: [1, 2], constructor: "c"});
});

const bin = new URL("../bin/goog.ts", import.meta.url).pathname;
const env = {...process.env};
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
    [["docs/v1/x", "--query", "novalue"], /--query takes key=value/],
    [["docs/v1/x", "-q", ".title"], /no --jq; pipe it to jq/],
    [["docs/v1/x", "--jq", ".title"], /no --jq/],
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

// Each call to the stub takes the next answer and records the request.
type Sent = {method: string; url: URL; body: any; headers: Headers};
async function run(args: string[], answers: (Response | Error)[], opts: {tty?: boolean} = {}) {
  const sent: Sent[] = [];
  let stdout = "";
  let stderr = "";
  const real = {fetch: globalThis.fetch, ...io};
  globalThis.fetch = (async (url: any, init: any) => {
    sent.push({method: init.method, url: new URL(String(url)), body: init.body === undefined ? undefined : JSON.parse(init.body), headers: new Headers(init.headers)});
    const a = answers.shift();
    if (!a) throw new Error(`unexpected fetch ${url}`);
    if (a instanceof Error) throw a;
    return a;
  }) as typeof fetch;
  io.out = (c) => void (stdout += Buffer.isBuffer(c) ? c.toString("latin1") : c);
  io.err = (s) => void (stderr += s);
  io.tty = () => !!opts.tty;
  let error: string | undefined;
  try {
    await cmdApi(args, "help");
  } catch (e: any) {
    error = e.message;
  } finally {
    globalThis.fetch = real.fetch;
    Object.assign(io, {out: real.out, err: real.err, tty: real.tty});
  }
  return {sent, stdout, stderr, error};
}
const json = (j: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(j), {status, headers: {"content-type": "application/json; charset=UTF-8", ...headers}});

test("fields go in the query or the body by method", async () => {
  const cases: {args: string[]; method: string; query: string; body?: unknown}[] = [
    {args: ["drive/v3/files", "-f", "q=name contains 'x'", "-F", "pageSize=5"], method: "GET", query: "q=name+contains+%27x%27&pageSize=5"},
    {args: ["drive/v3/files/a", "-X", "delete", "-f", "supportsAllDrives=true"], method: "DELETE", query: "supportsAllDrives=true"},
    {args: ["drive/v3/files/a/copy", "-X", "POST", "-f", "name=n", "-f", "fields=id", "-f", "alt=json"], method: "POST", query: "fields=id&alt=json", body: {name: "n"}},
    {args: ["drive/v3/files/a", "-X", "PATCH", "-F", "starred=true", "-F", "p[n]=5", "--query", "supportsAllDrives=true"], method: "PATCH", query: "supportsAllDrives=true", body: {starred: true, p: {n: 5}}},
    {args: ["drive/v3/files", "-f", "spaces[]=drive", "-f", "spaces[]=appDataFolder"], method: "GET", query: "spaces=drive&spaces=appDataFolder"},
    {args: ["drive/v3/files/a/copy", "-X", "POST"], method: "POST", query: ""},
  ];
  for (const c of cases) {
    const r = await run(c.args, [json({ok: 1})]);
    assert.equal(r.error, undefined, c.args.join(" "));
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0].method, c.method, c.args.join(" "));
    assert.equal(r.sent[0].url.search.slice(1), c.query, c.args.join(" "));
    assert.deepEqual(r.sent[0].body === undefined ? undefined : {...r.sent[0].body}, c.body, c.args.join(" "));
    assert.equal(r.sent[0].headers.get("authorization"), "Bearer offline-test");
    assert.equal(r.stdout, '{\n  "ok": 1\n}\n');
  }
});

test("--input is the body, and fields then go in the query", async () => {
  writeFileSync(join(tmp, "req.json"), '{"requests":[{"insertText":{"location":{"index":1},"text":"hi"}}]}');
  const r = await run(["docs/v1/documents/d:batchUpdate", "--input", join(tmp, "req.json"), "-f", "x=1", "-H", "content-type: application/json; charset=utf-8"], [json({replies: [{}]})]);
  assert.equal(r.error, undefined);
  assert.equal(r.sent[0].method, "POST");
  assert.equal(r.sent[0].url.href, "https://docs.googleapis.com/v1/documents/d:batchUpdate?x=1");
  assert.equal(r.sent[0].body.requests[0].insertText.text, "hi");
  // -H replaces the default Content-Type, whatever its case.
  assert.equal(r.sent[0].headers.get("content-type"), "application/json; charset=utf-8");
});

test("--paginate follows nextPageToken and joins the lists", async () => {
  const r = await run(["drive/v3/files", "-f", "fields=files(id)", "--paginate"], [
    json({files: [{id: 1}], nextPageToken: "t1"}),
    json({files: [{id: 2}], nextPageToken: "t2"}),
    json({files: [{id: 3}], incompleteSearch: false}),
  ]);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.sent.map((s) => [s.url.searchParams.get("fields"), s.url.searchParams.get("pageToken")]), [
    ["files(id),nextPageToken", null], ["files(id),nextPageToken", "t1"], ["files(id),nextPageToken", "t2"],
  ]);
  assert.deepEqual(JSON.parse(r.stdout), {files: [{id: 1}, {id: 2}, {id: 3}], incompleteSearch: false});
  // fields=* and one that names nextPageToken are left alone.
  for (const f of ["*", "nextPageToken,files(id)"]) {
    const one = await run(["drive/v3/files?fields=" + f, "--paginate"], [json({files: []})]);
    assert.equal(one.sent[0].url.searchParams.get("fields"), f);
  }
});

test("--paginate stops on a failed page, a non-JSON page, or a repeated token", async () => {
  const failed = await run(["drive/v3/files", "--paginate"], [json({files: [1], nextPageToken: "t"}), json({error: {code: 403, message: "nope"}}, 403)]);
  assert.equal(failed.error, "HTTP 403: nope");
  assert.match(failed.stderr, /page 2 failed; the 1 before it are left out/);
  assert.equal(JSON.parse(failed.stdout).error.message, "nope");
  const html = await run(["drive/v3/files", "--paginate"], [json({files: [1], nextPageToken: "t"}), new Response("<html>x</html>", {headers: {"content-type": "text/html"}})]);
  assert.match(html.error ?? "", /page 2 came back as text\/html, not JSON/);
  assert.equal(html.stdout, "");
  const bad = await run(["drive/v3/files", "--paginate"], [json({files: [1], nextPageToken: "t"}), new Response("", {headers: {"content-type": "application/json"}})]);
  assert.equal(bad.error, "page 2 isn't valid JSON");
  // A first page that isn't JSON is just shown.
  const first = await run(["drive/v3/files/a/export", "--paginate"], [new Response("text", {headers: {"content-type": "text/plain"}})]);
  assert.equal(first.error, undefined);
  assert.equal(first.stdout, "text");
  const loop = await run(["drive/v3/files", "--paginate"], [json({nextPageToken: "t"}), json({nextPageToken: "t"})]);
  assert.match(loop.error ?? "", /page token t twice; stopping after 2 pages/);
});

test("what goog api prints", async () => {
  const r = async (a: Response, args: string[] = [], tty = false) => run(["drive/v3/x", ...args], [a], {tty});
  assert.equal((await r(new Response("hello\n", {headers: {"content-type": "text/plain; charset=utf-8"}}))).stdout, "hello\n");
  assert.equal((await r(new Response(null, {status: 204}))).stdout, "");
  assert.equal((await r(json({a: 1}), ["--silent"])).stdout, "");
  assert.equal((await r(new Response("{bad", {headers: {"content-type": "application/json"}}))).stdout, "{bad");
  const pdf = () => new Response(Buffer.from("%PDF-1.4\0\xff", "latin1"), {headers: {"content-type": "application/pdf"}});
  assert.equal((await r(pdf())).stdout, "%PDF-1.4\0\xff");
  const tty = await r(pdf(), [], true);
  assert.match(tty.error ?? "", /application\/pdf \(10 bytes\); redirect it to a file/);
  assert.equal(tty.stdout, "");
  // Errors: Google's JSON on stdout (even with --silent), its message in the error.
  const e = await r(json({error: {code: 404, message: "File not found: x."}}, 404), ["--silent"]);
  assert.equal(e.error, "HTTP 404: File not found: x.");
  assert.equal(JSON.parse(e.stdout).error.code, 404);
  const page = await r(new Response("<html><title>Error 404 (Not Found)!!1</title><p>long page</p></html>", {status: 404, headers: {"content-type": "text/html; charset=UTF-8"}}));
  assert.equal(page.error, "HTTP 404: Error 404 (Not Found)!!1; no such API path (check the service, version and method name)");
  assert.equal(page.stdout, "");
  assert.match((await r(json({error: {message: "Request had insufficient authentication scopes."}}, 403))).error ?? "", /scopes don't cover this API/);
});

test("goog api retries a read but never resends a write Google may have run", async () => {
  const busy = () => json({error: {code: 503, message: "busy"}}, 503, {"retry-after": "0"});
  const get = await run(["drive/v3/files/a"], [busy(), json({id: "a"})]);
  assert.equal(get.error, undefined);
  assert.equal(get.sent.length, 2);
  assert.match(get.stderr, /Google error 503: busy; retrying in 0s/);
  const post = await run(["drive/v3/files/a/copy", "-X", "POST"], [busy()]);
  assert.equal(post.error, "HTTP 503: busy");
  assert.equal(post.sent.length, 1);
  // 429 means Google didn't run it, so even a write is sent again.
  const limited = await run(["drive/v3/files/a/copy", "-X", "POST"], [json({error: {code: 429, message: "slow down"}}, 429, {"retry-after": "0"}), json({id: "b"})]);
  assert.equal(limited.error, undefined);
  assert.equal(limited.sent.length, 2);
});

test("a write is resent after a connection that never opened, but not after one that dropped", async () => {
  const lost = (code: string) => Object.assign(new TypeError("fetch failed"), {cause: {code}});
  const reset = await run(["drive/v3/files/a/copy", "-X", "POST"], [lost("ECONNRESET")]);
  assert.match(reset.error ?? "", /can't reach Google \(ECONNRESET\)/);
  assert.equal(reset.sent.length, 1);
  const refused = await run(["drive/v3/files/a/copy", "-X", "POST"], [lost("ECONNREFUSED"), json({id: "b"})]);
  assert.equal(refused.error, undefined);
  assert.equal(refused.sent.length, 2);
  const read = await run(["drive/v3/files/a"], [lost("ECONNRESET"), json({id: "a"})]);
  assert.equal(read.error, undefined);
  assert.equal(read.sent.length, 2);
});

// A body that errors partway through.
const broken = (status: number, headers: Record<string, string> = {}) => new Response(new ReadableStream({
  pull: (c) => c.error(Object.assign(new TypeError("terminated"), {cause: {code: "UND_ERR_SOCKET"}})),
}), {status, headers: {"content-type": "application/json", ...headers}});

test("an answer that breaks off partway says so; an error that does is still retried", async () => {
  const r = await run(["drive/v3/files/a"], [broken(200)]);
  assert.equal(r.error, "the connection broke during the answer (UND_ERR_SOCKET)");
  // Every command's api() call, not just goog api's.
  const {api} = await import("../src/google.ts");
  const real = globalThis.fetch;
  const answers = [broken(503, {"retry-after": "0"}), json({ok: true})];
  let calls = 0;
  globalThis.fetch = (async () => (calls++, answers.shift()!)) as typeof fetch;
  try {
    assert.deepEqual(await api("GET", "https://docs.googleapis.com/v1/documents/x"), {ok: true});
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = real;
  }
});
