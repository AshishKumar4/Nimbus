#!/usr/bin/env bun
// X5J e2e regression: parcel STILL ⛔ at @swc/core. parcel has @swc/core
// as a TRANSITIVE required dependency (not as an optional peer of
// parcel itself), so the reject still fires from the dependencies
// walk path — which X.5-J does NOT touch. This probe asserts the
// loud-reject contract is preserved for the dep-walk path.

import { runOnePkg } from './_x5j-driver.mjs';

const r = await runOnePkg({
  name: 'parcel',
  pkg:  'parcel',
  smoke: `const m = require('parcel'); console.log('typeof:', typeof m);`,
  expectations: {
    expectReject: true,  // We EXPECT a loud reject — that's the regression-pass condition.
  },
});

process.exit(r.ok ? 0 : 1);
