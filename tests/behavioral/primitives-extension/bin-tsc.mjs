#!/usr/bin/env bun
// primitives-extension/bin-tsc — primitive #2 probe.
//
// Today: bin shims at <project>/node_modules/.bin/<cmd> are routed
// through shellExecuteTracked ONLY inside `npm run <script>` (init.ts:
// 1972-1983). Direct terminal invocation of `tsc --version` after
// `npm i typescript` HAS no shell-level handler — it falls through
// to @lifo-sh/core's PATH lookup which doesn't know about the project's
// .bin directory.
//
// What "generic bin handler" means per the queued plan:
//
//   - Direct `<bin> [args]` from the terminal SHOULD route through
//     shellExecuteTracked when the bin exists at
//     `<cwd>/node_modules/.bin/<bin>`.
//   - For dev/start/serve/watch-class invocations the bin gets the
//     long-running treatment (PID, port registration, Process tab).
//   - For one-shot bins (tsc, eslint, prettier), the bin runs but
//     stdout/stderr stream to the process tab the same way.
//
// Probe shape:
//
//   1. Install typescript locally → node_modules/.bin/tsc shim exists.
//   2. Run `tsc --version` directly (NOT via `npm run`).
//   3. Pre-fix: shell falls through, "command not found" or hang.
//      Post-fix: shellExecuteTracked picks it up, version prints.
//
// Black-box surfaces only.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[#2] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(15_000).catch(() => {});

// ── Setup: a tiny project with typescript devDep ──
await t.run('cd /home/user', 5_000);
await t.run('mkdir -p tsc-probe', 5_000);
await t.run('cd /home/user/tsc-probe', 5_000);
await t.run('node -e "require(\'fs\').writeFileSync(\'package.json\', JSON.stringify({name:\'p\',version:\'1.0.0\',devDependencies:{typescript:\'5.4.5\'}}))"', 10_000);

// Install (typescript is small, ~1 file in .bin, ~50 MB extracted).
t.reset();
t.cmd('npm i');
let installOk = false;
try {
  await t.waitFor(
    (b) => /added \d+ packages|npm install failed|\[batch-fanout\] aborted/i.test(b),
    240_000,
    'install end',
  );
  installOk = /added\s+\d+\s+packages/.test(stripAnsi(t.buf));
} catch {}

// Verify shim exists.
const lsResult = await t.run('ls /home/user/tsc-probe/node_modules/.bin/tsc 2>/dev/null', 10_000);
const shimPresent = /\/tsc/.test(stripAnsi(lsResult.output));

// ── Run the bin directly ──
t.reset();
t.cmd('tsc --version');
let elapsed = 0;
try { elapsed = await t.waitForNewPrompt(60_000); }
catch { elapsed = -1; }
const directOutput = stripAnsi(t.buf);
const directOk = /Version\s+\d+\.\d+/i.test(directOutput);

// ── Sanity: same command via `npm exec tsc -- --version` ──
//
// `npm exec` is the standard alternative; it should already work.
// Used as a sanity baseline so a probe failure can be triaged
// (env vs. shim presence vs. shell routing).
const npmxResult = await t.run('npm exec tsc -- --version', 60_000);
const npmxOk = /Version\s+\d+\.\d+/i.test(stripAnsi(npmxResult.output));

const findings = {
  primitive: '#2',
  sid,
  base: BASE,
  installOk,
  shimPresent,
  directInvocation: {
    elapsed,
    ok: directOk,
    head: directOutput.slice(-600),
  },
  npmExec: {
    elapsed: npmxResult.elapsed,
    ok: npmxOk,
    head: stripAnsi(npmxResult.output).slice(-300),
  },
};

await t.close();
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['npm install succeeds',                            installOk],
  ['node_modules/.bin/tsc shim exists',               shimPresent],
  ['direct `tsc --version` runs and prints version',  directOk],
];

let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[#2] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
