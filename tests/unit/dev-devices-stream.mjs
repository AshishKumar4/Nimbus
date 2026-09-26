#!/usr/bin/env bun
// /dev/zero and /dev/urandom stream on every read path, as character devices
// do: a read of any length at any offset returns bytes (a short read past the
// device's per-read cap), through bash's WASI fd_read and fd_pread, in-process
// and over the supervisor RPC, and through a process's bridge. /dev/null reads
// empty and swallows writes; a write to /dev/full is ENOSPC.

import assert from 'node:assert/strict';
import { runScript } from './lib/bash-preamble.mjs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { processFiles } from './lib/process-bridge.mjs';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const SCRIPTS = [
  ['head -c 200000 /dev/zero | wc -c', '200000\n'],
  ['head -c 3000000 /dev/zero | wc -c', '3000000\n'],
  ['head -c 4096 /dev/zero | tr -d "\\0" | wc -c', '0\n'],
  ['head -c 16 /dev/urandom | wc -c', '16\n'],
  ['cat /dev/null | wc -c', '0\n'],
  ['echo x > /dev/null; echo rc=$?', 'rc=0\n'],
  ['echo x > /dev/full 2>/dev/null; echo rc=$?', 'rc=1\n'],
];
for (const remote of [false, true]) {
  for (const [script, stdout] of SCRIPTS) {
    const r = await runScript(script, { remote });
    assert.equal(r.stdout, stdout, `${remote ? 'over RPC' : 'in-process'}: ${script} (stderr ${JSON.stringify(r.stderr)})`);
  }
}
// One descriptor read twice: its position moves on, and the device still
// answers. (Over the RPC only: the in-process harness without parking loses a
// pipeline's output when a stage's stdin is redirected, for any file.)
{
  const r = await runScript('{ head -c 1000000 >/dev/null; head -c 10; } < /dev/zero | wc -c', { remote: true });
  assert.equal(r.stdout, '10\n', r.stderr);
}
{
  const r = await runScript('echo x > /dev/full', {});
  assert.match(r.stderr, /No space left on device/);
}

// A process's bridge: ranged reads at any offset, handles, and writes.
const harness = createSqliteVfsTestHarness();
const bridge = processFiles(new SqliteVFS(harness.sql, harness.ctx)).bind({ pid: 3, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
assert.deepEqual(bridge.readRange('/dev/zero', 0, 5), new Uint8Array(5));
assert.deepEqual(bridge.readRange('/dev/zero', 1e12, 5), new Uint8Array(5));
assert.equal(bridge.readRange('/dev/urandom', 7, 32).byteLength, 32);
assert.equal(bridge.readRange('/dev/null', 0, 32).byteLength, 0);
const handle = bridge.open('/dev/zero', { read: true });
assert.ok(bridge.read(handle.id, null, 1 << 20).byteLength > 0);
assert.ok(bridge.read(handle.id, 1e9, 1024).byteLength === 1024);
bridge.close(handle.id);
const full = bridge.open('/dev/full', { write: true });
assert.throws(() => bridge.write(full.id, null, new Uint8Array(1)), { code: 'ENOSPC' });
bridge.close(full.id);

console.log('dev-devices-stream: ok');
