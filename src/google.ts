// A small authenticated JSON client for Google's REST APIs.
//
// Retries what's worth retrying: 401 once with a fresh token, 429 and 5xx with
// backoff (Docs write quotas are per minute, so this waits up to about a minute),
// and network failures. Errors about a specific doc say what to do about them.

import {forgetToken, getToken} from "./auth.ts";

export class ApiError extends Error {
  status: number; // 0 when Google couldn't be reached
  reason?: string;
  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

export const DOCS = "https://docs.googleapis.com/v1/documents";
export const DRIVE = "https://www.googleapis.com/drive/v3";

type RetryListener = (info: {status: number; message: string; delayMs: number; attempt: number}) => void;
let onRetry: RetryListener | undefined;
// `goog edit` uses this to say why it's waiting.
export function setRetryListener(fn: RetryListener | undefined) {
  onRetry = fn;
}

const TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 7;
// Connection errors that mean the request never left this machine.
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt: number, retryAfter: string | null, status: number): number {
  const s = Number(retryAfter);
  if (retryAfter && Number.isFinite(s)) return Math.min(s * 1000, 65_000);
  const base = status === 429 ? 4000 : 1000; // quota windows are a minute long
  return Math.min(base * 2 ** attempt, 32_000) * (0.75 + Math.random() * 0.5);
}

// opts.text returns the body as a string, opts.bytes as {status, type, data}.
// opts.raw returns that for every answer, errors included, once retrying is
// over (for goog api, which shows Google's own error); a write it sends isn't
// sent again once Google may have run it, and a timeout isn't retried.
// opts.headers adds headers; Authorization is always goog's. Google gets
// opts.timeoutMs (a minute) to start answering, and as long again to finish.
export async function api<T = any>(method: string, url: string, body?: unknown, opts: {text?: boolean; bytes?: boolean; raw?: boolean; headers?: Record<string, string>; timeoutMs?: number} = {}): Promise<T> {
  const ms = opts.timeoutMs ?? TIMEOUT_MS;
  const once = opts.raw && method !== "GET";
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await getToken();
    const headers = new Headers(opts.headers);
    if (body !== undefined && !headers.has("content-type")) headers.set("Content-Type", "application/json");
    headers.set("Authorization", `Bearer ${token}`);
    const ac = new AbortController();
    const timeout = (limit: number) => setTimeout(() => ac.abort(new DOMException(`no answer in ${limit / 1000}s`, "TimeoutError")), limit).unref();
    let timer = timeout(ms);
    let r: Response;
    try {
      r = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e: any) {
      clearTimeout(timer);
      const timedOut = e?.name === "TimeoutError";
      const why = timedOut ? `no answer in ${ms / 1000}s` : (e?.cause?.code ?? e?.cause?.message ?? e?.message);
      // A write that timed out may have landed; don't send it twice. Nor any
      // goog api write, unless the connection was never made.
      const unsent = NOT_SENT.has(e?.cause?.code);
      if (attempt < 3 && (method === "GET" || !timedOut) && !(opts.raw && timedOut) && (!once || unsent)) {
        const delayMs = 1000 * 2 ** attempt;
        onRetry?.({status: 0, message: `can't reach Google (${why})`, delayMs, attempt});
        await sleep(delayMs);
        continue;
      }
      // Rerunning a write that may have landed could do it twice; say so.
      throw new ApiError(0, `can't reach Google (${why}); ${method !== "GET" && !unsent ? "the write may still have gone through" : "check the network connection"}`);
    }
    clearTimeout(timer);
    const bytes = async (limit: number) => {
      timer = timeout(limit);
      try {
        return Buffer.from(await r.arrayBuffer());
      } catch (e: any) {
        const done = r.ok && method !== "GET" ? `; Google did the write (HTTP ${r.status}), but its answer was lost` : "";
        throw new ApiError(0, (e?.name === "TimeoutError" ? `the answer took over ${limit / 1000}s to come in` : `the connection broke during the answer (${e?.cause?.code ?? e?.message})`) + done);
      } finally {
        clearTimeout(timer);
      }
    };
    if (r.ok) {
      const data = await bytes(ms);
      if (opts.raw || opts.bytes) return {status: r.status, type: r.headers.get("content-type") ?? "", data} as T;
      if (r.status === 204) return null as T;
      // TextDecoder drops a BOM, as r.text() and r.json() do.
      const text = new TextDecoder().decode(data);
      return (opts.text ? text : JSON.parse(text)) as T;
    }
    // Error bodies are small, so a minute is plenty; one that breaks off is
    // still retried on its status.
    const data = await bytes(Math.min(ms, TIMEOUT_MS)).catch(() => Buffer.alloc(0));
    let j: any = {};
    try {
      j = JSON.parse(data.toString("utf8")) ?? {};
    } catch {}
    const msg: string = j.error?.message ?? r.statusText;
    const reason: string | undefined = j.error?.errors?.[0]?.reason ?? j.error?.details?.find((d: any) => d.reason)?.reason;
    if (r.status === 401 && !refreshed) {
      refreshed = true;
      forgetToken();
      continue;
    }
    // A 5xx may come after the work was done; 429 and rate limits mean it wasn't.
    if ((r.status === 429 || (r.status >= 500 && !once) || /rate ?limit/i.test(reason ?? "")) && attempt < MAX_ATTEMPTS - 1) {
      const delayMs = backoff(attempt, r.headers.get("retry-after"), r.status);
      onRetry?.({status: r.status, message: r.status === 429 ? "Google rate limit" : `Google error ${r.status}: ${msg}`, delayMs, attempt});
      await sleep(delayMs);
      continue;
    }
    if (opts.raw) return {status: r.status, type: r.headers.get("content-type") ?? "", data} as T;
    if (r.status === 404 && url.startsWith(DOCS)) {
      const other = await whatIs(url);
      if (other) throw new ApiError(404, other, reason);
    }
    throw new ApiError(r.status, explain(r.status, msg, url), reason);
  }
}

