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
const {forgetToken, getToken, loginWithClient} = await import("../src/auth.ts");
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
// redirects to `landed`.
async function withBroker<T>(landed: string, reply: (method: string) => string, fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/tokeninfo")) return new Response(JSON.stringify({expires_in: "3000"}));
    if (String(url) !== "https://script.google.com/macros/s/x/exec") return realFetch(url, init);
    const r = new Response(reply(init?.method ?? "GET"));
    Object.defineProperty(r, "url", {value: landed});
    return r;
  }) as typeof fetch;
  // Nothing listens here, so a fallback to Chrome fails with "no Chrome at".
  saveConfig({broker: "https://script.google.com/macros/s/x/exec", chrome: {endpoint: "http://127.0.0.1:1"}});
  forgetToken();
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const echo = "https://script.googleusercontent.com/macros/echo?x";

test("a broker deployed for Anyone hands out its token to a POST, without Chrome", async () => {
  // A visit (GET) only gets the doGet text, so a crawler or link preview never sees a token.
  const token = await withBroker(echo, (m) => (m === "POST" ? JSON.stringify({token: "ya29.t"}) : "This is your goog sign-in link."), getToken);
  assert.equal(token, "ya29.t");
});

test("a broker from before doPost still hands out its token to a GET", async () => {
  const token = await withBroker(echo, (m) => (m === "POST" ? "<html>Script function not found: doPost</html>" : JSON.stringify({token: "ya29.old"})), getToken);
  assert.equal(token, "ya29.old");
});

test("a broker deployed for Only myself is asked again through Chrome", async () => {
  await assert.rejects(withBroker("https://accounts.google.com/v3/signin/identifier", () => "<html>", getToken), /no Chrome at/);
});
