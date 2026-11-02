#!/bin/sh
# Checks the installed npm package (npm install -g ./goog-cli-*.tgz first):
# what runs differently from a checkout, since Node won't run .ts files
# under node_modules.
set -eu
pkg="$(npm root -g)/goog-cli"
goog help | grep -q 'goog edit'
GOOG_BIN="$pkg/dist/bin/goog.js" node --test test/cli.test.ts
# The detached `goog draw` and the lazily imported browser driver.
node --input-type=module -e 'const {BIN} = await import(process.argv[1]); (await import("node:fs")).statSync(BIN)' "$pkg/dist/src/slides.js"
(cd "$pkg" && node --input-type=module -e 'await import("playwright-core")')
