#!/usr/bin/env bun
// install/transitive-dep-resolution — major-only-range transitive deps install correctly via npx.
//
// User repro (remix-real wave 2026-05-10):
//   npx create-react-router@latest → install fails to resolve
//   `wrappy` (transitive dep of `once`) because `wrappy: '1'` is a
//   major-only semver range and @lifo-sh/core's npx install path
//   treats '1' as a literal version, hits npm registry's
//   /wrappy/1 → 404 → silently skipped. Then `once.js`'s
//   `require('wrappy')` fails at runtime.
//
// Probe asserts:
//   1. `npm install once` resolves wrappy correctly via Nimbus's own
//      installer (the BASELINE — proves the bug is npx-specific, not
//      installer-wide). Sanity check.
//   2. `npx --yes rimraf@3.0.2 --help` runs WITHOUT 'Cannot find
//      module' errors. rimraf@3 pulls glob → inflight → once → wrappy
//      (all major-only ranges of '1' / '2' / '7'). If any transitive
//      dep is dropped, rimraf's CJS require chain fails at runtime.

import { Terminal, mintSession, sleep, makeAsserter, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[transitive-dep-resolution] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

const A = makeAsserter('install/transitive-dep-resolution');

// ── Check 1 (baseline): Nimbus's own npm install resolves wrappy ──
//
// Confirms the BUG IS NPX-SPECIFIC, not a resolver-wide problem.
// Our installer uses resolve-one-facet's full-packument-pick path
// which handles `'1'` ranges correctly.
await t.run('mkdir -p /home/user/test-once && cd /home/user/test-once', 10_000);
await t.run(
  `node -e "require('fs').writeFileSync('/home/user/test-once/package.json', JSON.stringify({name:'t',dependencies:{once:'^1.4.0'}}))"`,
  10_000,
);
const npmInstallOnce = await t.run('npm install once', 90_000);
A.check('baseline: npm install once completes with added marker',
  /added \d+ packages/.test(npmInstallOnce.output),
  `tail: ${npmInstallOnce.output.slice(-300)}`);

const onceRequireCheck = await t.run(
  `cd /home/user/test-once && node -e "const once = require('once'); const f = once(()=>'ok'); console.log('ONCE_OK=' + f())"`,
  15_000,
);
A.check('baseline: require("once") succeeds (wrappy transitively resolved)',
  /ONCE_OK=ok/.test(onceRequireCheck.output),
  onceRequireCheck.output.slice(-300));

// ── Check 2 (THE BUG): npx --yes rimraf@3.0.2 --help should not error ──
//
// rimraf@3.0.2 depends on glob@^7.1.3 which depends on inflight@^1.0.4
// which has `wrappy: '1'`. If any link in this chain fails to install,
// rimraf's runtime CJS require chain breaks with 'Cannot find module'.
//
// The probe runs `--help` (a no-op for filesystem rimraf) and checks:
//   - exit code 0
//   - output does NOT contain 'Cannot find module'
await t.run('cd /home/user && rm -rf /tmp/.npx-cache', 5_000);
const npxRimraf = await t.run(
  'npx --yes rimraf@3.0.2 --help',
  240_000,
);
const npxOutput = npxRimraf.output;

// Check 2a: install phase emitted NO 'could not install' warn lines.
// These warn lines fire when @lifo-sh/core's range detector misses a
// valid semver range (the wrappy@1, inherits@2 chain).
const installWarnCount =
  (npxOutput.match(/warn: could not install \w/g) || []).length;
A.check('npx install: zero "could not install" warn lines (all transitive deps resolved)',
  installWarnCount === 0,
  installWarnCount > 0
    ? `found ${installWarnCount} warn lines: ${(npxOutput.match(/warn: could not install [^\n]+/g) || []).slice(0, 3).join(' | ')}`
    : '');

// Check 2b: NO runtime require error from rimraf bin.js.
// When wrappy is missing, rimraf's `require('./')` chain breaks
// because glob/inflight/once → wrappy can't be resolved. The exact
// error includes 'Cannot find module' regardless of which package
// link failed.
const hasRuntimeReqErr = /Cannot find module/.test(npxOutput);
A.check('npx rimraf run: NO "Cannot find module" runtime error',
  !hasRuntimeReqErr,
  hasRuntimeReqErr ? `tail: ${npxOutput.slice(-800)}` : '');

// Check 2c: rimraf process exit code MUST be 0. The npx wrapper
// surfaces 'Process N (node ...) exited with code 1' on failure.
const hasNonZeroExit = /exited with code [1-9]/.test(npxOutput);
A.check('npx rimraf process exited 0 (binary succeeded)',
  !hasNonZeroExit,
  hasNonZeroExit ? `tail: ${npxOutput.slice(-400)}` : '');

await t.close();
const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
