// X.5-C regression probe — W3.5 fixes still green after X.5-C lands.
//
// W3.5 shipped:
//   Fix A — directory-as-index in __resolveFile (node-shims.ts:1859)
//   Fix B — ESM→CJS transform in transformEsmInBundle (facet-manager.ts:746)
//   Fix C — __compileFailures map surfacing (node-shims.ts:2082-2095)
//
// X.5-C must not regress these. We re-run W3.5's two key local-runnable
// integration tests (directory-as-index + esm-in-bundle + broken-syntax-
// surfaces) using the same _local/integration-shim-eval.mjs harness.
//
// Pre-fix (i.e., on x5c branch tip BEFORE Phase C lands): PASS — these
// tests exercise W3.5 code paths X.5-C doesn't touch yet.
// Post-fix: PASS — Fix #1 + Fix #2 in X.5-C are additive, not modifying
// the W3.5 surface.

import { execSync } from 'child_process';
import { check, summary, reset } from '../_helpers.mjs';
import path from 'path';
import { fileURLToPath } from 'url';

reset();

console.log('X.5-C regression/r2-w35-fixes-still-green — W3.5 integration shim still PASS');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const HARNESS = path.join(ROOT, 'audit', 'probes', 'w3.5', '_local', 'integration-shim-eval.mjs');

let stdout = '';
let exitCode = 0;
try {
  stdout = execSync(`bun ${HARNESS}`, { cwd: ROOT, encoding: 'utf8' });
} catch (e) {
  stdout = (e.stdout || '') + (e.stderr || '');
  exitCode = e.status || 1;
}

console.log('  ── W3.5 integration output (head) ──');
for (const line of stdout.split('\n').slice(0, 12)) console.log('    ' + line);
console.log('  ── (truncated; tail) ──');
for (const line of stdout.split('\n').slice(-6)) console.log('    ' + line);

const passes = (stdout.match(/^PASS /gm) || []).length;
const fails = (stdout.match(/^FAIL /gm) || []).length;

check(
  'W3.5 directory-as-index test PASS',
  /PASS\s+directory-as-index resolves to \/index\.js/.test(stdout),
  `not found in stdout`,
);
check(
  'W3.5 ESM-transformed module test PASS',
  /PASS\s+ESM-transformed module exports named symbols/.test(stdout),
  `not found in stdout`,
);
check(
  'W3.5 broken-syntax surface test PASS',
  /PASS\s+broken-syntax module surfaces real reason/.test(stdout),
  `not found in stdout`,
);
check(
  'W3.5 integration: 3 PASS / 0 FAIL',
  passes === 3 && fails === 0,
  `passes=${passes} fails=${fails} exit=${exitCode}`,
);

const ok = summary();
process.exit(ok ? 0 : 1);
