// Finds an OAuth access token for Google's APIs. In order:
//  1. $GOOG_TOKEN
//  2. a refresh token from `goog auth client` (your own Google Cloud OAuth client)
//  3. an Apps Script web app you own (`goog auth script`), called through the
//     signed-in Chrome so it runs as you. No Cloud project needed.

import {createHash, randomBytes} from "node:crypto";
import {createServer} from "node:http";
import {join} from "node:path";
import {withBrowser} from "./browser.ts";
import {CACHE_DIR, CONFIG_DIR, loadConfig, readJson, writeJson} from "./config.ts";

export const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

const tokenCache = join(CACHE_DIR, "token.json");
const refreshPath = join(CONFIG_DIR, "oauth.json");

interface Cached {
  token: string;
  expires: number;
  source: string;
}

let memo: Cached | null = null;

export function forgetToken() {
  memo = null;
  writeJson(tokenCache, {});
}

export async function getToken(): Promise<string> {
  if (process.env.GOOG_TOKEN) return process.env.GOOG_TOKEN;
  memo ??= readJson<Cached | null>(tokenCache, null);
  if (memo?.token && memo.expires > Date.now() + 60_000) return memo.token;
  const fresh = await fetchToken();
  memo = fresh;
  writeJson(tokenCache, fresh);
  return fresh.token;
}

async function fetchToken(): Promise<Cached> {
  const cfg = loadConfig();
  const saved = readJson<{refresh_token?: string} | null>(refreshPath, null);
  if (cfg.client && saved?.refresh_token) {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: cfg.client.client_id,
        client_secret: cfg.client.client_secret,
        refresh_token: saved.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    const j: any = await r.json();
    if (!r.ok) throw new Error(`refreshing the OAuth token failed: ${j.error_description ?? j.error}; run goog auth client again`);
    return {token: j.access_token, expires: Date.now() + j.expires_in * 1000, source: "client"};
  }
  if (cfg.broker) {
    const j: any = await withBrowser(async (ctx) => {
      const r = await ctx.request.get(cfg.broker!, {timeout: 30000});
      const text = await r.text();
      if (r.url().includes("accounts.google.com")) throw new Error("Chrome isn't signed in to Google; sign in there first");
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`the Apps Script broker didn't return a token (HTTP ${r.status()}); open ${cfg.broker} in Chrome to check it`);
      }
    });
    if (!j.token) throw new Error(`the Apps Script broker returned an error: ${j.error ?? JSON.stringify(j)}`);
    return {token: j.token, expires: Date.now() + (await lifetime(j.token)), source: "script"};
  }
  throw new Error("goog isn't signed in to Google. Run `goog auth` to set it up.");
}

// Apps Script hands out its cached token, which may be most of the way to
// expiring, so ask Google how long it really has left.
async function lifetime(token: string): Promise<number> {
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`, {signal: AbortSignal.timeout(10_000)});
    const j: any = await r.json();
    const s = Number(j.expires_in);
    if (r.ok && s > 0) return s * 1000;
  } catch {}
  return 30 * 60_000;
}

export function authStatus(): string {
  const cfg = loadConfig();
  const saved = readJson<{refresh_token?: string} | null>(refreshPath, null);
  if (process.env.GOOG_TOKEN) return "using $GOOG_TOKEN";
  if (cfg.client && saved?.refresh_token) return `using your OAuth client ${cfg.client.client_id.split("-")[0]}…`;
  if (cfg.broker) return `using the Apps Script broker through Chrome (${cfg.broker.slice(0, 60)}…)`;
  return "not set up";
}

// Reuses a refresh token another tool already got, e.g. a google-auth
// "authorized_user" token.json ({client_id, client_secret, refresh_token}).
// Its scopes need to include drive or documents/presentations.
export function importAuthorizedUser(j: any): {client_id: string; client_secret: string} {
  if (!j.client_id || !j.client_secret || !j.refresh_token) {
    throw new Error("that file has no client_id, client_secret, and refresh_token; expected an authorized_user token.json");
  }
  writeJson(refreshPath, {refresh_token: j.refresh_token});
  forgetToken();
  return {client_id: j.client_id, client_secret: j.client_secret};
}

// Loopback OAuth flow for an installed-app client.
export async function loginWithClient(client: {client_id: string; client_secret: string}, open: (url: string) => Promise<void>) {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const redirect = `http://127.0.0.1:${port}`;
  // state ties the reply to this sign-in, and PKCE makes a code that leaks
  // useless to anyone else (RFC 8252).
  const state = randomBytes(16).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const q = new URL(req.url ?? "/", redirect).searchParams;
      if (q.get("state") !== state) {
        res.statusCode = 400;
        return res.end("Not a reply to this goog sign-in.");
      }
      res.end(q.get("code") ? "goog is signed in. You can close this tab." : `Sign-in failed: ${q.get("error")}`);
      if (q.get("code")) resolve(q.get("code")!);
      else reject(new Error(`Google sign-in failed: ${q.get("error")}`));
    });
    open(url).catch(reject);
  });
  server.close();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({...client, code, code_verifier: verifier, redirect_uri: redirect, grant_type: "authorization_code"}),
  });
  const j: any = await r.json();
  if (!r.ok || !j.refresh_token) throw new Error(`token exchange failed: ${j.error_description ?? j.error ?? "no refresh token"}`);
  writeJson(refreshPath, {refresh_token: j.refresh_token});
  forgetToken();
}

// The Apps Script that `goog auth script` asks you to deploy.
// Scopes come from the manifest; the advanced services there switch on the
// Docs, Slides, Sheets and Drive APIs for the script's Cloud project, which the
// token needs.
export const BROKER_SOURCE = `function doGet() {
  return ContentService.createTextOutput(JSON.stringify({token: ScriptApp.getOAuthToken()}))
    .setMimeType(ContentService.MimeType.JSON);
}`;

export const BROKER_MANIFEST = {
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  exceptionLogging: "STACKDRIVER",
  runtimeVersion: "V8",
  oauthScopes: [...SCOPES, "https://www.googleapis.com/auth/script.external_request"],
  webapp: {executeAs: "USER_DEPLOYING", access: "MYSELF"},
  dependencies: {
    enabledAdvancedServices: [
      {userSymbol: "Docs", serviceId: "docs", version: "v1"},
      {userSymbol: "Slides", serviceId: "slides", version: "v1"},
      {userSymbol: "Sheets", serviceId: "sheets", version: "v4"},
      {userSymbol: "Drive", serviceId: "drive", version: "v3"},
    ],
  },
};
