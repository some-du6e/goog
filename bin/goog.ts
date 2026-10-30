#!/usr/bin/env node
import {hideBrokerUrls} from "../src/auth.ts";
import {main} from "../src/cli.ts";

// Output piped into `head` and the like: once the reader is gone, stop quietly.
process.stdout.on("error", (e: any) => {
  if (e?.code === "EPIPE") process.exit(0);
  throw e;
});

main(process.argv.slice(2)).catch((e) => {
  const msg = hideBrokerUrls(e?.message ?? String(e));
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify({ok: false, error: msg, line: e?.line}) + "\n");
  console.error(`goog: ${msg}`);
  process.exit(1);
});
