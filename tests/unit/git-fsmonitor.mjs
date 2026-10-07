#!/usr/bin/env bun
// Git fsmonitor v2 over the existing credential-bound VFS revision feed.
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { makeGitFsmonitor, sqliteGitFsmonitorState } from '../../packages/core/src/runtime/git-fsmonitor.ts';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user/repo/src', { recursive: true });
kernel.mkdir('home/user/repo/.git', { recursive: true });
kernel.writeFile('home/user/repo/src/a', 'one');
const authority = new ProcessFiles(vfs);
const lease = authority.openHost(CRED_SESSION_USER);
const fs = lease.fs;
const state = sqliteGitFsmonitorState(harness.sql, 'fsmonitor-test');
const monitor = makeGitFsmonitor(state);
const query = async (token, options = {}) => {
  const out = await (options.monitor ?? monitor).query({ fs: options.fs ?? fs, cwd: '/home/user/repo', cred: options.cred ?? CRED_SESSION_USER, token, mounts: options.mounts });
  const parts = new TextDecoder().decode(out).split('\0');
  assert.equal(parts.pop(), '', 'NUL-terminated protocol');
  assert.match(parts[0], /^\d+$/, 'the token is a revision, not a timestamp');
  return { token: parts.shift(), paths: parts };
};
try {
  const first = await query('0');
  assert.deepEqual(first.paths, ['/'], 'unknown token invalidates everything');
  assert.deepEqual((await query(first.token)).paths, [], 'no change since the token');
  kernel.writeFile('home/user/repo/src/a', 'two');
  kernel.writeFile('home/user/repo/new\nname.txt', 'new');
  kernel.writeFile('home/user/repo/.git/index', 'index');
  kernel.writeFile('home/user/unrelated', 'outside');
  const changed = await query(first.token);
  assert.deepEqual(changed.paths, ['new\nname.txt', 'src/a'], 'only working-tree changes, newline byte preserved');
  kernel.rename('home/user/repo/src/a', 'home/user/repo/src/b');
  const renamed = await query(changed.token);
  assert.deepEqual(renamed.paths, ['src/a', 'src/b']);
  kernel.unlink('home/user/repo/src/b');
  kernel.rmdir('home/user/repo/src');
  const removed = await query(renamed.token);
  assert.ok(removed.paths.includes('src/'), 'removed directories invalidate their descendants');
  assert.deepEqual((await query('not-a-revision')).paths, ['/']);
  assert.deepEqual((await query(String(Number.MAX_SAFE_INTEGER))).paths, ['/']);
  assert.deepEqual((await query(removed.token, { monitor: makeGitFsmonitor(state) })).paths, [], 'hibernation preserves durable token provenance');
  assert.deepEqual((await query(removed.token, { monitor: makeGitFsmonitor() })).paths, ['/'], 'a host without durable provenance still fails closed');
  const beforePeer = await query(removed.token);
  const peer = authority.openHost(CRED_KERNEL);
  try { await peer.fs.writeFile('/home/user/repo/peer.txt', new TextEncoder().encode('peer')); }
  finally { peer.dispose(); }
  const fromPeer = await query(beforePeer.token, { monitor: makeGitFsmonitor(state) });
  assert.deepEqual(fromPeer.paths, ['peer.txt'], 'another process view is in the same acquired revision feed');
  const mounted = await query(fromPeer.token, { mounts: ['/home/user/repo/vendor', '/outside', '/home/user/repo/.git/objects'] });
  assert.deepEqual(mounted.paths, ['vendor/'], 'every visible external worktree mount is dirty');
  assert.deepEqual((await query(mounted.token, { monitor: makeGitFsmonitor(state), mounts: [] })).paths, ['vendor/'], 'removing a mount cannot make an old token clean');
  kernel.writeFile('home/user/unrelated-next', 'new revision');
  const later = await query(mounted.token, { mounts: [] });
  assert.deepEqual(later.paths, ['vendor/']);
  assert.deepEqual((await query(later.token, { mounts: [] })).paths, [], 'a new revision may retire an old mount footprint');
  assert.deepEqual((await query(later.token, { mounts: ['/home/user/repo'] })).paths, ['/'], 'a repository inside a mount is never falsely clean');
  const unknownMounts = await query(later.token, { mounts: null });
  assert.deepEqual(unknownMounts.paths, ['/']);
  assert.deepEqual((await query(unknownMounts.token, { monitor: makeGitFsmonitor(state), mounts: [] })).paths, ['/'], 'unknown mount provenance survives a wake');
  vfs.rotateIncarnation();
  const reset = await query(removed.token);
  assert.deepEqual(reset.paths, ['/'], 'storage restore invalidates the old epoch');
  assert.deepEqual((await query(reset.token)).paths, ['/'], 'a repeated number cannot revive an old-epoch token');
  kernel.writeFile('home/user/repo/after-restore', 'new clock');
  const fresh = await query(reset.token);
  assert.deepEqual(fresh.paths, ['/']);
  assert.deepEqual((await query(fresh.token)).paths, [], 'new revisions become trusted in the new epoch');
  const bounded = makeGitFsmonitor();
  let revision = 1;
  const many = {
    acquire: async (epoch) => ({
      epoch: 'bounded', rev: revision, poison: epoch !== 'bounded',
      paths: revision === 1 ? [] : Array.from({ length: 5000 }, (_, i) => ({ path: `home/user/repo/file-${i}-${'x'.repeat(30)}`, rev: revision, stat: { type: 'file' } })),
    }),
    revision: async () => revision,
  };
  const before = await query('0', { monitor: bounded, fs: many });
  revision = 2;
  const capped = await query(before.token, { monitor: bounded, fs: many });
  assert.deepEqual(capped.paths, ['/'], 'a large change set is a bounded full invalidation');
  const gap = { ...many, acquire: async () => ({ epoch: 'bounded', rev: 3, paths: [], poison: true }) };
  assert.deepEqual((await query(capped.token, { monitor: bounded, fs: gap })).paths, ['/'], 'a journal gap never answers clean');
  const wakeVfs = new SqliteVFS(harness.sql, harness.ctx);
  const wakeAuthority = new ProcessFiles(wakeVfs);
  const wakeLease = wakeAuthority.openHost(CRED_SESSION_USER);
  try {
    const wake = await query('0', { monitor: makeGitFsmonitor(state), fs: wakeLease.fs });
    assert.deepEqual((await query(wake.token, { monitor: makeGitFsmonitor(state), fs: wakeLease.fs })).paths, [], 'a new VFS host preserves the durable epoch');
  } finally { wakeLease.dispose(); }
  const priorRevision = vfs.revision();
  for (let i = 0; i < 130; i++) state.save(`bounded-${i}`, 'issued-token metadata');
  assert.equal([...harness.sql.exec('SELECT key FROM nimbus_git_fsmonitor')].length, 128, 'durable provenance is bounded by repository count');
  assert.equal(state.load('bounded-0'), null, 'old repository metadata is pruned');
  assert.equal(vfs.revision(), priorRevision, 'issued-token metadata never mutates the VFS watermark');
} finally { lease.dispose(); }
console.log('git-fsmonitor: durable tokens, hibernation/restore, peer writes, mounts and journal gaps passed');
