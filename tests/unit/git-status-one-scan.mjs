#!/usr/bin/env bun
// `git status` reads the worktree in one ordered scan of the session's
// filesystem, not a listing per directory and an lstat per file: on
// next.js's 34,302 files those were 51,000 separate calls, all of status's
// 3.5 s on a session's thread. The scan is in path order, which is the
// index's, so it merges with the index in one pass; and what it answers is
// what real git answers on the same tree.
//
// Red before: the counters said readdirs and lstats, one per directory and
// one per file. A sibling whose name extends the worktree's (repo-backup,
// repo.old) sorts between it and its entries: the scan passes it.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';

const FILES = 3_000;
const scratch = mkdtempSync(join(tmpdir(), 'nimbus-git-status-one-scan-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
const ENV = {
  HOME: '/home/user', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com', GIT_COMMITTER_DATE: '1700000000 +0000',
};
const GIT_ENV = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', GIT_CEILING_DIRECTORIES: tmpdir(), ...ENV, HOME: '/nonexistent' };
const realGit = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.toString('latin1');
};

const db = new Database(':memory:');
const vfs = new SqliteVFS({
  exec(query, ...params) {
    const prepared = db.query(query);
    if (prepared.columnNames.length === 0) { db.run(query, ...params); return []; }
    return prepared.all(...params);
  },
}, { storage: { transactionSync: (callback) => db.transaction(callback)() } });
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const user = vfs.as(CRED_SESSION_USER);
const root = 'home/user/repo';
const disk = join(scratch, 'repo');
mkdirSync(disk);
realGit(disk, 'init', '-q', '-b', 'main');
user.mkdir(root, { recursive: true });
const write = (file, content) => {
  mkdirSync(join(disk, file, '..'), { recursive: true });
  writeFileSync(join(disk, file), content);
  user.mkdir(`${root}/${file.slice(0, file.lastIndexOf('/'))}`, { recursive: true });
  user.writeFile(`${root}/${file}`, content);
};
// Siblings whose names extend the worktree's sort between it and its entries: the scan passes them.
user.mkdir('home/user/repo-backup/deep', { recursive: true });
user.writeFile('home/user/repo-backup/deep/f', 'sibling');
user.writeFile('home/user/repo.old', 'sibling');
// Two files a directory, four levels deep, and names that sort across '/': a-b, a/b, a.b, a0.
for (let i = 0; i < FILES; i++) { const d = Math.floor(i / 2); write(`src/a${d % 16}/b${Math.floor(d / 16) % 64}/f${i}.txt`, `file ${i}\n`); }
for (const name of ['x/a-b', 'x/a/b', 'x/a.b', 'x/a0', 'x/a/c/d']) write(name, `${name}\n`);

const view = new ProcessFiles(vfs).view({ pid: 1, cred: CRED_SESSION_USER });
const git = async (...args) => {
  let stdout = '';
  let stderr = '';
  const code = await runGitCommand({
    pid: 1, cred: CRED_SESSION_USER, args, cwd: `/${root}`, env: { ...ENV, NIMBUS_GIT_COUNTERS: '1' },
    stdout: { write(s) { stdout += s; }, writeBytes(b) { stdout += Buffer.from(b).toString('latin1'); } },
    stderr: { write(s) { stderr += s; } },
    vfs: view,
  }, vfs);
  assert.equal(code, 0, `git ${args.join(' ')}: ${stderr}`);
  const counters = JSON.parse(/\[git\] (\{.*\})/.exec(stderr)?.[1] ?? '{}');
  return { stdout, counters };
};
await git('init', '-q');
await git('add', '-A');
await git('commit', '-q', '-m', 'seed');
realGit(disk, 'add', '-A');
realGit(disk, 'commit', '-q', '-m', 'seed');

// A change of each kind: modified, deleted, untracked at depth, a new directory.
for (const [file, content] of [['src/a1/b0/f2.txt', 'changed\n'], ['x/a/c/e', 'new\n'], ['y/z/w', 'new\n']]) write(file, content);
user.unlink(`${root}/x/a.b`);
rmSync(join(disk, 'x/a.b'));

const { stdout, counters } = await git('status', '--porcelain', '-uall');
assert.equal(stdout, realGit(disk, 'status', '--porcelain', '-uall'), 'what real git answers on the same tree');
// One readdir: the top's, which the scan's own listing of the top is checked against.
assert.deepEqual({ readdirs: counters.readdirs, lstats: counters.lstats, scans: counters.scans }, { readdirs: 1, lstats: 0, scans: 1 }, `one scan, no call per path: ${JSON.stringify(counters)}`);
assert.ok(counters.scanned >= FILES, `every entry came from the scan: ${JSON.stringify(counters)}`);
console.log(`  ✓ git status on ${FILES + 5} files: one ordered scan (${counters.scanned} entries), real git's answer`);
// Untracked directories judged as the scan passes them: -unormal lists each one as itself, -uno none.
for (const flags of [[], ['-uno']]) {
  assert.equal((await git('status', '--porcelain', ...flags)).stdout, realGit(disk, 'status', '--porcelain', ...flags), `status ${flags.join(' ')} as real git's`);
}
console.log('git-status-one-scan: ok');
