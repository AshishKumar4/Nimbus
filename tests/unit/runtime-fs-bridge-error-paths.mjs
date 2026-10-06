#!/usr/bin/env bun
// The runtime fs bridge (what node programs' fs and the shell reach) fails
// with Node's error for its own call: the call's syscall and the caller's
// paths (Kinu's ask 9, "vite prints its entry as a storage key"). The SQLite
// engine's errors carry a code and no call, and name a storage key
// ("ENOENT: home/user/w/nope"); each public call now names them as Node
// would, the engine's error kept as the cause, whatever lookup met it.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const kernel = raw.as(CRED_KERNEL);
kernel.mkdir('home/user/w', { recursive: true });
kernel.writeFile('home/user/w/f', 'x');
kernel.mkdir('srv', { mode: 0o755 });
const bridge = new SqliteRuntimeFsBridge(raw.as(CRED_KERNEL), raw);
const user = new SqliteRuntimeFsBridge(raw.as({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }), raw);

const missing = '/home/user/w/nope/x';
const file = '/home/user/w/f';
/** Each public call, and the syscall and paths Node's error for it names. */
const calls = [
  ['realpath', () => bridge.realpath(missing), 'realpath', missing],
  ['readdir', () => bridge.readdir(missing), 'scandir', missing],
  ['writeFile', () => bridge.writeFile(missing, 'x'), 'write', missing],
  ['writeRange', () => bridge.writeRange(missing, 0, new Uint8Array(1)), 'write', missing],
  ['writeFileFrom', () => bridge.writeFileFrom(missing, 1, (async function* () { yield new Uint8Array(1); })()), 'write', missing],
  ['symlink', () => bridge.symlink('t', missing), 'symlink', 't', missing],
  ['mkdir', () => bridge.mkdir(missing), 'mkdir', missing],
  ['open for writing', () => bridge.open(missing, { write: true, create: true }), 'open', missing],
  ['access', () => bridge.access(missing, 4), 'access', missing],
  ['copyFile onto', () => bridge.copyFile(file, missing), 'copyfile', file, missing],
  ['copyFile from', () => bridge.copyFile(missing, '/home/user/w/g'), 'copyfile', missing, '/home/user/w/g'],
  ['copyTree', () => bridge.copyTree('/home/user/w', missing), 'cp', '/home/user/w', missing],
  ['remove -r', () => bridge.remove(missing, { recursive: true }), 'remove', missing],
  ['unlink', () => bridge.unlink(missing), 'unlink', missing],
  ['rmdir', () => bridge.rmdir(missing), 'rmdir', missing],
  ['rename', () => bridge.rename(missing, '/home/user/w/y'), 'rename', missing, '/home/user/w/y'],
  ['rename onto', () => bridge.rename(file, missing), 'rename', file, missing],
  ['chmod', () => bridge.chmod(missing, 0o644), 'chmod', missing],
  ['chown', () => bridge.chown(missing, 0, 0), 'chown', missing],
  ['utimes', () => bridge.utimes(missing, 1, 1), 'utimes', missing],
  ['truncate', () => bridge.truncate(missing, 0), 'truncate', missing],
  // The engine's own permission refusal, met by a caller it refuses.
  ['writeFile denied', () => user.writeFile('/srv/x', 'x'), 'write', '/srv/x', undefined, 'EACCES'],
  ['mkdir denied', () => user.mkdir('/srv/d'), 'mkdir', '/srv/d', undefined, 'EACCES'],
  ['symlink denied', () => user.symlink('t', '/srv/l'), 'symlink', 't', '/srv/l', 'EACCES'],
];
for (const [label, run, syscall, path, dest, code = 'ENOENT'] of calls) {
  let error;
  try { await run(); } catch (caught) { error = caught; }
  assert.ok(error, `${label}: fails`);
  assert.equal(error.code, code, `${label}: ${error.message}`);
  assert.equal(error.syscall, syscall, `${label}: the call's own syscall (${error.message})`);
  assert.equal(error.path, path, `${label}: the caller's path (${error.message})`);
  assert.equal(error.dest, dest, `${label}: and its second path (${error.message})`);
  assert.doesNotMatch(error.message, /'(home|srv)\//, `${label}: no storage key (${error.message})`);
  assert.match(error.message, new RegExp(`^${code}: .*, ${syscall} '`), `${label}: Node's words (${error.message})`);
}
// A missing name is what a read answers, as before.
assert.equal(bridge.readFile(missing), null);
assert.equal(bridge.stat(missing), null);

console.log(`runtime-fs-bridge-error-paths: ${calls.length} calls name the caller's paths`);
