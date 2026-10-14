#!/usr/bin/env bun
// copyfile as the session makes it (the W7 copyFile call, and keepMode on
// the engine's and the namespace's copies):
// - each name is the file its leaf link leads to, a mount's file included,
//   never a row the mount covers;
// - the receipt vouches for the source's version it copied, in a wave that
//   wrote the source just before;
// - the copy's mode is chmod's to give: the shared directory's admission and
//   its delegated group bits, the confined rule, as chmod judges them;
// - exact on a file the copy makes too, past the umask, on every route;
// - a non-empty copy by a non-root copier clears set-user-ID, and
//   set-group-ID where group-execute is set, as the write after libuv's
//   fchmod does.
import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { testBox } from './lib/test-box.mjs';

const enc = new TextEncoder();
const text = (bytes) => new TextDecoder().decode(bytes);
const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); } catch (error) { results.push(['FAIL', name, String(error.message).split('\n')[0]]); }
};
function engine() {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', USER.uid, USER.gid);
  const user = raw.as(USER);
  user.writeFile('home/user/kept', 'old');
  return { raw, kernel, user };
}
const wave = (files, cred, calls) => files.waves.writeStream(cred, encodeWriteBatchStream({ inodes: [], chunks: [], ops: calls.map((call) => ({ type: 'call', call })) }));

// ── each name is where its leaf link leads, a mount's file over a row it covers ──
await check('a source named by a link into a mount is the mount\'s file, not the row it covers', async () => {
  const { raw, kernel, user } = engine();
  kernel.mkdir('shared');
  kernel.writeFile('shared/m', 'hidden');
  const files = new ProcessFiles(raw);
  const shared = new MemoryVFS();
  shared.writeFile('/m', enc.encode('on the mount'));
  files.vfs.mount('/shared', shared);
  user.symlink('/shared/m', 'home/user/alias');
  const result = await wave(files, user, [{ call: 'copyFile', path: 'home/user/via-alias', from: 'home/user/alias' }]);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(text(user.readFile('home/user/via-alias')), 'on the mount');
});
await check('a destination named by a link into a mount is the mount\'s file', async () => {
  const { raw, user } = engine();
  const files = new ProcessFiles(raw);
  const shared = new MemoryVFS();
  shared.writeFile('/dst', enc.encode('before'));
  files.vfs.mount('/shared', shared);
  user.symlink('/shared/dst', 'home/user/dalias');
  const result = await wave(files, user, [{ call: 'copyFile', path: 'home/user/dalias', from: 'home/user/kept' }]);
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual([text(shared.readFile('/dst')), user.lstat('home/user/dalias').type], ['old', 'symlink']);
});

// ── the receipt vouches for the version copied ──
await check('a copy\'s receipt names the source version it copied, written in the same wave', async () => {
  const { raw, user } = engine();
  const files = new ProcessFiles(raw);
  user.writeFile('home/user/src', 'A');
  const result = await wave(files, user, [
    { call: 'writeFile', path: 'home/user/src', mode: 0o644, data: enc.encode('B') },
    { call: 'copyFile', path: 'home/user/dst', from: 'home/user/src' },
  ]);
  assert.equal(result.ok, true, result.error?.message);
  const copy = result.receipts.find((r) => r.path === 'home/user/dst');
  assert.equal(text(user.readFile('home/user/dst')), 'B');
  assert.deepEqual(copy.from, { path: 'home/user/src', revision: raw.revision('home/user/src') });
});

