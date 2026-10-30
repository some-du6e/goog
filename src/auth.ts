// Finds an OAuth access token for Google's APIs. In order:
//  1. $GOOG_TOKEN
//  2. a refresh token from `goog auth client` (your own Google Cloud OAuth client)
//  3. an Apps Script web app you own (`goog auth script`). No Cloud project
//     needed. Deployed for "Anyone", a plain fetch gets the token; deployed
//     for "Only myself", it goes through the signed-in Chrome.

import {createHash, randomBytes} from "node:crypto";
import {rmSync} from "node:fs";
import {createServer} from "node:http";
import {join} from "node:path";
import {withBrowser} from "./browser.ts";
import {CACHE_DIR, CONFIG_DIR, loadConfig, readJson, writeJson} from "./config.ts";

// Everything goog might use, asked for up front: a broker's scopes are fixed
// when it's deployed, so adding one later would mean every user redeploying.
export const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
  // Gmail: read, draft, send and label mail (not delete it for good).
  "https://www.googleapis.com/auth/gmail.modify",
  // Forms: only reaches the API from goog auth client or an imported token.
  // Apps Script has no Forms advanced service, so a broker's token gets 403.
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/forms.responses.readonly",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/drive.activity.readonly",
  "https://www.googleapis.com/auth/chat.spaces",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.memberships",
  // Every Classroom scope in Classroom's discovery doc.
  "https://www.googleapis.com/auth/classroom.addons.student",
  "https://www.googleapis.com/auth/classroom.addons.teacher",
  "https://www.googleapis.com/auth/classroom.announcements",
  "https://www.googleapis.com/auth/classroom.announcements.readonly",
  "https://www.googleapis.com/auth/classroom.courses",
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.students",
  "https://www.googleapis.com/auth/classroom.coursework.students.readonly",
  "https://www.googleapis.com/auth/classroom.courseworkmaterials",
  "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
  "https://www.googleapis.com/auth/classroom.guardianlinks.me.readonly",
  "https://www.googleapis.com/auth/classroom.guardianlinks.students",
  "https://www.googleapis.com/auth/classroom.guardianlinks.students.readonly",
  "https://www.googleapis.com/auth/classroom.profile.emails",
  "https://www.googleapis.com/auth/classroom.profile.photos",
  "https://www.googleapis.com/auth/classroom.push-notifications",
  "https://www.googleapis.com/auth/classroom.rosters",
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
  "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly",
  "https://www.googleapis.com/auth/classroom.student-submissions.students.readonly",
  "https://www.googleapis.com/auth/classroom.topics",
  "https://www.googleapis.com/auth/classroom.topics.readonly",
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
    const url = cfg.broker;
    const j: any = await hidingUrl(async () => {
      const plain = await askBroker(async (method) => {
        try {
          const r = await fetch(url, {method, signal: AbortSignal.timeout(30_000)});
          return {url: r.url, status: r.status, text: await r.text()};
        } catch (e: any) {
          throw new Error(`couldn't reach the Apps Script broker: ${e.cause?.code ?? e.message}`);
        }
      });
      if ("reply" in plain) return plain.reply;
      const sentAway = `the Apps Script broker sent goog to ${plain.left}, a sign-in page or a network filter's block page`;
      return withBrowser(async (ctx) => {
        const viaChrome = await askBroker(async (method) => {
          const r = await ctx.request.fetch(url, {method, timeout: 30_000});
          return {url: r.url(), status: r.status(), text: await r.text()};
        }).catch((e) => {
          // Chrome may open it as its first signed-in account, which may not own it.
          const account = /\(HTTP 40[34]\)/.test(e.message) ? ". If Chrome is signed in to several Google accounts, the one that deployed it may need to be the first" : "";
          throw new Error(`${sentAway}, so goog asked through Chrome, and there ${e.message.replace(/^the Apps Script broker /, "it ")}${account}`);
        });
        if ("reply" in viaChrome) return viaChrome.reply;
        throw new Error(`${sentAway}, and Chrome was sent to ${viaChrome.left} too: sign in to Google there, or a network filter is blocking Apps Script`);
      }).catch((e) => {
        if (!/^(no Chrome at|started .* but nothing answered)/.test(e.message)) throw e;
        throw new Error(`${sentAway}. A sign-in means the web app isn't deployed for Anyone: redeploy it for Anyone if your account offers that, or goog needs your signed-in Chrome (${e.message})`);
      });
    });
    // Only the field names: a reply without `token` may still hold one.
    if (!j.token) throw new Error(`the Apps Script broker returned an error: ${typeof j.error === "string" ? j.error : `no token (fields: ${Object.keys(j ?? {}).join(", ") || "none"})`}`);
    return {token: j.token, expires: Date.now() + (await lifetime(j.token)), source: "script"};
  }
  throw new Error("goog isn't signed in to Google. Run `goog auth script` and show the user the steps it prints.");
}

