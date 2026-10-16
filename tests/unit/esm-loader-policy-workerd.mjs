// @serial
// @tier slow — drives a local workerd
// A hosted node program's ES module loader decides as Node 22's does before
// anything resolves, by the same policy the portable loader uses
// (runtime/esm-loader-policy.ts, compiled into the hosted runtime as
// ESM_LOADER_POLICY_SOURCE; audit RTM-7, RTM-8): import()'s arguments, data:
// URL modules, and node:module. Host Node running the same program is the
// oracle (lib/esm-loader-policy-program.mjs).
//
// Red before: an unknown data: MIME type was a TypeError ("Unsupported data
// module MIME type: …") where Node's is a RangeError naming the format and
// the URL.
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';
import { PROGRAM, hostReport, report } from './lib/esm-loader-policy-program.mjs';

const host = mkdtempSync(join(tmpdir(), 'esm-loader-policy-workerd-'));
let expected;
try {
  writeFileSync(join(host, 'policy.mjs'), PROGRAM);
  expected = hostReport(host);
} finally {
  rmSync(host, { recursive: true, force: true });
}

const probe = await startLocalProbe({ runtimes: [] });
try {
  const session = await localTerminal(probe, { install: [] });
  try {
    const payload = Buffer.from(PROGRAM).toString('base64');
    const setup = await session.run(`node -e "require('fs').writeFileSync('/home/user/policy.mjs', Buffer.from('${payload}','base64'));console.log('SETUP')"`);
    assert.equal(setup.status, 0, setup.stdout);
    const ran = await session.run('cd /home/user && node policy.mjs', 120_000);
    assert.equal(ran.status, 0, ran.stdout);
    assert.deepEqual(report(ran.stdout), expected, 'the hosted loader decides as host Node does');
  } finally {
    await session.close();
  }
} finally {
  await probe.stop();
}
console.log('ok - esm-loader-policy-workerd (import() arguments, data: modules and node:module, hosted, as Node 22 has them)');
