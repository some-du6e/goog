// goog api: any Google REST call with goog's sign-in, like gh api.
//
// The token only goes to https://*.googleapis.com. Fields follow gh: -f is a
// string, -F keeps true/false/null/numbers and reads @FILE. Unlike gh, fields
// alone don't turn a GET into a POST: Google's GETs take most of their options
// as query parameters (q=, fields=), and a list that quietly became a create
// would make files.

import {readFileSync} from "node:fs";
import {parseArgs} from "node:util";
import {forgetToken, getToken} from "./auth.ts";
import {backoff} from "./google.ts";

const API_USAGE = "goog api <path> [-X METHOD] [-f key=value] [-F key=value] [--query key=value] [--input FILE] [-H 'Name: value'] [--paginate] [--silent]";

// Services Google serves from www.googleapis.com/<service>/<version>/…
const WWW = new Set(["drive", "calendar", "oauth2", "youtube", "tasks"]);
// Services whose own host keeps their name in the path: gmail.googleapis.com/gmail/v1/…
const NAMED = new Set(["gmail", "storage", "bigquery", "admin", "compute", "dns", "androidpublisher"]);
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
// Google's standard parameters: never part of a body, so -f sends them in the query.
const SYSTEM = new Set(["fields", "alt", "prettyPrint", "quotaUser", "uploadType", "upload_protocol", "$.xgafv"]);

// docs/v1/documents/ID, drive/v3/files, docs.googleapis.com/v1/… or a full URL.
export function apiUrl(path: string): URL {
  const p = path.trim();
  if (!p) throw new Error(`goog api needs a path, like docs/v1/documents/<id>\nusage: ${API_USAGE}`);
  let url: URL;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) url = new URL(p);
  else {
    const clean = p.replace(/^\/+/, "");
    const slash = clean.indexOf("/");
    const svc = (slash < 0 ? clean : clean.slice(0, slash)).toLowerCase();
    const rest = slash < 0 ? "" : clean.slice(slash + 1);
    if (svc.includes(".")) url = new URL(`https://${clean}`);
    else {
      if (!/^[a-z0-9-]+$/.test(svc) || !rest) throw new Error(`"${path}" isn't an API path; write <service>/<version>/…, like docs/v1/documents/<id> or drive/v3/files`);
      url = new URL(WWW.has(svc) ? `https://www.googleapis.com/${svc}/${rest}` : `https://${svc}.googleapis.com/${NAMED.has(svc) ? `${svc}/` : ""}${rest}`);
    }
  }
  if (/^(docs|drive|classroom)\.google\.com$/.test(url.hostname)) {
    throw new Error(`${url.hostname} is a link for the browser; goog api takes an API path like docs/v1/documents/<id> (goog cat reads a doc from its link)`);
  }
  if (url.protocol !== "https:" || !(url.hostname === "googleapis.com" || url.hostname.endsWith(".googleapis.com"))) {
    throw new Error(`goog api only sends the sign-in to https://*.googleapis.com, not ${url.protocol}//${url.host}`);
  }
  if (url.username || url.password) throw new Error("the URL can't carry a user name or password");
  return url;
}

type Field = {key: string; value: unknown};

function keyValue(s: string, flag: string): {key: string; value: string} {
  const eq = s.indexOf("=");
  if (eq < 1) throw new Error(`${flag} takes key=value (got "${s}")`);
  return {key: s.slice(0, eq), value: s.slice(eq + 1)};
}

// -f key=value, then -F key=value.
export function parseFields(raw: string[], typed: string[], readFile: (f: string) => string): Field[] {
  return [...raw.map((s) => keyValue(s, "-f")), ...typed.map((s) => keyValue(s, "-F")).map((f) => ({...f, value: typedValue(f.value, readFile)}))];
}

function typedValue(v: string, readFile: (f: string) => string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(v)) {
    const n = Number(v);
    // Google sends int64s as strings; a number past 2^53 would lose digits.
    if (Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n))) return n;
    return v;
  }
  if (v.startsWith("@")) return readFile(v.slice(1));
  return v;
}

