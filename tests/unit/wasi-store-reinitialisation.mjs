#!/usr/bin/env bun
// Two __wasiInitFS lifetimes in one evaluation of the bundled WASI body.
// Preparing the resident filesystem must really boot it, not fall back to
// the authority-only path on a runtime without JSPI.
import assert from 'node:assert/strict';
import { rootOf } from '../../packages/core/src/runtime/feed-position.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/core/src/runtime/wasi-instance.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createAuthority } from './lib/resident-body.mjs';
import { processInstanceSupervisor } from './lib/process-instance-supervisor.mjs';
import { WASI_INSTANCE_PROBE, startResidentWasi } from './lib/wasi-instance-probe.mjs';

const firstCred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const secondCred = { uid: 2000, gid: 2000, groups: [2000], umask: 0o077 };
const firstSession = createAuthority();
const secondSession = createAuthority();
const root2 = secondSession.rawVfs.as(CRED_KERNEL);
firstSession.kfs.writeFile('home/user/first-only.txt', 'first process bytes');
firstSession.kfs.writeFile('home/user/secret.txt', 'first secret', { mode: 0o600 });
root2.writeFile('home/user/second-only.txt', 'second process bytes', { mode: 0o600 });
root2.chown('home/user/second-only.txt', 2000, 2000);
root2.writeFile('home/user/secret.txt', 'second secret', { mode: 0o600 });
root2.chown('home/user/secret.txt', 1000, 1000);
const firstProcess = processInstanceSupervisor(firstSession, firstCred);
const secondProcess = processInstanceSupervisor(secondSession, secondCred);
const dir = mkdtempSync(join(tmpdir(), 'wasi-store-reinit-'));
const file = join(dir, 'body.mjs');
writeFileSync(file, WASI_INSTANCE_PREAMBLE_SRC + WASI_INSTANCE_PROBE);
const P = await import(file); // Exactly one evaluated body for both starts.
const decoder = new TextDecoder();

try {
  const first = await startResidentWasi(P, firstProcess.supervisor, firstCred);
  assert.equal(first.namespace.ready(), true);
  assert.equal(decoder.decode(await first.fs.readFile('home/user/secret.txt')), 'first secret');
  assert.equal(decoder.decode(await first.fs.readFile('home/user/first-only.txt')), 'first process bytes');
  assert.ok(first.namespace.entry('home/user/first-only.txt'));
  const firstStats = P.__wasiFsStats();
  assert.ok(firstStats.local > 0, 'the first process actually answered calls from its resident store');
  assert.equal((await first.namespace.barrier()).landed, true);
  assert.deepEqual(firstProcess.acquireRequests.at(-1), firstSession.cursor());
  assert.equal(await P.__wasiSettleWrites(), null);
  await firstProcess.close();

  const second = await startResidentWasi(P, secondProcess.supervisor, secondCred);
  assert.equal(second.namespace.ready(), true);
  assert.equal(P.__wasiFsStats().local, 0, 'a new WASI process starts a fresh read profiler');
  assert.deepEqual(secondProcess.acquireRequests[0], null, 'the new process did not offer the previous cursor');
  assert.notEqual(rootOf(firstSession.cursor()).epoch, rootOf(secondSession.cursor()).epoch);
  assert.equal((await second.namespace.barrier()).landed, true);
  assert.deepEqual(secondProcess.acquireRequests.at(-1), secondSession.cursor(), 'the next barrier uses only the second session\'s cursor');
  assert.equal(second.namespace.entry('home/user/first-only.txt'), null, 'names from the previous process are absent');
  assert.equal(second.namespace.content('home/user/first-only.txt'), undefined, 'previously filled bytes are absent too');
  assert.equal(await second.fs.stat('home/user/first-only.txt'), null);
  await assert.rejects(async () => second.fs.readFile('home/user/secret.txt'), { code: 'EACCES' }, 'uid 2000 must not inherit uid 1000\'s readable secret');
  assert.equal(decoder.decode(await second.fs.readFile('home/user/second-only.txt')), 'second process bytes');
  assert.equal(second.namespace.cred.uid, 2000);
  assert.equal(first.namespace.cred.uid, 1000, 'starting the new process did not rewrite the old view');
  assert.equal(decoder.decode(first.namespace.content('home/user/first-only.txt')), 'first process bytes');
  assert.equal(first.fs.stats().local, firstStats.local, 'new reads did not increment the previous process\'s profiler');
  assert.ok(P.__wasiFsStats().local > 0);
  assert.equal(await P.__wasiSettleWrites(), null);
} finally {
  await secondProcess.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log('wasi-store-reinitialisation: PASS');
