#!/usr/bin/env node
/**
 * bin/create-nimbus-app — scaffolder entry.
 *
 * Thin wrapper around `scaffold()` in commands/scaffold.ts. Exists as a
 * separate bin so the eventual npm artifact can support
 * `create-nimbus-app` without verb routing.
 */

import { scaffold } from './commands/scaffold.js';

scaffold(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`create-nimbus-app: ${err?.stack || err}\n`);
    process.exit(70);
  },
);
