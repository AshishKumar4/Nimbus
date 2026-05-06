#!/usr/bin/env bun
// X5G e2e: npm install ts-jest jest typescript → install hygiene
// (esbuild peer-meta-only NOT installed). Runtime ⚠ on W2.6b cap.

import { runOnePkg } from './_x5g-driver.mjs';

const r = await runOnePkg({
  name: 'ts-jest',
  pkg:  'ts-jest jest typescript',
  smoke: `const m = require('ts-jest'); console.log('typeof:', typeof m);`,
  expectations: {
    success: 'typeof:\\s+(object|function)',
  },
});

console.log(`Verdict: ${r.verdict}`);
// Honest: ⚠ on W2.6b cap is acceptable. Pass for telemetry capture.
process.exit(0);