// ── the copy's mode is chmod's to give ──
await check('over a file beneath a shared directory whose group the copier lacks: EPERM, as chmod', async () => {
  const { raw, kernel, user } = engine();
  kernel.mkdir('team');
  kernel.chown('team', 0, 3000);
  kernel.chmod('team', 0o3777);
  kernel.setDefaultAcl('team', 0o777);
  raw.registerSharedDirectory('team');
  kernel.writeFile('team/own', 'x');
  kernel.chown('team/own', USER.uid, 3000);
  assert.throws(() => user.chmod('team/own', 0o600), { code: 'EPERM' });
  assert.throws(() => user.copyFile('home/user/kept', 'team/own', { keepMode: true }), { code: 'EPERM' });
});
await check('a confined member copying over its own shared file: the delegated group bits are the directory\'s', async () => {
  const { raw, kernel } = engine();
  const A = { uid: 2000, gid: 2000, groups: [2000, 1000], umask: 0o022 };
  kernel.mkdir('tmp/a', { recursive: true });
  kernel.chown('tmp/a', A.uid, A.gid);
  raw.confinePrincipal(A.uid, 'tmp/a');
  kernel.mkdir('team');
  kernel.chown('team', 0, 1000);
  kernel.chmod('team', 0o3775);
  kernel.setDefaultAcl('team', 0o775);
  raw.registerSharedDirectory('team');
  const a = raw.as(A);
  a.writeFile('team/s', 's', { mode: 0o770 });
  a.writeFile('team/t', 't', { mode: 0o660 });
  a.chmod('team/s', 0o770);
  a.chmod('team/t', 0o660);
  const chmodded = (() => { a.chmod('team/t', 0o770); return raw.as(CRED_KERNEL).stat('team/t').mode & 0o7777; })();
  a.chmod('team/t', 0o660);
  a.copyFile('team/s', 'team/t', { keepMode: true });
  assert.equal(raw.as(CRED_KERNEL).stat('team/t').mode & 0o7777, chmodded);
});

// ── exact past the umask on a file the copy makes, on every route ──
await check('a mount\'s 0777 file copied to a new file here is 0777, past the umask', async () => {
  const { raw, user } = engine();
  const files = new ProcessFiles(raw);
  const shared = new MemoryVFS({ uid: USER.uid, gid: USER.gid });
  shared.writeFile('/x', enc.encode('x'), { mode: 0o777 });
  files.vfs.mount('/shared', shared);
  const result = await wave(files, user, [{ call: 'copyFile', path: 'home/user/x', from: 'shared/x' }]);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(user.stat('home/user/x').mode & 0o7777, 0o777);
});
await check('a workspace copy with keepMode takes the source\'s mode over a file there', async () => {
  const box = await testBox({ mounts: {} });
  box.root.mkdir('home/user', { recursive: true });
  box.root.writeFile('home/user/run.sh', '#!/bin/sh\n');
  box.root.chmod('home/user/run.sh', 0o755);
  box.root.writeFile('home/user/t600', 'old');
  box.root.chmod('home/user/t600', 0o600);
  for (const path of ['home/user', 'home/user/run.sh', 'home/user/t600']) box.root.chown(path, 1000, 1000);
  await box.fs.copy('/home/user/run.sh', '/home/user/t600', { keepMode: true });
  assert.equal(box.root.stat('home/user/t600').mode & 0o7777, 0o755);
  box.destroy();
});

// ── set-ID bits, as the copy's write leaves them ──
await check('a non-root copier\'s copy of a non-empty set-ID file clears them; root\'s keeps them', async () => {
  const { kernel, user } = engine();
  kernel.writeFile('home/user/suid', 'binary');
  kernel.chown('home/user/suid', USER.uid, USER.gid);
  kernel.chmod('home/user/suid', 0o6755);
  user.copyFile('home/user/suid', 'home/user/copied', { keepMode: true });
  kernel.copyFile('home/user/suid', 'home/user/rooted', { keepMode: true });
  assert.deepEqual([user.stat('home/user/copied').mode & 0o7777, kernel.stat('home/user/rooted').mode & 0o7777], [0o755, 0o6755]);
});

for (const r of results) console.error(r.join('  '));
if (results.some((r) => r[0] === 'FAIL')) process.exit(1);
console.log('copy-file-call: ok');