// Asks a broker for its token, one request at a time through `send`. POST
// first (see BROKER_SOURCE); brokers deployed before doPost only answer GET.
// Being sent off Google's script hosts to accounts.google.com, or off Google
// altogether (a school's sign-in, or a network filter), gives `left`: the host
// it went to. A broker not deployed for Anyone answers only through the
// signed-in Chrome.
async function askBroker(send: (method: string) => Promise<{url: string; status: number; text: string}>): Promise<{reply: any} | {left: string}> {
  const answers: {status: number; path: string}[] = [];
  for (const method of ["POST", "GET"]) {
    const r = await send(method);
    const at = new URL(r.url);
    if (at.hostname === "accounts.google.com" || !/(^|\.)google(usercontent)?\.com$/.test(at.hostname)) return {left: at.hostname};
    const reply = json(r.text);
    if (reply) return {reply};
    answers.push({status: r.status, path: at.pathname});
  }
  // Said from what Google answered to either request, not guessed.
  const any = (is: (a: {status: number; path: string}) => boolean) => answers.find(is);
  const limited = any((a) => a.status === 429 || a.path.startsWith("/sorry"));
  const down = any((a) => a.status >= 500);
  const last = answers[answers.length - 1];
  const [status, why] =
    limited ? [limited.status, "Google is rate-limiting this network; try again later"]
    : down ? [down.status, "Google answered with a server error; try again later"]
    : last.status === 404 ? [404, "there's no such deployment: it was archived or deleted, or the URL is mistyped"]
    : last.status === 403 ? [403, "Google refused access to the script; open it as its owner and deploy it again"]
    : [last.status, "the script answered with an error page; it may need authorizing again (open it, Deploy → New deployment)"];
  throw new Error(`the Apps Script broker didn't return a token (HTTP ${status}): ${why}`);
}

// The broker URL works like a password, so errors never quote it. Playwright's
// errors end with a call log of every header, cookies and redirects included,
// so that goes too.
async function hidingUrl<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    throw new Error(hideBrokerUrls(String(e?.message ?? e).split(/\n\s*Call log:/)[0]));
  }
}

// Also run on every error goog prints, for a URL pasted into the wrong command,
// with or without its scheme. Only real deployment paths (…/macros/…), so a
// hint like "https://script.google.com/…/exec" survives.
export const hideBrokerUrls = (msg: string) =>
  msg.replace(/(https?:\/\/)?script\.google(usercontent)?\.com\/([^\s'"]*\/)?macros\/[^\s'"]*/g, "<broker URL>");

function json(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
  if (cfg.broker) return "using the Apps Script broker";
  return "not set up";
}

// Reuses a refresh token another tool already got, e.g. a google-auth
// "authorized_user" token.json ({client_id, client_secret, refresh_token}).
// Its scopes need to include drive: goog finds files and their kind through
// Drive, and drive covers the Docs and Slides APIs too.
export function importAuthorizedUser(j: any): {client_id: string; client_secret: string} {
  if (!j?.client_id || !j.client_secret || !j.refresh_token) {
    throw new Error("that file has no client_id, client_secret, and refresh_token; expected an authorized_user token.json");
  }
  writeJson(refreshPath, {refresh_token: j.refresh_token});
  forgetToken();
  return {client_id: j.client_id, client_secret: j.client_secret};
}

// Returns a function that puts back the refresh token saved now (or its
// absence), for undoing a sign-in that doesn't work.
export function keepSignIn(): () => void {
  const saved = readJson<unknown>(refreshPath, null);
  return () => {
    if (saved) writeJson(refreshPath, saved);
    else rmSync(refreshPath, {force: true});
    forgetToken();
  };
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

// A Sheet whose bound script is BROKER_SOURCE with BROKER_MANIFEST (time zone
// UTC), owned by a public account so copying it shows no one's personal
// email. Apps Script projects have no /copy link and Sheets do, and copying
// the Sheet copies its script. The text fragment highlights the button.
export const BROKER_TEMPLATE = "https://docs.google.com/spreadsheets/d/1HCVN1eXlLpQoiQE9KkpwH-uZdzoAKdKJlpUGWh_O5JY/copy#:~:text=goog%20setup%3F-,Make%20a%20copy,-View%20Apps%20Script";

// The Apps Script that `goog auth script` asks you to deploy.
// Scopes come from the manifest; the advanced services there switch on the
// APIs goog's token may call (Docs, Slides, Drive, Classroom, Gmail, Chat and
// the rest) for the script's Cloud project, which the token needs.
// The token is only in POST replies. A browser, crawler or link preview opening
// the URL gets the doGet text, and Google does index script.googleusercontent.com.
export const BROKER_SOURCE = `function doGet() {
  return ContentService.createTextOutput("this is your goog sign-in link. send it to your agent and keep it private, it works like a password");
}

function doPost() {
  return ContentService.createTextOutput(JSON.stringify({token: ScriptApp.getOAuthToken()}))
    .setMimeType(ContentService.MimeType.JSON);
}`;

export const BROKER_MANIFEST = {
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  exceptionLogging: "STACKDRIVER",
  runtimeVersion: "V8",
  oauthScopes: SCOPES,
  webapp: {executeAs: "USER_DEPLOYING", access: "ANYONE_ANONYMOUS"},
  dependencies: {
    enabledAdvancedServices: [
      {userSymbol: "Docs", serviceId: "docs", version: "v1"},
      {userSymbol: "Slides", serviceId: "slides", version: "v1"},
      {userSymbol: "Sheets", serviceId: "sheets", version: "v4"},
      {userSymbol: "Drive", serviceId: "drive", version: "v3"},
      {userSymbol: "Classroom", serviceId: "classroom", version: "v1"},
      {userSymbol: "Gmail", serviceId: "gmail", version: "v1"},
      {userSymbol: "Calendar", serviceId: "calendar", version: "v3"},
      {userSymbol: "Tasks", serviceId: "tasks", version: "v1"},
      {userSymbol: "People", serviceId: "peopleapi", version: "v1"},
      {userSymbol: "YouTube", serviceId: "youtube", version: "v3"},
      {userSymbol: "YouTubeAnalytics", serviceId: "youtubeAnalytics", version: "v2"},
      {userSymbol: "DriveActivity", serviceId: "driveactivity", version: "v2"},
      {userSymbol: "Chat", serviceId: "chat", version: "v1"},
    ],
  },
};
