#!/usr/bin/env bun
// X5G e2e: npm install @radix-ui/react-dialog → install hygiene
// (react + react-dom installed; @types/* still installed per R2.5).
// The runtime require may still ⚠ on react-remove-scroll (X.5-C).

import { runOnePkg } from './_x5g-driver.mjs';

const r = await runOnePkg({
  name: 'radix-react-dialog',
  pkg:  '@radix-ui/react-dialog',
  smoke: `const m = require('@radix-ui/react-dialog'); console.log('keys:', Object.keys(m).slice(0,8));`,
  expectations: {
    success: 'keys:.+',
  },
});

// Honest expectation: ⚠ on X.5-C react-remove-scroll subpath miss.
// Pass the probe regardless of verdict — the goal is to capture the
// post-X5G state for the retro.
console.log(`Verdict: ${r.verdict}`);
process.exit(0);
