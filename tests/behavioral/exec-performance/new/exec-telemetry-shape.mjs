#!/usr/bin/env bun
// exec-performance/exec-telemetry-shape — verifies the foreground-exec
// phase telemetry (NIMBUS_DIAG_EXEC=1) records a well-formed record per
// exec, surfaced via GET /api/_diag/exec.
//
// REQUIRES the worker deployed with NIMBUS_DIAG_EXEC=1 in the shell env
// (so isExecDiagEnabled() returns true in the DO). With the flag OFF the
// ring stays empty and this probe SKIPS (exit 0) rather than failing — the
// telemetry is intentionally zero-overhead when disabled.
//
// What it asserts (flag on):
//   - after a `node -e` exec, /api/_diag/exec returns >=1 record
//   - the record carries the full shape { command, bundleMs, loadMs,
//     runMs, drainPasses, moduleMapBytes, rpcWrites, cacheHit, exitCode }
//   - drainPasses >= 4 (the startup drain's minPasses; proves the count
//     came from inside the facet, NOT a frozen-clock wall-time proxy)
//   - moduleMapBytes is large (the embedded 238 KiB shim + bundle)
//   - rpcWrites >= 1 (the console.log streamed a supervisor RPC write)

import { mintSession, Terminal, makeAsserter, requestHeaders, BASE, deleteSession } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('exec-performance/exec-telemetry-shape');
console.log(`exec-performance/exec-telemetry-shape — ${BASE}`);

const sid = await mintSession();
async function execDiag(path = '/api/_diag/exec', init = {}) {
  const r = await fetch(`${BASE}/s/${sid}/${path.replace(/^\//, '')}`, {
    headers: requestHeaders(), ...init,
  });
  return r;
}

try {
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);

  // Fresh measurement window.
  await execDiag('/api/_diag/exec/reset', { method: 'POST' });

  // A foreground exec that prints (forces an RPC stdout write).
  const r = await t.run('node -e "console.log(\'telemetry-probe\')"', 30_000);
  a.check('node -e ran and printed', /telemetry-probe/.test(r.output),
    `tail=${JSON.stringify(r.output.slice(-200))}`);

  const diagResp = await execDiag('/api/_diag/exec');
  a.check('/api/_diag/exec returns 200', diagResp.status === 200,
    `status=${diagResp.status}`);
  const body = await diagResp.json();
  const records = Array.isArray(body.records) ? body.records : [];

  if (records.length === 0) {
    // Flag is off (or telemetry disabled). Skip — not a failure.
    console.log('[exec-telemetry-shape] SKIP: no records — deploy with NIMBUS_DIAG_EXEC=1 to exercise this probe.');
    const sum = a.summary();
    process.exit(sum.fail > 0 ? 1 : 0);
  }

  const rec = records[records.length - 1];
  const fields = ['command', 'bundleMs', 'loadMs', 'runMs', 'drainPasses',
    'moduleMapBytes', 'rpcWrites', 'cacheHit', 'exitCode'];
  const missing = fields.filter((f) => !(f in rec));
  a.check('telemetry record carries full phase shape', missing.length === 0,
    `missing=${JSON.stringify(missing)} rec=${JSON.stringify(rec)}`);

  a.check('drainPasses >= 4 (facet __pass count, not frozen wall-clock)',
    typeof rec.drainPasses === 'number' && rec.drainPasses >= 4,
    `drainPasses=${rec.drainPasses}`);

  a.check('moduleMapBytes is large (embedded shim + bundle)',
    typeof rec.moduleMapBytes === 'number' && rec.moduleMapBytes > 100_000,
    `moduleMapBytes=${rec.moduleMapBytes}`);

  a.check('rpcWrites >= 1 (console.log streamed a supervisor RPC)',
    typeof rec.rpcWrites === 'number' && rec.rpcWrites >= 1,
    `rpcWrites=${rec.rpcWrites}`);

  a.check('exitCode === 0', rec.exitCode === 0, `exitCode=${rec.exitCode}`);

  console.log(`[exec-telemetry-shape] rec=${JSON.stringify(rec)}`);
  await t.close();
} finally {
  await deleteSession(sid).catch(() => {});
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
