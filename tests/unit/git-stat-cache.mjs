#!/usr/bin/env bun
// git's stat cache sees what the inode says. A file rewritten with other bytes
// of the same size, its mtime then set back, is still modified: its ctime
// moved. Real git catches that through the index's ctime. Nimbus's git fed
// cf-git ctime = mtime and ino 0, so the rewrite stayed invisible to diff,
// ls-files -m and add -A. And when the stat data of many files changes while
// their content does not, `git status` refreshes the index once, not once
// per file: that is the one-time cost every existing index pays now that the
// real ctime and ino are reported.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const GIT_ENV = {
  PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com',
  GIT_CEILING_DIRECTORIES: tmpdir(),
};

// The VFS stamps inodes with Date.now(): a clock the test moves makes "a later second" exact.
let clock = Date.parse('2026-01-01T00:00:00Z');
Date.now = () => clock;

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const user = vfs.as(CRED_SESSION_USER);

let indexWrites = 0;
const observed = new Proxy(vfs, {
  get(target, key) {
    if (key !== 'as') return Reflect.get(target, key, target);
    return (cred) => {
      const view = target.as(cred);
      return {
        ...view,
        writeFile(path, content, options) {
          if (path.endsWith('/.git/index')) indexWrites++;
          return view.writeFile(path, content, options);
        },
      };
    };
  },
});

async function git(cwd, ...args) {
  let stdout = '';
  let stderr = '';
  const code = await runGitCommand({
    pid: 1, cred: CRED_SESSION_USER, args, cwd, env: { USER: 'a' },
    stdout: { write(s) { stdout += s; } },
    stderr: { write(s) { stderr += s; } },
  }, observed);
  assert.equal(code, 0, `git ${args.join(' ')}: ${stderr}`);
  return stdout;
}

function realGit(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `real git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

const scratch = mkdtempSync(join(tmpdir(), 'nimbus-git-stat-cache-'));
try {
  // ── A same-size rewrite whose mtime is set back, in real git and in Nimbus ──
  const disk = join(scratch, 'repo');
  mkdirSync(disk);
  writeFileSync(join(disk, 'a.txt'), 'aaaa\n');
  writeFileSync(join(disk, 'b.txt'), 'b\n');
  realGit(disk, 'init', '-q', '-b', 'main');
  realGit(disk, 'add', '-A');
  realGit(disk, 'commit', '-q', '-m', 'c');
  const diskMtime = statSync(join(disk, 'a.txt')).mtime;
  Bun.sleepSync(1100);
  writeFileSync(join(disk, 'a.txt'), 'bbbb\n');
  utimesSync(join(disk, 'a.txt'), diskMtime, diskMtime);

  const repo = '/home/user/repo';
  user.mkdir('home/user/repo');
  user.writeFile('home/user/repo/a.txt', 'aaaa\n');
  user.writeFile('home/user/repo/b.txt', 'b\n');
  await git(repo, 'init', '-q');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'c');
  const mtime = user.stat('home/user/repo/a.txt').mtime;
  clock += 5000;
  user.writeFile('home/user/repo/a.txt', 'bbbb\n');
  user.utimes('home/user/repo/a.txt', mtime, mtime);
  assert.equal(user.stat('home/user/repo/a.txt').mtime, mtime, 'the rewrite kept its old mtime');

  for (const args of [['diff', '--name-only'], ['ls-files', '-m'], ['diff', 'HEAD', '--name-status']]) {
    assert.equal(await git(repo, ...args), realGit(disk, ...args), `git ${args.join(' ')}`);
  }
  realGit(disk, 'add', '-A');
  await git(repo, 'add', '-A');
  assert.equal(await git(repo, 'diff', '--cached', '--name-status'), realGit(disk, 'diff', '--cached', '--name-status'));
  assert.equal(await git(repo, 'diff', '--cached', '--name-status'), 'M\ta.txt\n');

  // ── Stat data moves on 2,000 files whose bytes do not: one index write refreshes them all ──
  const many = '/home/user/many';
  user.mkdir('home/user/many');
  for (let i = 0; i < 2000; i++) user.writeFile(`home/user/many/f${i}.txt`, `file ${i}\n`);
  await git(many, 'init', '-q');
  await git(many, 'add', '-A');
  await git(many, 'commit', '-qm', 'c');
  clock += 5000;
  for (let i = 0; i < 2000; i++) user.utimes(`home/user/many/f${i}.txt`, clock, clock);
  indexWrites = 0;
  assert.equal(await git(many, 'status'), 'nothing to commit, working tree clean\n');
  assert.equal(indexWrites, 1, `status refreshing 2,000 entries wrote the index ${indexWrites} times`);
  indexWrites = 0;
  assert.equal(await git(many, 'status'), 'nothing to commit, working tree clean\n');
  assert.equal(await git(many, 'diff'), '');
  assert.equal(indexWrites, 0, 'a refreshed index is not written again');

  console.log('git-stat-cache: a same-size rewrite with its mtime set back is modified, as real git says; 2,000 stat refreshes land in one index write');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