// a[b][c]=1 nests, a[]=1 appends to a list.
export function fieldsBody(fields: Field[]): Record<string, unknown> {
  // No prototype, so keys like constructor and __proto__ stay plain keys.
  const body: Record<string, unknown> = Object.create(null);
  for (const {key, value} of fields) {
    const m = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(key);
    if (!m) throw new Error(`"${key}" isn't a field name; write name, name[sub] or name[] for a list`);
    const path = [m[1], ...[...m[2].matchAll(/\[([^[\]]*)\]/g)].map((x) => x[1])];
    if (path.slice(0, -1).includes("")) throw new Error(`"${key}": [] only goes at the end; use --input for lists of objects`);
    let at: any = body;
    for (let i = 0; i < path.length; i++) {
      const k = path[i];
      const last = i === path.length - 1;
      const next = path[i + 1];
      if (last) {
        if (k === "") at.push(value);
        else if (Object.hasOwn(at, k)) throw new Error(`${key} is given twice; write ${key}[]=… for a list`);
        else at[k] = value;
      } else {
        const want = next === "" ? "list" : "object";
        if (!Object.hasOwn(at, k)) at[k] = want === "list" ? [] : Object.create(null);
        const have = Array.isArray(at[k]) ? "list" : at[k] !== null && typeof at[k] === "object" ? "object" : "value";
        if (have !== want) throw new Error(`${key}: ${path.slice(0, i + 1).join(".")} is already a ${have}`);
        at = at[k];
      }
    }
  }
  return body;
}

// For GET and DELETE: a[]=x and repeated keys become repeated parameters.
function addQuery(url: URL, fields: Field[]) {
  for (const {key, value} of fields) {
    if (value !== null && typeof value === "object") throw new Error(`${key} can't be a query parameter`);
    url.searchParams.append(key.replace(/\[\]$/, ""), value === null ? "" : String(value));
  }
}

export function parseHeader(h: string): [string, string] {
  const colon = h.indexOf(":");
  const name = colon < 0 ? "" : h.slice(0, colon).trim();
  const value = h.slice(colon + 1).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`-H takes "Name: value" (got "${h}")`);
  if (/^authorization$/i.test(name)) throw new Error("goog api sends its own Authorization header; goog auth changes the sign-in");
  if (/^(host|content-length|transfer-encoding|connection|keep-alive|upgrade|expect)$/i.test(name)) throw new Error(`goog api sets ${name} itself`);
  // It would turn a GET, which goog retries, into a write.
  if (/^x-http-method(-override)?$/i.test(name)) throw new Error(`use -X instead of -H ${name}`);
  if (/[\0-\x08\x0a-\x1f\x7f]/.test(value)) throw new Error(`the -H ${name} value has a line break or control character in it`);
  if (/[^\0-\xff]/.test(value)) throw new Error(`the -H ${name} value has characters HTTP headers can't carry; only Latin-1 fits`);
  return [name, value];
}

// Joins the lists of each page into the first page.
export function mergePages(pages: any[]): any {
  const all = {...pages[0]};
  for (const p of pages.slice(1)) {
    for (const [k, v] of Object.entries(p)) {
      if (Array.isArray(v) && Array.isArray(all[k])) all[k] = [...all[k], ...v];
      else if (!Object.hasOwn(all, k)) all[k] = v;
    }
  }
  delete all.nextPageToken;
  return all;
}

type Answer = {status: number; type: string; data: Buffer};
// Where it prints; the tests swap these.
export const io = {
  out: (c: string | Buffer) => void process.stdout.write(c),
  err: (s: string) => void process.stderr.write(s),
  tty: () => !!process.stdout.isTTY,
  stderrTty: () => !!process.stderr.isTTY,
};
const isJson = (type: string) => /[/+]json\b/i.test(type);
const isText = (type: string) => /^text\/|[/+](xml|csv)\b|charset=/i.test(type);

