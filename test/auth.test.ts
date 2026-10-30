// The loopback sign-in and the Apps Script broker, offline: Google's side is
// played by the test.

import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "goog-auth-test-"));
process.env.GOOG_CACHE_DIR = join(tmp, "cache");
process.env.GOOG_CONFIG_DIR = join(tmp, "config");
delete process.env.GOOG_TOKEN; // it would stand in for every sign-in tested here
const {authStatus, BROKER_SOURCE, forgetToken, getToken, loginWithClient} = await import("../src/auth.ts");
const {saveConfig} = await import("../src/config.ts");

test("sign-in ignores replies without its state, and sends the PKCE verifier", {timeout: 10_000}, async () => {
  const realFetch = globalThis.fetch;
  let exchanged: URLSearchParams | undefined;
  let challenge: string | null = null;
  globalThis.fetch = (async (url: any, init?: any) => {
    if (String(url) !== "https://oauth2.googleapis.com/token") return realFetch(url, init);
    exchanged = init.body;
    return new Response(JSON.stringify({refresh_token: "r"}), {status: 200});
  }) as typeof fetch;
  try {
    await loginWithClient({client_id: "c", client_secret: "s"}, async (u) => {
      const q = new URL(u).searchParams;
      const back = q.get("redirect_uri")!;
      challenge = q.get("code_challenge");
      assert.equal(q.get("code_challenge_method"), "S256");
      // Someone else's code, without this sign-in's state: refused, and the sign-in keeps waiting.
      assert.equal((await realFetch(`${back}/?code=planted`)).status, 400);
      assert.equal((await realFetch(`${back}/?code=planted&state=guess`)).status, 400);
      const ok = await realFetch(`${back}/?code=real&state=${q.get("state")}`);
      assert.equal(ok.status, 200);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(exchanged!.get("code"), "real");
  // The verifier matches the challenge sent with the sign-in URL.
  assert.equal(createHash("sha256").update(exchanged!.get("code_verifier")!).digest("base64url"), challenge);
});

// Plays a broker that answers `reply(method)`, as seen after following
// redirects to `landed`, and returns the methods it was asked with.
async function withBroker(landed: string, reply: (method: string) => string, fn: () => Promise<unknown>): Promise<string[]> {
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  // Nothing listens here, so a fallback to Chrome fails with "no Chrome at".
  saveConfig({broker: BROKER, chrome: {endpoint: "http://127.0.0.1:1"}});
  forgetToken();
  try {
    globalThis.fetch = (async (url: any, init?: any) => {
      if (String(url).startsWith("https://oauth2.googleapis.com/tokeninfo")) return new Response(JSON.stringify({expires_in: "3000"}));
      if (String(url) !== BROKER) return realFetch(url, init);
      asked.push(init?.method ?? "GET");
      const r = new Response(reply(init?.method ?? "GET"));
      Object.defineProperty(r, "url", {value: landed});
      return r;
    }) as typeof fetch;
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return asked;
}

const BROKER = "https://script.google.com/macros/s/AKfycbSECRET/exec";
const echo = "https://script.googleusercontent.com/macros/echo?x";
const doGetText = "this is your goog sign-in link";

test("a broker deployed for Anyone hands out its token to a POST, without Chrome", async () => {
  let token;
  const asked = await withBroker(echo, (m) => (m === "POST" ? JSON.stringify({token: "ya29.t"}) : doGetText), async () => (token = await getToken()));
  assert.equal(token, "ya29.t");
  assert.deepEqual(asked, ["POST"]);
});

test("a broker from before doPost still hands out its token to a GET", async () => {
  let token;
  const asked = await withBroker(echo, (m) => (m === "POST" ? "<html>Script function not found: doPost</html>" : JSON.stringify({token: "ya29.old"})), async () => (token = await getToken()));
  assert.equal(token, "ya29.old");
  assert.deepEqual(asked, ["POST", "GET"]);
});

test("a broker deployed for Only myself is asked again through Chrome, after one request", async () => {
  // JSON on the sign-in page: only the redirect check can send this to Chrome.
  // With no Chrome, the error names the fix that needs none.
  for (const signIn of ["https://accounts.google.com/v3/signin/identifier", "https://login.microsoftonline.com/school/saml2"]) {
    const asked = await withBroker(signIn, () => JSON.stringify({token: "not-this"}), () =>
      assert.rejects(getToken(), /isn't deployed for Anyone: redeploy it with Who has access: Anyone/),
    );
    assert.deepEqual(asked, ["POST"]);
  }
});

test("a broker that answers with no token says so, without quoting its URL or going to Chrome", async () => {
  await withBroker(echo, () => "<html>Sorry, unable to open the file at this time.</html>", () =>
    assert.rejects(getToken(), (e: any) => /didn't return a token/.test(e.message) && !e.message.includes("SECRET") && !/Chrome/.test(e.message)),
  );
  await withBroker(echo, () => JSON.stringify({error: "Exception: no access"}), () => assert.rejects(getToken(), /returned an error: Exception: no access/));
});

test("a failed request's error quotes neither the URL nor a call log's cookies", async () => {
  // The shape of a Playwright error: the URL in the message, then every header.
  const leaky = `apiRequestContext.fetch: Timeout exceeded at ${BROKER} after https://script.googleusercontent.com/macros/echo?user_content_key=k\nCall log:\n  → POST ${BROKER}\n    cookie: SID=sessioncookie\n  ← 302\n    location: https://script.googleusercontent.com/macros/echo?user_content_key=k`;
  await withBroker(echo, () => {
    throw new Error(leaky);
  }, () => assert.rejects(getToken(), (e: any) => /Timeout exceeded/.test(e.message) && !/SECRET|sessioncookie|user_content_key/.test(e.message)));
});

test("the broker's URL stays out of goog auth status, and its token out of a plain visit", () => {
  saveConfig({broker: BROKER});
  assert.equal(authStatus(), "using the Apps Script broker");
  const doGet = BROKER_SOURCE.slice(0, BROKER_SOURCE.indexOf("function doPost"));
  assert.match(doGet, /function doGet/);
  assert.doesNotMatch(doGet, /getOAuthToken/);
});

test("not signed in, the error tells the agent to run goog auth script", async () => {
  saveConfig({});
  forgetToken();
  await assert.rejects(getToken(), /Run `goog auth script` and show the user the steps/);
});
