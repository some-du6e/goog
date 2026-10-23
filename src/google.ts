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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt: number, retryAfter: string | null, status: number): number {
  const s = Number(retryAfter);
  if (retryAfter && Number.isFinite(s)) return Math.min(s * 1000, 65_000);
  const base = status === 429 ? 4000 : 1000; // quota windows are a minute long
  return Math.min(base * 2 ** attempt, 32_000) * (0.75 + Math.random() * 0.5);
}

// opts.text returns the body as a string, opts.bytes as {type, data}.
export async function api<T = any>(method: string, url: string, body?: unknown, opts: {text?: boolean; bytes?: boolean} = {}): Promise<T> {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await getToken();
    let r: Response;
    try {
      r = await fetch(url, {
        method,
        headers: {Authorization: `Bearer ${token}`, ...(body === undefined ? {} : {"Content-Type": "application/json"})},
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e: any) {
      const why = e?.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000}s` : (e?.cause?.code ?? e?.cause?.message ?? e?.message);
      // A write that timed out may have landed; don't send it twice.
      if (attempt < 3 && (method === "GET" || e?.name !== "TimeoutError")) {
        const delayMs = 1000 * 2 ** attempt;
        onRetry?.({status: 0, message: `can't reach Google (${why})`, delayMs, attempt});
        await sleep(delayMs);
        continue;
      }
      throw new ApiError(0, `can't reach Google (${why}); check the network connection`);
    }
    if (r.ok) {
      if (r.status === 204) return null as T;
      if (opts.bytes) return {type: r.headers.get("content-type") ?? "", data: Buffer.from(await r.arrayBuffer())} as T;
      return (opts.text ? await r.text() : await r.json()) as T;
    }
    const j: any = await r.json().catch(() => ({}));
    const msg: string = j.error?.message ?? r.statusText;
    const reason: string | undefined = j.error?.errors?.[0]?.reason ?? j.error?.details?.find((d: any) => d.reason)?.reason;
    if (r.status === 401 && !refreshed) {
      refreshed = true;
      forgetToken();
      continue;
    }
    if ((r.status === 429 || r.status >= 500 || /rate ?limit/i.test(reason ?? "")) && attempt < MAX_ATTEMPTS - 1) {
      const delayMs = backoff(attempt, r.headers.get("retry-after"), r.status);
      onRetry?.({status: r.status, message: r.status === 429 ? "Google rate limit" : `Google error ${r.status}: ${msg}`, delayMs, attempt});
      await sleep(delayMs);
      continue;
    }
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
  if (status === 403 && /insufficient|scope/i.test(msg)) return `the token isn't allowed to do this (${msg}); run goog auth again with the drive scope`;
  if (status === 403) return `no permission for ${doc}: ${msg}. Check it's shared with the signed-in account (with edit access, to push).`;
  if (status === 404) return `${doc} wasn't found. Check the id, or that it's shared with the signed-in account.`;
  if (status === 400 && /not supported for this document/i.test(msg)) {
    return `${doc} isn't a Google Doc (maybe an uploaded .docx or PDF). Open it in Docs and use File > Save as Google Docs, then use the new doc.`;
  }
  if (status === 429) return `Google's rate limit is still hit after retrying for a while (${msg}); try again in a minute`;
  return msg;
}
