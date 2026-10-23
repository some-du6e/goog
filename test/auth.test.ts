// The loopback sign-in, offline: Google's side is played by the test.

import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "goog-auth-test-"));
process.env.GOOG_CACHE_DIR = join(tmp, "cache");
process.env.GOOG_CONFIG_DIR = join(tmp, "config");
const {loginWithClient} = await import("../src/auth.ts");

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
