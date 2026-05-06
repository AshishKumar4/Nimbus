#!/usr/bin/env bun
// X5G e2e: npm install rollup → swap to @rollup/wasm-node →
// require('rollup') succeeds.

import { runOnePkg } from './_x5g-driver.mjs';

const r = await runOnePkg({
  name: 'rollup',
  pkg:  'rollup',
  smoke: `const m = require('rollup'); console.log('keys:', Object.keys(m).slice(0,8));`,
  expectations: {
    // Either rollup or @rollup/wasm-node exports rollup, parseAst, etc.
    success: 'keys:.+rollup',
  },
});

process.exit(r.verdict.startsWith('✅') ? 0 : 1);
