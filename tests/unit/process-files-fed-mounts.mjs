#!/usr/bin/env bun
// A process's listing and barriers carry every fed mount's place, the
// kernel's /dev and /proc among them (immutable feeds), in one position:
// what its store lists of them is answered from its view, and a barrier
// from the position a listing left it at is no poison.
//
// Red before: the session stripped /dev and /proc from a process's
// listing, and carried only the root's epoch and cursor, so a namespace
// with a second fed mount poisoned every barrier.

import assert from 'node:assert/strict';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const files = new ProcessFiles(engine);
const bridge = files.bind({ pid: 7, cred: CRED_KERNEL });

const names = [];
let position = null;
for (let after = null; ;) {
  const page = await bridge.list(after, 1000);
  position ??= page.position;
  names.push(...page.entries.map((entry) => entry.path));
  if (page.next === null) break;
  after = page.next;
}
for (const name of ['dev/null', 'dev/urandom', 'proc/version', 'proc/cpuinfo', 'proc/uptime']) {
  assert.ok(names.includes(name), `the listing has no ${name}`);
}

const first = await bridge.acquire(position, { namespace: true });
assert.equal(first.poison, false, 'a barrier from the listing\'s position is a poison');
assert.deepEqual(first.paths, []);

// The session writes: the next barrier names it, and stays no poison.
engine.as(CRED_KERNEL).mkdir('made');
const second = await bridge.acquire(first.position, { namespace: true });
assert.equal(second.poison, false);
assert.ok(second.paths.some((entry) => entry.path === 'made'), JSON.stringify(second.paths.map((entry) => entry.path)));

// A /proc file registered is another tree: the position from before it is a poison.
files.proc.register('nimbus/extra', () => 'x\n');
assert.equal((await bridge.acquire(second.position, { namespace: true })).poison, true);

console.log('process-files-fed-mounts: ok');