export async function cmdApi(args: string[], help: string) {
  if (args.includes("--json")) throw new Error("goog api always prints JSON; leave out --json");
  if (args.some((a) => a === "-q" || a === "--jq" || a.startsWith("--jq="))) throw new Error("goog api has no --jq; pipe it to jq (goog api … | jq .title). --query key=value adds a query parameter");
  const {values: o, positionals: pos} = parseArgs({
    args,
    allowPositionals: true,
    options: {
      method: {type: "string", short: "X"},
      "raw-field": {type: "string", short: "f", multiple: true},
      field: {type: "string", short: "F", multiple: true},
      query: {type: "string", multiple: true},
      header: {type: "string", short: "H", multiple: true},
      input: {type: "string"},
      paginate: {type: "boolean"},
      silent: {type: "boolean"},
      help: {type: "boolean", short: "h"},
    },
  });
  if (o.help) return void io.out(help + "\n");
  if (pos.length !== 1) throw new Error(`${pos.length ? "goog api takes one path (quote a URL with ? or & in it)" : "goog api needs a path"}\nusage: ${API_USAGE}`);
  const url = apiUrl(pos[0]);

  let stdinUsed = false;
  const read = (f: string, what: string) => {
    if (!f) throw new Error(`${what} needs a file name, or - for stdin`);
    if (f === "-") {
      if (stdinUsed) throw new Error("only one of --input and -F …=@- can read stdin");
      stdinUsed = true;
    }
    try {
      return readFileSync(f === "-" ? 0 : f, "utf8");
    } catch (e: any) {
      throw new Error(`can't read ${f === "-" ? "stdin" : f} for ${what}: ${e.code === "ENOENT" ? "no such file" : e.message}`);
    }
  };
  const all = parseFields(o["raw-field"] ?? [], o.field ?? [], (f) => read(f, "-F"));
  const fields = all.filter((f) => !SYSTEM.has(f.key));
  addQuery(url, [...all.filter((f) => SYSTEM.has(f.key)), ...(o.query ?? []).map((s) => keyValue(s, "--query"))]);

  let body: unknown;
  if (o.input !== undefined) {
    const src = o.input === "-" ? "stdin" : o.input;
    const text = read(o.input, "--input");
    if (!text.trim()) throw new Error(`--input ${src} is empty`);
    try {
      body = JSON.parse(text);
    } catch (e: any) {
      throw new Error(`--input ${src} isn't JSON: ${e.message}`);
    }
  }
  const method = (o.method ?? (body === undefined ? "GET" : "POST")).toUpperCase();
  if (!METHODS.includes(method)) throw new Error(`-X takes ${METHODS.join(", ")} (got "${o.method}")`);
  if (method === "GET" && body !== undefined) throw new Error("a GET can't have a body; add -X POST (or PATCH, PUT) to send --input");
  // As in gh: with --input, fields go in the query.
  if (body !== undefined || method === "GET" || method === "DELETE") addQuery(url, fields);
  else if (fields.length) body = fieldsBody(fields);
  if (o.paginate && method !== "GET") throw new Error("--paginate only follows GETs");

  const headers = Object.fromEntries((o.header ?? []).map(parseHeader));
  const call = () => request(method, url.href, body, headers);
  if (!o.paginate) return show(await call(), !!o.silent, method);
  return paginate(url, call, !!o.silent);
}

// Exports, big downloads and Apps Script runs can take minutes.
export const limits = {timeoutMs: 600_000};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry(message: string, delayMs: number) {
  io.err(`goog: ${message}; retrying in ${Math.ceil(delayMs / 1000)}s\n`);
  await sleep(delayMs);
}

// goog api's own request loop, apart from api() in google.ts: those calls are
// goog's own, and safe to resend, but a write here could be anything, and sent
// twice it could make two of something. So a write is only sent again after a
// 401 or a rate limit, which mean Google didn't run it. A GET is also retried
// after a 5xx or a lost connection. Timeouts aren't retried. Every answer comes
// back, errors included, for show() to print.
export async function request(method: string, url: string, body: unknown, extra: Record<string, string>): Promise<Answer> {
  const write = method !== "GET";
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const headers = new Headers(extra);
    if (body !== undefined && !headers.has("content-type")) headers.set("Content-Type", "application/json");
    headers.set("Authorization", `Bearer ${await getToken()}`);
    // The limit covers the whole answer, body included.
    const signal = AbortSignal.timeout(limits.timeoutMs);
    let r: Response;
    let data: Buffer;
    try {
      r = await fetch(url, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal});
    } catch (e: any) {
      const timedOut = e?.name === "TimeoutError";
      const why = timedOut ? `no answer in ${limits.timeoutMs / 1000}s` : (e?.cause?.code ?? e?.cause?.message ?? e?.message);
      if (!write && !timedOut && attempt < 3) {
        await retry(`can't reach Google (${why})`, 1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`can't reach Google (${why}); ${write ? "the write may still have gone through" : "check the network connection"}`);
    }
    try {
      data = Buffer.from(await r.arrayBuffer());
    } catch (e: any) {
      const timedOut = e?.name === "TimeoutError";
      const why = timedOut ? `the answer took over ${limits.timeoutMs / 1000}s` : `the connection broke during the answer (${e?.cause?.code ?? e?.message})`;
      if (r.ok && write) throw new Error(`${why}; Google did the write (HTTP ${r.status}), but its answer was lost`);
      if (timedOut) throw new Error(r.ok ? why : `HTTP ${r.status}, and ${why}`);
      if (r.ok) {
        if (attempt < 3) {
          await retry(why, 1000 * 2 ** attempt);
          continue;
        }
        throw new Error(why);
      }
      // An error that broke off is still handled on its status.
      data = Buffer.alloc(0);
    }
    const type = r.headers.get("content-type") ?? "";
    if (r.ok) return {status: r.status, type, data};
    let j: any = {};
    try {
      j = JSON.parse(data.toString("utf8")) ?? {};
    } catch {}
    const reason: string = j.error?.errors?.[0]?.reason ?? j.error?.details?.find((d: any) => d.reason)?.reason ?? "";
    if (r.status === 401 && !refreshed) {
      refreshed = true;
      forgetToken();
      continue;
    }
    if ((r.status === 429 || /rate ?limit/i.test(reason) || (!write && r.status >= 500)) && attempt < 6) {
      await retry(r.status === 429 ? "Google rate limit" : `Google error ${r.status}: ${j.error?.message ?? r.statusText}`, backoff(attempt, r.headers.get("retry-after"), r.status));
      continue;
    }
    return {status: r.status, type, data};
  }
}

