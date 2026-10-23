// Attaches to the user's signed-in Chrome over CDP, starting it if needed.

import {spawn} from "node:child_process";
import type {Browser, BrowserContext} from "playwright-core";
import {loadConfig} from "./config.ts";

const DEFAULT_ENDPOINT = "http://127.0.0.1:9223";

async function reachable(endpoint: string): Promise<boolean> {
  try {
    const r = await fetch(`${endpoint}/json/version`, {signal: AbortSignal.timeout(1500)});
    return r.ok;
  } catch {
    return false;
  }
}

export async function withBrowser<T>(fn: (ctx: BrowserContext) => Promise<T>): Promise<T> {
  const cfg = loadConfig().chrome ?? {};
  const endpoint = cfg.endpoint ?? DEFAULT_ENDPOINT;
  if (!(await reachable(endpoint))) {
    if (!cfg.launch?.length) {
      throw new Error(`no Chrome at ${endpoint}; start your signed-in Chrome with --remote-debugging-port, or set chrome.launch in the goog config`);
    }
    const [cmd, ...args] = cfg.launch;
    spawn(cmd, args, {detached: true, stdio: "ignore"}).unref();
    const deadline = Date.now() + 20000;
    while (!(await reachable(endpoint))) {
      if (Date.now() > deadline) throw new Error(`started ${cmd} but nothing answered at ${endpoint}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  // Loaded only when needed: it takes most of a second, and most commands never need Chrome.
  const {chromium} = await import("playwright-core");
  const browser: Browser = await chromium.connectOverCDP(endpoint);
  try {
    return await fn(browser.contexts()[0]);
  } finally {
    // Disconnects without closing the user's browser.
    await browser.close();
  }
}
