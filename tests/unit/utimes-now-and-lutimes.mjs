#!/usr/bin/env bun
// utimensat(2) semantics, through the engine, a process's bridge and a
// command's view:
// - times "now" (UTIME_NOW, or NULL) need write permission OR ownership;
//   explicit times need ownership (else EPERM). So a user may touch a
//   root-owned 0666 file, as GNU touch does, but not backdate it.
// - with the final link not followed (lutimes, AT_SYMLINK_NOFOLLOW) the
//   link's own times change and its target's stay.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const code = async (run) => { try { await run(); return 'ok'; } catch (error) { return error.code ?? error.message; } };
const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const kernel = engine.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true });
kernel.chown('home/user', 1000, 1000);
kernel.writeFile('home/user/rootw', 'x');
kernel.chmod('home/user/rootw', 0o666);
kernel.utimes('home/user/rootw', 1000, 1000);
kernel.writeFile('home/user/rootr', 'x');
kernel.chmod('home/user/rootr', 0o644);
const files = new ProcessFiles(engine);
const bridge = files.bind({ pid: 3, cred: USER });
const view = files.view({ pid: 4, cred: USER });
const user = engine.as(USER);

// Now: write permission is enough.
for (const [label, run] of [
  ['engine', () => user.utimes('home/user/rootw', null, null)],
  ['bridge', () => bridge.utimes('/home/user/rootw', null, null)],
  ['view', () => view.utimes('/home/user/rootw', null, null)],
  ['view touch', () => view.touch('/home/user/rootw')],
]) {
  kernel.utimes('home/user/rootw', 1000, 1000);
  assert.equal(await code(run), 'ok', `${label}: now on a writable file it does not own`);
  assert.ok(kernel.stat('home/user/rootw').mtime > 1000, `${label}: set to now`);
}
// Explicit times need ownership; now without write is refused too.
assert.equal(await code(() => bridge.utimes('/home/user/rootw', 5000, 5000)), 'EPERM');
assert.equal(await code(() => view.utimes('/home/user/rootw', 5000, 5000)), 'EPERM');
assert.equal(await code(() => view.utimes('/home/user/rootr', null, null)), 'EACCES');

// lutimes: the link's own times.
await view.writeFile('/home/user/target', 'y');
await view.symlink('target', '/home/user/link');
await view.utimes('/home/user/target', 2000, 2000);
await view.utimes('/home/user/link', 3000, 3000, { follow: false });
assert.equal(kernel.lstat('home/user/link').mtime, 3000, 'the link itself');
assert.equal(kernel.stat('home/user/target').mtime, 2000, 'not its target');
bridge.utimes('/home/user/link', 4000, 4000, { followSymlinks: false });
assert.equal(kernel.lstat('home/user/link').mtime, 4000);
user.utimes('home/user/link', 4500, 4500, { followSymlinks: false });
assert.equal(kernel.lstat('home/user/link').mtime, 4500);
assert.equal(kernel.stat('home/user/target').mtime, 2000);
// A dangling link's own times can be set; following it is ENOENT.
await view.symlink('nowhere', '/home/user/dangling');
assert.equal(await code(() => view.utimes('/home/user/dangling', 6000, 6000, { follow: false })), 'ok');
assert.equal(await code(() => view.utimes('/home/user/dangling', 6000, 6000)), 'ENOENT');

console.log('utimes-now-and-lutimes: ok');
