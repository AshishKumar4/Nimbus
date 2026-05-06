#!/usr/bin/env bun
// X5G e2e: npm install nuxt → install hygiene (no @parcel/watcher
// platform shards). Runtime ⚠ on X.5-C pathe split-bundle.

import { runOnePkg } from './_x5g-driver.mjs';

const r = await runOnePkg({
  name: 'nuxt',
  pkg:  'nuxt',
  smoke: `const m = require('nuxt'); console.log('typeof:', typeof m);`,
  expectations: {
    success: 'typeof:\\s+(object|function)',
  },
});

console.log(`Verdict: ${r.verdict}`);
process.exit(0);
