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

// ── Setup: a tiny project + LOCAL bin shim that we control ──
//
// We test primitive #2 (the .bin handler routing) with a bin we
// control end-to-end, so a third-party CLI's runtime quirks don't
// gate the architectural assertion. Tsc + many real bins crash on
// Nimbus's facet runtime for unrelated reasons (missing native
// modules, complex CJS init); the bin handler itself works the same
// way regardless.
//
// Test plan: write a 3-line "echo" bin to node_modules/.bin/echocli,
// invoke it from the terminal, assert output contains the marker.
await t.run('cd /home/user', 5_000);
await t.run('mkdir -p tsc-probe/node_modules/.bin', 5_000);
await t.run('cd /home/user/tsc-probe', 5_000);
await t.run('node -e "require(\'fs\').writeFileSync(\'package.json\', JSON.stringify({name:\'p\',version:\'1.0.0\'}))"', 10_000);

// Write a custom CLI script that just echoes its argv. Base64-encode
// the body so the shell parser doesn't fight us about quoting.
const cliCode =
  '#!/usr/bin/env node\n' +
  'console.log("ECHOCLI-MARKER:" + JSON.stringify(process.argv.slice(2)));\n';
const cliCodeB64 = Buffer.from(cliCode, 'utf8').toString('base64');
await t.run(
  `node -e "require('fs').writeFileSync('/home/user/tsc-probe/node_modules/.bin/echocli', Buffer.from('${cliCodeB64}', 'base64').toString('utf8'))"`,
  15_000,
);

// Verify shim exists (we just wrote it; this is a sanity check).
const lsResult = await t.run('cat /home/user/tsc-probe/node_modules/.bin/echocli', 10_000);
const shimPresent = /ECHOCLI-MARKER/.test(stripAnsi(lsResult.output));
const installOk = shimPresent; // semantic alias — the install in this
                                // probe is the file write above

// ── Run the bin directly ──
t.reset();
t.cmd('echocli --version');
let elapsed = 0;
try { elapsed = await t.waitForNewPrompt(60_000); }
catch { elapsed = -1; }
const directOutput = stripAnsi(t.buf);
// The marker plus the user-side argv should both appear. Guard against
// the user-typed echo by requiring the argv-JSON shape.
const directOk = /ECHOCLI-MARKER:\["--version"\]/.test(directOutput);

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
  ['echocli shim materialised in .bin/',               shimPresent],
  ['shim file readable + has marker',                  installOk],
  ['direct `echocli --version` runs and emits marker', directOk],
];

let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[#2] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
