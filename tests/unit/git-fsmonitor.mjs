#!/usr/bin/env bun
// Git fsmonitor v2 over the existing credential-bound VFS revision feed.
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { makeGitFsmonitor } from '../../packages/core/src/runtime/git-fsmonitor.ts';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user/repo/src', { recursive: true });
kernel.mkdir('home/user/repo/.git', { recursive: true });
kernel.writeFile('home/user/repo/src/a', 'one');
const authority = new ProcessFiles(vfs);
const lease = authority.openHost(CRED_SESSION_USER);
const fs = lease.fs;
const monitor = makeGitFsmonitor();
const query = async (token, options = {}) => {
  const out = await (options.monitor ?? monitor).query({ fs: options.fs ?? fs, cwd: '/home/user/repo', cred: options.cred ?? CRED_SESSION_USER, token });
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
  assert.deepEqual((await query(removed.token, { monitor: makeGitFsmonitor() })).paths, ['/'], 'hibernation loses token provenance');
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
} finally { lease.dispose(); }
console.log('git-fsmonitor: revision feed, NUL protocol, rename/delete and incarnation trust passed');
