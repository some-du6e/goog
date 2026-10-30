// goog api: any Google REST call with goog's sign-in, like gh api.
//
// The token only goes to https://*.googleapis.com. Fields follow gh: -f is a
// string, -F keeps true/false/null/numbers and reads @FILE. Unlike gh, fields
// alone don't turn a GET into a POST: Google's GETs take most of their options
// as query parameters (q=, fields=), and a list that quietly became a create
// would make files.

import {readFileSync} from "node:fs";
import {parseArgs} from "node:util";
import {api, setRetryListener} from "./google.ts";

export const API_USAGE = "goog api <path> [-X METHOD] [-f key=value] [-F key=value] [-q key=value] [--input FILE] [-H 'Name: value'] [--paginate] [--silent]";

// Services Google serves from www.googleapis.com/<service>/<version>/…
const WWW = new Set(["drive", "upload", "calendar", "oauth2", "youtube", "tasks", "batch"]);
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
      url = new URL(WWW.has(svc) ? `https://www.googleapis.com/${svc}/${rest}` : `https://${svc}.googleapis.com/${rest}`);
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

// -f key=value and -F key=value, in the order given.
export function parseFields(raw: string[], typed: string[], readFile: (f: string) => string, rawFlag = "-f"): Field[] {
  const split = (s: string, flag: string) => {
    const eq = s.indexOf("=");
    if (eq < 1) throw new Error(`${flag} takes key=value (got "${s}")`);
    return [s.slice(0, eq), s.slice(eq + 1)];
  };
  const fields: Field[] = raw.map((s) => {
    const [key, value] = split(s, rawFlag);
    return {key, value};
  });
  for (const s of typed) {
    const [key, v] = split(s, "-F");
    fields.push({key, value: typedValue(v, readFile)});
  }
  return fields;
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
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`-H takes "Name: value" (got "${h}")`);
  if (/^authorization$/i.test(name)) throw new Error("goog api sends its own Authorization header; goog auth changes the sign-in");
  return [name, h.slice(colon + 1).trim()];
}

// Joins the lists of each page into the first page.
export function mergePages(pages: any[]): any {
  const all = {...pages[0]};
  for (const p of pages.slice(1)) {
    for (const [k, v] of Object.entries(p)) {
      if (Array.isArray(v) && Array.isArray(all[k])) all[k] = [...all[k], ...v];
      else if (!(k in all)) all[k] = v;
    }
  }
  delete all.nextPageToken;
  return all;
}

type Answer = {status: number; type: string; data: Buffer};
const isJson = (type: string) => /[/+]json\b/i.test(type);
const isText = (type: string) => /^text\/|[/+](xml|csv)\b|charset=/i.test(type);

