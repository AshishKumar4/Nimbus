#!/usr/bin/env node
import { scaffold } from '@nimbus-sh/cli';

scaffold(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`create-nimbus-app: ${err?.stack || err}\n`);
    process.exit(70);
  },
);
