#!/usr/bin/env bun
// X5M e2e M-3: vite install + require.
//
// Pre-fix expected: ⚠ "Invalid URL string."
// Charter-pass criterion (Stage A done; Stage B = X.5-O backlog):
//   - The "Invalid URL string." error is GONE (vite progresses past the
//     URL constructor throw)
//   - vite may still error deeper with `Cannot find module 'file:...'` or
//     `ENOENT 'file:...'` — that's the fs-URL composition gap (out of M-3
//     charter, owned by X.5-O).
// Full-success criterion: ✅ "keys: createServer,defineConfig,..." — bonus.
//
// We accept either '✅ success' OR '⚠ charter-pass' (Invalid URL string gone)
// as a passing outcome. The probe emits 'charter-pass' when:
//   - 'Invalid URL string' is NOT in the post-install output AND
//   - require('vite') still failed with a different message (ENOENT etc.)

import { runOnePkg } from './_x5m-driver.mjs';

const r = await runOnePkg({
  name: 'vite',
  pkg: 'vite',
  smoke: `const m=require('vite');console.log('keys:', Object.keys(m).slice(0,8).join(','));`,
  expectations: {
    success: 'keys:\\s*[a-zA-Z]',
    // M-3 honest-fail charter pass: "Invalid URL string" is GONE, replaced
    // by a deeper failure that's NOT the URL constructor.
    charterPass: '(?:ENOENT|file:\\/\\/|Cannot find module \'file:|Cannot read properties|some-other-deeper-error)',
  },
  retries: 3,  // chunks/node.js install non-determinism
});

console.log('FINAL_VERDICT:', r.verdict);
// Stage A done ⇔ either ✅ or ⚠ charter-pass
if (r.verdict.startsWith('✅') || r.verdict.startsWith('⚠ charter-pass')) {
  process.exit(0);
}
process.exit(1);