const KINDS: Record<string, string> = {
  "application/vnd.google-apps.spreadsheet": "a Google Sheet (not supported yet)",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/vnd.google-apps.folder": "a folder",
  "application/vnd.google-apps.form": "a Google Form",
  "application/vnd.google-apps.drawing": "a Google Drawing",
};

// The Docs API says "not found" for anything that isn't a doc; Drive knows what it is.
async function whatIs(url: string): Promise<string | null> {
  const id = /\/documents\/([\w-]+)/.exec(url)?.[1];
  if (!id) return null;
  try {
    const f = await api<{name: string; mimeType: string}>("GET", `${DRIVE}/files/${id}?fields=name,mimeType&supportsAllDrives=true`);
    if (f.mimeType === "application/vnd.google-apps.document") return null;
    const kind = KINDS[f.mimeType] ?? (f.mimeType.startsWith("application/vnd.google-apps.") ? f.mimeType.split(".").pop() : `an uploaded ${f.mimeType} file`);
    const hint = f.mimeType.startsWith("application/vnd.google-apps.") ? "" : " Open it in Docs and use File > Save as Google Docs, then use the new doc.";
    return `"${f.name}" (${id}) is ${kind}, not a Google Doc.${hint}`;
  } catch {
    return null;
  }
}

// Turns Google's terse messages into ones that say what to do.
function explain(status: number, msg: string, url: string): string {
  const id = /\/documents\/([\w-]+)|\/files\/([\w-]+)/.exec(url);
  const doc = id ? `doc ${id[1] ?? id[2]}` : "that file";
  if (status === 401) return `Google rejected the sign-in (${msg}); run goog auth to set it up again`;
  if (status === 403 && /has not been used|is disabled/.test(msg)) return `${msg}\n(the API isn't enabled for the token's Cloud project)`;
  if (status === 403 && /insufficient|scope/i.test(msg) && url.includes("classroom.googleapis.com")) {
    return `the token can't read Classroom (${msg}); goog classroom needs the classroom.courses.readonly and classroom.coursework.me.readonly scopes, so sign in again with goog auth`;
  }
  if (status === 403 && /insufficient|scope/i.test(msg)) return `the token isn't allowed to do this (${msg}); run goog auth again with the drive scope`;
  if (status === 403) return `no permission for ${doc}: ${msg}. Check it's shared with the signed-in account (with edit access, to push).`;
  if (status === 404 && url.includes("classroom.googleapis.com")) return "that class or assignment wasn't found; check the link, or goog classroom classes for your classes";
  if (status === 404) return `${doc} wasn't found. Check the id, or that it's shared with the signed-in account.`;
  if (status === 400 && /not supported for this document/i.test(msg)) {
    return `${doc} isn't a Google Doc (maybe an uploaded .docx or PDF). Open it in Docs and use File > Save as Google Docs, then use the new doc.`;
  }
  if (status === 429) return `Google's rate limit is still hit after retrying for a while (${msg}); try again in a minute`;
  return msg;
}
