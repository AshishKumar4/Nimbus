#!/usr/bin/env node
/**
 * bin/create-nimbus-app — `npx create-nimbus-app <project-name>`.
 *
 * Thin wrapper around `scaffold()` in commands/scaffold.ts. Exists as a
 * separate bin so `npm init nimbus-app` / `npx create-nimbus-app` works
 * without verb routing.
 */

import { scaffold } from './commands/scaffold.js';

scaffold(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`create-nimbus-app: ${err?.stack || err}\n`);
    process.exit(70);
  },
);
