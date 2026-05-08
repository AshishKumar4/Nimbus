// X.5-C functional probe — Fix #1's IMPORT_RE doesn't infinite-loop on
// mutual ESM imports.
//
// File A imports B; file B imports A. The walker should:
//   1. Visit A.
//   2. From A, follow `import './B'` to B.
//   3. From B, attempt to follow `import './A'` to A — find A in `visited`
//      set, no-op.
//   4. Walker terminates.
//
// Pre-fix: PASS (vacuously — REQUIRE_RE doesn't match `import './A'` either).
// Post-fix: PASS — `visited` set guard works for both regex passes.
//
// Asserts walker terminates AND both files are in the bundle.

import { makeVfs, check, summary, reset } from '../_helpers.mjs';
import { prefetchForRequire } from '../../../../src/runtime/require-resolver.ts';

reset();

console.log('X.5-C functional/f3-cycle-safe — mutual ESM imports terminate cleanly');

const vfs = makeVfs({
  'home/user/app/package.json': JSON.stringify({ name: 'app' }),
  'home/user/app/node_modules/cycle-pkg/package.json': JSON.stringify({
    name: 'cycle-pkg', version: '1.0.0', main: 'index.js', module: 'index.js',
  }),
  'home/user/app/node_modules/cycle-pkg/index.js':
    "import { b } from './b';\nexport const a = 1;\nexport { b };\n",
  'home/user/app/node_modules/cycle-pkg/b.js':
    "import { a } from './index';\nexport const b = a + 1;\nimport { c } from './c';\nexport { c };\n",
  'home/user/app/node_modules/cycle-pkg/c.js':
    "import { a } from './index';\nimport { b } from './b';\nexport const c = a + b;\n",
});

const entryCode = "const m = require('cycle-pkg');\n";

// Set a hard timeout — if Fix #1's regex causes an infinite loop, the
// process would hang. We rely on the fact that prefetchForRequire is
// synchronous so a poorly-bounded regex would surface as a hang here.
const t0 = Date.now();
const result = prefetchForRequire(vfs, entryCode, '/home/user/app');
const elapsed = Date.now() - t0;

check(
  'walker terminates in <500ms (no infinite loop)',
  elapsed < 500,
  `elapsed=${elapsed}ms`,
);

check(
  'cycle-pkg/index.js in bundle',
  ('home/user/app/node_modules/cycle-pkg/index.js') in result.bundle,
  null,
);

check(
  'cycle-pkg/b.js in bundle (cycle peer)',
  ('home/user/app/node_modules/cycle-pkg/b.js') in result.bundle,
  null,
);

check(
  'cycle-pkg/c.js in bundle (third file in mutual import graph)',
  ('home/user/app/node_modules/cycle-pkg/c.js') in result.bundle,
  null,
);

check(
  'no truncation on small mutual-import graph',
  result.truncated === false,
  `truncated=${result.truncated}`,
);

const ok = summary();
process.exit(ok ? 0 : 1);
