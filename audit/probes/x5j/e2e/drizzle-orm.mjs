#!/usr/bin/env bun
// X5J e2e: npm install drizzle-orm should succeed (regression fix).
// drizzle-orm declares sql.js as an optional peer; pre-X5J, R2.5
// auto-enqueues sql.js, hits W6 REJECT_INSTALL, kills the install.
// Post-X5J, sql.js is soft-skipped at the R2.5 enqueue site.

import { runOnePkg } from './_x5j-driver.mjs';

const r = await runOnePkg({
  name: 'drizzle-orm',
  pkg:  'drizzle-orm',
  smoke: `const m = require('drizzle-orm'); console.log('keys:', Object.keys(m).slice(0,8));`,
  expectations: {
    success: 'keys:.*\\[',
  },
});

process.exit(r.ok ? 0 : 1);
