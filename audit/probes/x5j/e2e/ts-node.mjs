#!/usr/bin/env bun
// X5J e2e: npm install ts-node should succeed (regression fix).
// ts-node declares @swc/core as an optional peer (for --swc mode);
// pre-X5J, R2.5 auto-enqueues @swc/core, hits W6 REJECT_INSTALL,
// kills the install. Post-X5J, @swc/core is soft-skipped at R2.5
// enqueue.

import { runOnePkg } from './_x5j-driver.mjs';

const r = await runOnePkg({
  name: 'ts-node',
  pkg:  'ts-node',
  smoke: `const m = require('ts-node'); console.log('typeof:', typeof m);`,
  expectations: {
    success: 'typeof:\\s*(object|function)',
  },
});

process.exit(r.ok ? 0 : 1);