async function paginate(url: URL, call: () => Promise<Answer>, silent: boolean) {
  // A fields= that leaves nextPageToken out would stop at the first page.
  const f = url.searchParams.get("fields");
  if (f && f !== "*" && !/\bnextPageToken\b/.test(f)) url.searchParams.set("fields", `${f},nextPageToken`);
  const pages: any[] = [];
  const seen = new Set<string>();
  for (;;) {
    const a = await call();
    let page: any;
    try {
      if (a.status < 300 && isJson(a.type)) page = JSON.parse(a.data.toString("utf8"));
    } catch {}
    if (page === undefined) {
      // The first page can be anything; a later one that isn't JSON is a failure too.
      if (!pages.length) return show(a, silent);
      io.err(`goog: page ${pages.length + 1} failed; the ${pages.length} before it are left out\n`);
      if (a.status < 300) throw new Error(`page ${pages.length + 1} came back as ${a.type || "an untyped answer"}, not valid JSON`);
      return show(a, silent);
    }
    pages.push(page);
    if (pages.length % 10 === 0 && io.stderrTty()) io.err(`goog: ${pages.length} pages so far\n`);
    const token = page?.nextPageToken;
    if (typeof token !== "string" || !token) break;
    if (seen.has(token)) throw new Error(`Google sent page token ${token} twice; stopping after ${pages.length} pages`);
    seen.add(token);
    url.searchParams.set("pageToken", token);
  }
  if (!silent) io.out(JSON.stringify(mergePages(pages), null, 2) + "\n");
}

// Prints an answer; throws for an error, after printing Google's JSON error.
function show(a: Answer, silent: boolean, method = "GET") {
  const ok = a.status < 300;
  let parsed: any;
  if (isJson(a.type) || (!a.type && a.data.length)) {
    try {
      parsed = JSON.parse(a.data.toString("utf8"));
    } catch {}
  }
  if (ok && !silent) {
    if (parsed !== undefined) io.out(JSON.stringify(parsed, null, 2) + "\n");
    else if (!a.data.length) {
      // 204 and empty answers print nothing.
    } else if (isText(a.type) || isJson(a.type)) io.out(a.data);
    else if (io.tty()) {
      throw new Error(`the answer is ${a.type || "binary"} (${a.data.length} bytes); redirect it to a file: goog api … > file`);
    } else io.out(a.data);
  }
  if (ok) return;
  // Google's JSON error goes to stdout, as gh does; an HTML error page would only be noise.
  if (parsed !== undefined) io.out(JSON.stringify(parsed, null, 2) + "\n");
  const text = a.data.toString("utf8");
  const msg = parsed?.error?.message
    ?? (/html/i.test(a.type) ? /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() : isText(a.type) ? text.trim().slice(0, 300) : undefined)
    ?? "";
  const hint = a.status === 401 ? "; run goog auth to sign in again"
    : a.status === 403 && /scope/i.test(msg) ? "; the token's scopes don't cover this API (goog auth status)"
    // A write isn't resent after a 5xx (see request()), but it may have run.
    : a.status >= 500 && method !== "GET" ? "; the write may still have gone through"
    : (a.status === 404 || a.status === 405) && /html/i.test(a.type) ? "; no such API path (check the service, version and method name)"
    : "";
  throw new Error(`HTTP ${a.status}${msg ? `: ${msg}` : ""}${hint}`);
}
