#!/usr/bin/env bun
// runtime-pkg/process-exit-flushes — G1 probe.
//
// Contract: when a script calls process.exit(N) after writing to stdout,
// the stdout MUST flush before the RPC completes, and the exit code N
// MUST surface to the shell — NOT swallowed into a generic "Canceling
// the request" workerd error.
//
// We test all four canonical paths:
//   1. node -e 'console.log("a"); process.exit(7);'
//   2. node script.js  with script that does the same
//   3. The same via a bin shim invocation (node_modules/.bin/<X>)
//   4. process.exit(0) — confirms the success path also flushes
//
// On prod 8791a51a (pre-fix), tsc.js's process.exit(1) shows
// "[process killed: facet error: The Node.js process.exit(1) API was
// called. Canceling the request.]" — the workerd cancel message
// indicating somewhere in tsc, process.exit goes to a real workerd
// binding (NOT our shim), and stdout/stderr are dropped.
//
// Simple cases (1,2) already work on prod — captured as positive
// baselines. The failure mode is specifically inside complex bins
// where some indirection rebinds `process`. Probe asserts that EVERY
// path correctly flushes and surfaces the code.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[G1] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(15_000).catch(() => {});

await t.run('mkdir -p /home/user/g1-probe', 5_000);
await t.run('cd /home/user/g1-probe', 5_000);

function detectExitCode(out, label) {
  // Look for "exited with code N" emitted by Nimbus's process exit
  // banner. NOT the literal text "code N" anywhere — the formal
  // diagnostic line.
  const m = out.match(/exited with code (-?\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ── Test 1: node -e + process.exit(7) ──
const e1 = await t.run('node -e "console.log(\'a-marker\'); process.exit(7);"', 30_000);
const e1Out = stripAnsi(e1.output);
const t1Out = /a-marker/.test(e1Out);
const t1Code = detectExitCode(e1Out, 't1') === 7;

// ── Test 2: node script.js + process.exit(13) ──
const code = "console.log('b-marker'); process.exit(13);";
const codeB64 = Buffer.from(code, 'utf8').toString('base64');
await t.run(
  `node -e "require('fs').writeFileSync('exit13.js', Buffer.from('${codeB64}','base64').toString('utf8'))"`,
  10_000,
);
const e2 = await t.run('node exit13.js', 30_000);
const e2Out = stripAnsi(e2.output);
const t2Out = /b-marker/.test(e2Out);
const t2Code = detectExitCode(e2Out, 't2') === 13;

// ── Test 3: bin shim that calls process.exit(7) ──
//
// Custom shim — install a 4-line CLI under .bin/ that does
// `console.log(<marker>); process.exit(<code>)`. Direct invocation
// via the registry-resolve fallback (primitive #2) goes through the
// same node command path as test 2 — but the bin path adds the bin-
// shim parsing layer. Asserts that THAT layer doesn't drop stdout.
await t.run('mkdir -p node_modules/.bin', 5_000);
const cliCode = '#!/usr/bin/env node\nconsole.log("c-marker"); process.exit(21);\n';
const cliCodeB64 = Buffer.from(cliCode, 'utf8').toString('base64');
await t.run(
  `node -e "require('fs').writeFileSync('node_modules/.bin/exit21cli', Buffer.from('${cliCodeB64}','base64').toString('utf8'))"`,
  10_000,
);
const e3 = await t.run('exit21cli', 30_000);
const e3Out = stripAnsi(e3.output);
const t3Out = /c-marker/.test(e3Out);
const t3Code = detectExitCode(e3Out, 't3') === 21;

// ── Test 4: process.exit(0) — success-path flush ──
const e4 = await t.run('node -e "console.log(\'d-marker\'); process.exit(0);"', 30_000);
const e4Out = stripAnsi(e4.output);
const t4Out = /d-marker/.test(e4Out);
const t4Code = detectExitCode(e4Out, 't4') === 0;

// ── Test 5: stdout written via process.stdout.write (NOT console.log) ──
//
// Some libs go straight to process.stdout.write. Asserts that the
// stdout-write shim chain also flushes before exit.
const e5 = await t.run("node -e \"process.stdout.write('e-marker\\n'); process.exit(2);\"", 30_000);
const e5Out = stripAnsi(e5.output);
const t5Out = /e-marker/.test(e5Out);
const t5Code = detectExitCode(e5Out, 't5') === 2;

await t.close();

const findings = {
  gap: 'G1',
  sid,
  base: BASE,
  tests: {
    nodeE7: { stdoutFlushed: t1Out, codeOk: t1Code },
    nodeScript13: { stdoutFlushed: t2Out, codeOk: t2Code },
    binShim21: { stdoutFlushed: t3Out, codeOk: t3Code },
    nodeE0: { stdoutFlushed: t4Out, codeOk: t4Code },
    procStdoutWrite2: { stdoutFlushed: t5Out, codeOk: t5Code },
  },
};
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['node -e exit(7)        — stdout flushed',           t1Out],
  ['node -e exit(7)        — exit code surfaced',       t1Code],
  ['node script exit(13)   — stdout flushed',           t2Out],
  ['node script exit(13)   — exit code surfaced',       t2Code],
  ['bin shim  exit(21)     — stdout flushed',           t3Out],
  ['bin shim  exit(21)     — exit code surfaced',       t3Code],
  ['node -e exit(0)        — stdout flushed',           t4Out],
  ['node -e exit(0)        — exit code surfaced',       t4Code],
  ['process.stdout.write   — flushed before exit',      t5Out],
  ['process.stdout.write   — exit code surfaced',       t5Code],
];
let pass = 0;
for (const [name, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (ok) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[G1] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
