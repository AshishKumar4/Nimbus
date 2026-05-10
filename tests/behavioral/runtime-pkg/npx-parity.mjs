#!/usr/bin/env bun
// runtime-pkg/npx-parity — G4 probe.
//
// Today: `npx <pkg>` flows through @lifo-sh/core's npx (auto-install
// path uses core's installer + core's process registry); `<pkg>`
// direct flows through my P4 wrapper (Nimbus's processTable + bin-
// shim parse). For an ALREADY-INSTALLED package, the two paths
// SHOULD produce identical observable state — same PID lifecycle,
// same log stream, same exit handling.
//
// Pre-fix: Nimbus's npx wrapper at init.ts:2382 uses `await
// registry.resolve(cmd)` which short-circuits to my P4 synth handler
// for installed bins — so the npx-vs-direct paths SHOULD already
// align. But:
//   - npx runs through the npx registered handler first
//   - direct runs through my registry.resolve fallback
// The npx wrapper may add extra spawn/event-emit work that direct
// doesn't, leading to PID-count drift.
//
// Probe: install a small bin, then invoke it BOTH ways. Compare:
//   1. PID count delta (should be the same — exactly +1 each)
//   2. Both rows visible in `ps`
//   3. Both produce identical stdout output

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[G4] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(15_000).catch(() => {});

await t.run('mkdir -p /home/user/g4-probe/node_modules/.bin', 5_000);
await t.run('cd /home/user/g4-probe', 5_000);
await t.run('node -e "require(\'fs\').writeFileSync(\'package.json\', JSON.stringify({name:\'p\',version:\'1.0.0\'}))"', 10_000);

// Custom bin — prints a known marker + its argv.
const cliCode =
  '#!/usr/bin/env node\n' +
  '"use strict";\n' +
  'console.log("PARITY-MARKER:" + JSON.stringify(process.argv.slice(2)));\n' +
  'process.exit(0);\n';
const cliCodeB64 = Buffer.from(cliCode, 'utf8').toString('base64');
await t.run(
  `node -e "require('fs').writeFileSync('node_modules/.bin/parity', Buffer.from('${cliCodeB64}','base64').toString('utf8'))"`,
  10_000,
);

function highestPid(psOutput) {
  const rows = psOutput.split(/\r?\n/).filter(l => /^\s+\d+\s+/.test(l));
  let m = 0;
  for (const l of rows) {
    const x = l.match(/^\s+(\d+)\s+/);
    if (x) m = Math.max(m, parseInt(x[1], 10));
  }
  return m;
}

// ── A baseline ps to anchor PID counter ──
const ps0 = stripAnsi((await t.run('ps', 10_000)).output);
const pid0 = highestPid(ps0);

// ── Direct invocation ──
const rDirect = await t.run('parity --direct hello', 30_000);
const rDirectOut = stripAnsi(rDirect.output);
const directPrintedMarker = /PARITY-MARKER:\["--direct","hello"\]/.test(rDirectOut);

const ps1 = stripAnsi((await t.run('ps', 10_000)).output);
const pid1 = highestPid(ps1);
const directPidDelta = pid1 - pid0;

// ── npx invocation ──
const rNpx = await t.run('npx parity --npx hello', 30_000);
const rNpxOut = stripAnsi(rNpx.output);
const npxPrintedMarker = /PARITY-MARKER:\["--npx","hello"\]/.test(rNpxOut);

const ps2 = stripAnsi((await t.run('ps', 10_000)).output);
const pid2 = highestPid(ps2);
const npxPidDelta = pid2 - pid1;

// ── Both visible in ps after the second invocation? ──
const ps2Rows = ps2.split(/\r?\n/).filter(l => /parity/i.test(l));
const psHasDirect = ps2Rows.some(l => /--direct/.test(l));
const psHasNpx    = ps2Rows.some(l => /--npx/.test(l));

await t.close();

const findings = {
  gap: 'G4',
  sid,
  base: BASE,
  baselinePid: pid0,
  directInvocation: {
    pidAfter: pid1,
    pidDelta: directPidDelta,
    printedMarker: directPrintedMarker,
    head: rDirectOut.slice(-400),
  },
  npxInvocation: {
    pidAfter: pid2,
    pidDelta: npxPidDelta,
    printedMarker: npxPrintedMarker,
    head: rNpxOut.slice(-400),
  },
  psAfterBoth: {
    hasDirectRow: psHasDirect,
    hasNpxRow: psHasNpx,
    raw: ps2.slice(-700),
  },
};
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['direct: PARITY-MARKER printed',                 directPrintedMarker],
  ['direct: ps PID grew exactly +1 (no double spawn)', directPidDelta === 1],
  ['npx:    PARITY-MARKER printed',                 npxPrintedMarker],
  ['npx:    ps PID grew exactly +1 (no double spawn)', npxPidDelta === 1],
  ['ps shows direct invocation row',                psHasDirect],
  ['ps shows npx invocation row',                   psHasNpx],
];
let pass = 0;
for (const [name, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (ok) pass++; }
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[G4] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
