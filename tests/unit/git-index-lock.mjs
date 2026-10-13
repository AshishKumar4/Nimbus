#!/usr/bin/env bun
// The index is one repository's, written by one command at a time: a git
// status that read it, then refreshed stat data while a git add staged a new
// file, must not write back the index it read and so unstage that file; and
// adds that run at once must each keep the others' entries.

import assert from 'node:assert/strict';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
vfs.as(CRED_KERNEL).mkdir('home/user', { recursive: true, mode: 0o755 });
vfs.as(CRED_KERNEL).chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const user = vfs.as(CRED_SESSION_USER);
const files = new ProcessFiles(vfs);
const root = '/home/user/repo';

/** Run git; `view` is the command's filesystem (a gated one, to stop it mid-walk). */
async function git(args, view = files.view({ pid: 1, cred: CRED_SESSION_USER }), { expect = 0 } = {}) {
  let stdout = '';
  let stderr = '';
  const code = await runGitCommand({
    pid: 1, cred: CRED_SESSION_USER, args, cwd: root,
    env: { HOME: '/home/user', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' },
    stdout: { write(s) { stdout += s; }, writeBytes(b) { stdout += Buffer.from(b).toString(); } },
    stderr: { write(s) { stderr += s; } },
    vfs: view,
  }, vfs);
  assert.equal(code, expect, `git ${args.join(' ')}: ${stderr}`);
  return stdout;
}

user.mkdir('home/user/repo/d', { recursive: true });
for (let i = 0; i < 20; i++) user.writeFile(`home/user/repo/d/f${i}`, `file ${i}\n`);
await git(['init', '-q']);
await git(['add', '-A']);
await git(['commit', '-q', '-m', 'seed']);
// A second later every entry is old enough to be trusted; rewriting one with the same bytes gives
// status a stat refresh to write back.
await Bun.sleep(1100);
await git(['status', '--porcelain']);
await Bun.sleep(1100);
user.writeFile('home/user/repo/d/f3', 'file 3\n');

// 1. status reads the index, then stops at its first readdir; add stages new.txt meanwhile.
user.writeFile('home/user/repo/new.txt', 'new\n');
let open;
const gate = new Promise((resolve) => { open = resolve; });
let reached;
const atGate = new Promise((resolve) => { reached = resolve; });
const base = files.view({ pid: 2, cred: CRED_SESSION_USER });
let held = false;
const gated = new Proxy(base, {
  get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key !== 'readdir' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
    return async (...args) => {
      if (!held) {
        held = true;
        reached();
        await gate;
      }
      return await value.apply(target, args);
    };
  },
});
const status = git(['status', '--porcelain'], gated);
await atGate;
await git(['add', 'new.txt']);
open();
assert.equal(await status, '?? new.txt\n', 'status saw the worktree as it read the index');
assert.equal(await git(['ls-files', '--', 'new.txt']), 'new.txt\n', 'the add survives the status that read the index before it');
assert.equal(await git(['status', '--porcelain']), 'A  new.txt\n');

// 2. Adds at once: each one's entry stays.
for (let i = 0; i < 10; i++) user.writeFile(`home/user/repo/n${i}.txt`, `n${i}\n`);
await Promise.all(Array.from({ length: 10 }, (_, i) => git(['add', `n${i}.txt`], files.view({ pid: 10 + i, cred: CRED_SESSION_USER }))));
const staged = (await git(['status', '--porcelain'])).split('\n').filter((line) => /^A  n\d\.txt$/.test(line));
assert.equal(staged.length, 10, `ten adds at once staged ${staged.length} of ten`);

// A lock held by another implementation is never overwritten or removed.
const index = user.readFile('home/user/repo/.git/index');
user.writeFile('home/user/repo/.git/index.lock', 'real git owns this lock');
user.writeFile('home/user/repo/locked.txt', 'locked\n');
await git(['add', 'locked.txt'], undefined, { expect: 128 });
assert.equal(user.readFileString('home/user/repo/.git/index.lock'), 'real git owns this lock');
assert.deepEqual(user.readFile('home/user/repo/.git/index'), index);
await git(['status', '--porcelain']);
assert.equal(user.readFileString('home/user/repo/.git/index.lock'), 'real git owns this lock', 'a refresh skips a busy index');
user.unlink('home/user/repo/.git/index.lock');

// Exclusive creation protects the real git side; publication is a rename,
// so a failed write leaves the old index and releases only our own lock.
const calls = [];
const failing = new Proxy(files.view({ pid: 22, cred: CRED_SESSION_USER }), {
  get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    return async (...args) => {
      if (key === 'writeFile' && args[0].endsWith('/index.lock')) {
        calls.push(args[2]);
        if (args[1].length) throw new Error('injected index write failure');
      }
      return await value.apply(target, args);
    };
  },
});
await git(['add', 'locked.txt'], failing, { expect: 128 });
assert.deepEqual(user.readFile('home/user/repo/.git/index'), index);
assert.equal(user.exists('home/user/repo/.git/index.lock'), false, 'our failed lock is removed');
assert.equal(calls[0].exclusive, true, 'lock creation is exclusive, not an exists check');
await git(['add', 'locked.txt']);
assert.equal(user.exists('home/user/repo/.git/index.lock'), false, 'successful publication consumes the lock');
assert.equal(await git(['ls-files', '--', 'locked.txt']), 'locked.txt\n');
console.log('git-index-lock: a status refresh never writes over an add; ten adds at once keep all ten');