export async function cmdApi(args: string[], help: string) {
  if (args.includes("--json")) throw new Error("goog api always prints JSON; leave out --json");
  const {values: o, positionals: pos} = parseArgs({
    args,
    allowPositionals: true,
    options: {
      method: {type: "string", short: "X"},
      "raw-field": {type: "string", short: "f", multiple: true},
      field: {type: "string", short: "F", multiple: true},
      query: {type: "string", short: "q", multiple: true},
      header: {type: "string", short: "H", multiple: true},
      input: {type: "string"},
      paginate: {type: "boolean"},
      silent: {type: "boolean"},
      help: {type: "boolean", short: "h"},
    },
  });
  if (o.help) return void process.stdout.write(help + "\n");
  if (pos.length !== 1) throw new Error(`${pos.length ? "goog api takes one path (quote a URL with ? or & in it)" : "goog api needs a path"}\nusage: ${API_USAGE}`);
  const url = apiUrl(pos[0]);

  let stdinUsed = false;
  const read = (f: string, what: string) => {
    if (f === "-") {
      if (stdinUsed) throw new Error("only one of --input and -F …=@- can read stdin");
      stdinUsed = true;
    }
    if (!f) throw new Error(`${what} needs a file name, or - for stdin`);
    try {
      return readFileSync(f === "-" ? 0 : f, "utf8");
    } catch (e: any) {
      throw new Error(`can't read ${f === "-" ? "stdin" : f} for ${what}: ${e.code === "ENOENT" ? "no such file" : e.message}`);
    }
  };
  const all = parseFields(o["raw-field"] ?? [], o.field ?? [], (f) => read(f, "-F"));
  const fields = all.filter((f) => !SYSTEM.has(f.key));
  addQuery(url, [...all.filter((f) => SYSTEM.has(f.key)), ...parseFields(o.query ?? [], [], () => "", "-q")]);

  let body: unknown;
  if (o.input !== undefined) {
    const text = read(o.input, "--input");
    if (!text.trim()) throw new Error(`--input ${o.input} is empty`);
    try {
      body = JSON.parse(text);
    } catch (e: any) {
      throw new Error(`--input ${o.input === "-" ? "(stdin)" : o.input} isn't JSON: ${e.message}`);
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
  setRetryListener(({message, delayMs}) => process.stderr.write(`goog: ${message}; retrying in ${Math.ceil(delayMs / 1000)}s\n`));

  if (!o.paginate) return show(await api<Answer>(method, url.href, body, {raw: true, headers}), !!o.silent);

  // A fields= that leaves nextPageToken out would stop at the first page.
  const f = url.searchParams.get("fields");
  if (f && f !== "*" && !/\bnextPageToken\b/.test(f)) url.searchParams.set("fields", `${f},nextPageToken`);
  const pages: any[] = [];
  const seen = new Set<string>();
  for (;;) {
    const a = await api<Answer>("GET", url.href, undefined, {raw: true, headers});
    if (a.status >= 300 || !isJson(a.type)) {
      if (pages.length) process.stderr.write(`goog: page ${pages.length + 1} failed; the ${pages.length} before it are left out\n`);
      return show(a, !!o.silent);
    }
    const page = JSON.parse(a.data.toString("utf8"));
    pages.push(page);
    if (pages.length % 10 === 0 && process.stderr.isTTY) process.stderr.write(`goog: ${pages.length} pages so far\n`);
    const token = page?.nextPageToken;
    if (typeof token !== "string" || !token) break;
    if (seen.has(token)) throw new Error(`Google sent page token ${token} twice; stopping after ${pages.length} pages`);
    seen.add(token);
    url.searchParams.set("pageToken", token);
  }
  return show({status: 200, type: "application/json", data: Buffer.from(JSON.stringify(mergePages(pages)))}, !!o.silent);
}

function show(a: Answer, silent: boolean) {
  const ok = a.status < 300;
  let parsed: any;
  if (isJson(a.type) || (!a.type && a.data.length)) {
    try {
      parsed = JSON.parse(a.data.toString("utf8"));
    } catch {}
  }
  if (ok && !silent) {
    if (parsed !== undefined) process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
    else if (!a.data.length) {
      // 204 and empty answers print nothing.
    } else if (isText(a.type) || isJson(a.type)) process.stdout.write(a.data);
    else if (process.stdout.isTTY) {
      throw new Error(`the answer is ${a.type || "binary"} (${a.data.length} bytes); redirect it to a file: goog api … > file`);
    } else process.stdout.write(a.data);
  }
  if (ok) return;
  // Google's JSON error goes to stdout, as gh does; an HTML error page would only be noise.
  if (parsed !== undefined) process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
  const text = a.data.toString("utf8");
  const msg = parsed?.error?.message
    ?? (/html/i.test(a.type) ? /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() : isText(a.type) ? text.trim().slice(0, 300) : undefined)
    ?? "";
  const hint = a.status === 401 ? "; run goog auth to sign in again"
    : a.status === 403 && /scope/i.test(msg) ? "; the token's scopes don't cover this API (goog auth status)"
    : /html/i.test(a.type) ? "; no such API path (check the service, version and method name)"
    : "";
  throw new Error(`HTTP ${a.status}${msg ? `: ${msg}` : ""}${hint}`);
}
