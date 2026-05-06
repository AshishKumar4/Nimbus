#!/usr/bin/env bun
// X5J e2e regression: framer-motion (which X.5-F R2.5 originally
// fixed) MUST still ✅. framer-motion's optional peers (react,
// react-dom) are NOT in REJECT_INSTALL, so the X.5-J carve-out should
// not affect them.

import { runOnePkg } from './_x5j-driver.mjs';

const r = await runOnePkg({
  name: 'framer-motion',
  pkg:  'framer-motion',
  smoke: `const m = require('framer-motion'); console.log('keys:', Object.keys(m).slice(0,8));`,
  expectations: {
    success: 'keys:.*\\[.*motion',
  },
});

process.exit(r.ok ? 0 : 1);
