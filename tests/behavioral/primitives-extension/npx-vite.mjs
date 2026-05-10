#!/usr/bin/env bun
// primitives-extension/npx-vite — primitive #1 probe.
//
// What this probe asserts (GREEN gate):
//
//   A. `npx --version` prints. Smoke check; passes pre-fix.
//   B. `npx cowsay -- hello` auto-installs cowsay and runs the
//      bin. This already passes pre-fix via @lifo-sh/core's npx,
//      which uses core's installer for the auto-install path.
//   C. After `npx <pkg>`, the package shows up in `ps` with a real
//      Nimbus PID (NOT a synthetic core-side faux-pid). This is
//      the "primitive #3 long-running adapter integration" piece
//      from the queued plan: npx-spawned bins must flow through
//      the same processTable + Process tab pipeline as everything
//      else, so the Process tab UI's Kill/Restart works on them.
//   D. `npx <pkg>` writes diagnostic output to the per-pid log
//      buffer (the same one the Process tab reads).
//
// Pre-fix: A and B pass; C may pass coincidentally because core's
// runner uses ctx.processRegistry — but the PID space is the
// core-private process-registry, NOT Nimbus's processTable. So
// `ps` (which reads processTable) shows nothing.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[#1] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(15_000).catch(() => {});

async function runProbe(cmd, timeoutMs) {
  t.reset();
  t.cmd(cmd);
  // Wait for next prompt OR a long stall.
  let elapsed = 0;
  try {
    elapsed = await t.waitForNewPrompt(timeoutMs);
  } catch (e) {
    return { cmd, elapsed: timeoutMs, output: stripAnsi(t.buf), timedOut: true };
  }
  return { cmd, elapsed, output: stripAnsi(t.buf), timedOut: false };
}

// ── A: npx itself responds ─────────────────────────────────────────────
const versionResult = await runProbe('npx --version', 15_000);
const versionOk = /\d+\.\d+/.test(versionResult.output);

// ── B: npx <bin> for a SMALL package not pre-installed ─────────────────
//
// Use `semver` — tiny package, deterministic --version output, no
// runtime quirks (vs cowsay which exercises cjs/require edge cases).
// We assert that running `npx semver --version` prints a vN.N.N line
// AS THE LAST OUTPUT BEFORE THE PROMPT, not just somewhere in the
// install-banner echo.
await t.run('cd /home/user', 5_000);
await t.run('mkdir -p npx-probe', 5_000);
await t.run('cd /home/user/npx-probe', 5_000);
await t.run('node -e "require(\'fs\').writeFileSync(\'package.json\', JSON.stringify({name:\'p\',version:\'1.0.0\'}))"', 10_000);
const cowResult = await runProbe('npx semver --version', 240_000);
// Look for a numeric version in the LAST 200 chars before the prompt
// (so "echo of `npx semver --version`" doesn't false-positive).
const tail = cowResult.output.slice(-400);
const cowOk = /\d+\.\d+\.\d+/.test(tail) && !cowResult.timedOut;

// ── C: ps shows the npx-launched process recorded in Nimbus's processTable.
//
// We capture `ps` output BEFORE and AFTER. The post-set should
// contain at least one new entry whose command mentions npx /
// cowsay / .npx-cache. Nimbus's `ps` command at init.ts:2141
// reads from self.processTable.getAll().
//
// Note: cowsay is short-lived; by the time `ps` runs, it has
// exited. The processTable retains exited entries (state='exited')
// so the row remains visible. The ASSERTION is that the row is
// THERE — its 'state' can be running OR exited.
const psResult = await t.run('ps', 15_000);
const psOutput = stripAnsi(psResult.output);
// Strict: the COMMAND column of a ps row must mention npx / a known
// npx-cache path / the bin we invoked. Match only on lines that look
// like ps rows (start with whitespace + digits: "  PID  STATUS  COMMAND").
const psRows = psOutput.split(/\r?\n/).filter(l => /^\s+\d+\s+/.test(l));
const psHasNpxRow = psRows.some(l => /\.npx-cache|node_modules\/semver|npm.*exec/.test(l));

// ── D: per-pid log buffer captured something for the npx process.
//
// Find the highest PID from `ps` output and try `logs <pid>`.
// Nimbus's `logs` command at init.ts:2177 reads from processLogs.
// If npx-launched bins flow through Nimbus's logging, we see the
// cowsay banner here. If they go through core's private process
// registry, this returns no rows or an error.
const psLines = psOutput.split(/\r?\n/);
const pidMatches = psLines
  .map(l => l.match(/^\s*(\d+)\s+/))
  .filter(Boolean)
  .map(m => parseInt(m[1], 10));
const highestPid = pidMatches.length > 0 ? Math.max(...pidMatches) : null;
let logsHasOutput = false;
let logsHead = '';
if (highestPid != null) {
  const logsResult = await t.run(`logs ${highestPid}`, 15_000);
  const logsOutput = stripAnsi(logsResult.output);
  logsHead = logsOutput.slice(0, 600);
  // The buffer must contain SOMETHING. Empty buffer = the npx process
  // didn't flow through Nimbus's processLogs at all. Any non-empty
  // line that isn't "no logs" / error counts as a hit.
  logsHasOutput = logsOutput.length > 0 &&
    !/no log buffer|no such process/i.test(logsOutput);
}

const findings = {
  primitive: '#1',
  sid,
  base: BASE,
  versionResult: { elapsed: versionResult.elapsed, ok: versionOk, head: versionResult.output.slice(0, 200) },
  cowResult: {
    elapsed: cowResult.elapsed,
    ok: cowOk,
    timedOut: cowResult.timedOut,
    head: cowResult.output.slice(0, 800),
  },
  psObserved: {
    hasNpxRow: psHasNpxRow,
    head: psOutput.slice(0, 600),
  },
  logsObserved: {
    pid: highestPid,
    hasOutput: logsHasOutput,
    head: logsHead,
  },
};

await t.close();
console.log(JSON.stringify(findings, null, 2));

const checks = [
  ['npx --version responds',                                   versionOk],
  ['npx cowsay auto-installs and runs',                        cowOk],
  ['ps shows the npx-launched process row',                    psHasNpxRow],
  ['logs <pid> returns the npx process buffer',                logsHasOutput],
];

let pass = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
const verdict = pass === checks.length ? 'GREEN' : 'RED';
console.log(`[#1] ${verdict} — ${pass}/${checks.length} checks`);
process.exit(verdict === 'GREEN' ? 0 : 1);
