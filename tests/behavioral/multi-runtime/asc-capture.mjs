#!/usr/bin/env bun
// multi-runtime/asc-capture — CAPTURE-ONLY probe.
//
// AssemblyScript's compiler (assemblyscript@0.28.17) was identified
// during this wave's feasibility check as NOT shippable in this
// wave: `asc --version` hangs for 60 s+ inside a Nimbus session
// because asc's bin shim uses `child_process.spawnSync` to relaunch
// itself with `--enable-source-maps`, and Nimbus's spawnSync
// semantics aren't sufficient for asc's needs.
//
// This probe DOES NOT ASSERT PASS — it records the failure mode
// against the current prod, so the next wave (asc-hardening) has a
// precise target. Each test is isolated via try/catch so one
// timeout doesn't kill the whole probe.
//
// CAPTURE-ONLY — exit 0 always.

import { mintSession, Terminal, sleep, stripAnsi, BASE } from '../_driver.mjs';

async function safeRun(t, cmd, timeoutMs) {
  t.reset();
  const t0 = Date.now();
  try {
    t.cmd(cmd);
    await t.waitForNewPrompt(timeoutMs);
    return { cmd, output: stripAnsi(t.buf), elapsed: Date.now() - t0, timedOut: false };
  } catch (e) {
    return { cmd, output: stripAnsi(t.buf), elapsed: Date.now() - t0, timedOut: true, error: e.message };
  }
}

const findings = {
  probe: 'asc-capture',
  base: BASE,
  startedAt: new Date().toISOString(),
};

let sid;
try {
  sid = await mintSession();
} catch (e) {
  findings.fatal = 'mintSession failed: ' + e.message;
  console.log(JSON.stringify(findings, null, 2));
  console.log('[asc-capture] EXPECTED-RED — captured for forensic record');
  process.exit(0);
}
findings.sid = sid;
console.log(`[asc-capture] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
try {
  await t.connect();
  await sleep(2_000);
  await t.waitForPrompt(60_000);
} catch (e) {
  findings.fatal = 'session-init failed: ' + e.message;
  await t.close().catch(() => {});
  console.log(JSON.stringify(findings, null, 2));
  console.log('[asc-capture] EXPECTED-RED — captured for forensic record');
  process.exit(0);
}

findings.setup = {};
findings.setup.mkdir = await safeRun(t, 'mkdir -p /home/user/asc-cap', 30_000);
findings.setup.cd = await safeRun(t, 'cd /home/user/asc-cap', 15_000);
findings.setup.pkgJson = await safeRun(
  t,
  'node -e "require(\'fs\').writeFileSync(\'package.json\', JSON.stringify({name:\'p\',version:\'1.0.0\'}))"',
  60_000,
);

// ── A: install ──
findings.install = await safeRun(t, 'npm i assemblyscript@0.28.17', 240_000);
findings.install.installOk = /added\s+\d+\s+packages/.test(findings.install.output);

// ── B: shim materialised? ──
findings.shim = await safeRun(
  t,
  'node -e "console.log(require(\'fs\').existsSync(\'/home/user/asc-cap/node_modules/.bin/asc\'))"',
  60_000,
);
findings.shim.exists = /^true$/m.test(findings.shim.output);

// ── C: asc --version with a SHORT timeout to capture hang ──
findings.ascVersion = await safeRun(t, 'asc --version', 30_000);
const out = findings.ascVersion.output;
findings.ascVersion.versionPrinted = /Version\s+\d+\.\d+/.test(out) || /^\d+\.\d+\.\d+/m.test(out);
findings.ascVersion.mentionsSpawnSync = /spawnSync|spawn_sync/i.test(out);
findings.ascVersion.mentionsSourceMaps = /source-maps|--enable-source-maps/i.test(out);
findings.ascVersion.mentionsChildProcess = /child_process|child process/i.test(out);
findings.ascVersion.facetError = /facet error|process killed/i.test(out);
const errCode = out.match(/exited with code (-?\d+)/);
findings.ascVersion.exitCode = errCode ? parseInt(errCode[1], 10) : null;
findings.ascVersion.tail = out.slice(-1500);

await t.close().catch(() => {});

console.log(JSON.stringify(findings, null, 2));

const verdict =
  findings.ascVersion?.versionPrinted && !findings.ascVersion?.timedOut
    ? 'UNEXPECTED-GREEN'
    : 'EXPECTED-RED';
console.log(`[asc-capture] ${verdict} — captured for forensic record`);
process.exit(0);
