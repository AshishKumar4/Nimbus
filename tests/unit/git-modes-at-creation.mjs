#!/usr/bin/env bun
// What git makes in a worktree and in its object store has its final mode
// from its creation, whatever the umask: a checked-out file 0644 (0755 when
// executable), a loose object 0444 (an annotated tag's too). Red before: each was made 0666 less the
// umask and changed after, so under umask 0 another principal could write it
// in between.

import assert from 'node:assert/strict';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const REPO = 'home/user/repo';
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const cred = { ...CRED_SESSION_USER, umask: 0 };
const user = vfs.as(cred);
const files = new ProcessFiles(vfs);

async function git(...args) {
  let stderr = '';
  const code = await runGitCommand({
    pid: 1,
    cred,
    args,
    cwd: `/${REPO}`,
    env: { USER: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_EMAIL: 'a@example.com' },
    stdout: { write() {} },
    stderr: { write(s) { stderr += s; } },
    vfs: files.view({ pid: 1, cred }),
  }, vfs);
  assert.equal(code, 0, `git ${args.join(' ')}: ${stderr}`);
}

// A worktree file or a loose object, not git's own bookkeeping (index, refs, logs).
const watched = (path) => !path.startsWith(`${REPO}/.git/`) || path.startsWith(`${REPO}/.git/objects/`);
const writableByOthers = [];
const stopWatching = kernel.subscribe(REPO, (event) => {
  const path = String(event.path).replace(/^\/+/, '');
  if (!watched(path)) return;
  let stat;
  try { stat = kernel.lstat(path); } catch { return; }
  if (stat.type === 'file' && (stat.mode & 0o022) !== 0) writableByOthers.push(`${path} ${(stat.mode & 0o777).toString(8)}`);
});

user.mkdir(REPO, { recursive: true, mode: 0o755 });
user.writeFile(`${REPO}/a.txt`, 'a\n', { mode: 0o644 });
user.writeFile(`${REPO}/run.sh`, '#!/bin/sh\n', { mode: 0o755 });
await git('init', '-q');
await git('add', '-A');
await git('commit', '-q', '-m', 'one');
// Restored by path, then moved between branches: each file made again by a checkout.
user.unlink(`${REPO}/a.txt`);
user.unlink(`${REPO}/run.sh`);
await git('checkout', '--', '.');
await git('checkout', '-q', '-b', 'side');
user.writeFile(`${REPO}/c.txt`, 'c\n', { mode: 0o644 });
user.writeFile(`${REPO}/c.sh`, 'echo c\n', { mode: 0o755 });
await git('add', '-A');
await git('commit', '-q', '-m', 'two');
await git('checkout', '-q', 'master');
await git('checkout', '-q', 'side');
await git('tag', '-a', 'v1', '-m', 'one');
stopWatching();

const modeOf = (path) => kernel.lstat(`${REPO}/${path}`).mode & 0o777;
assert.deepEqual(
  Object.fromEntries(['a.txt', 'run.sh', 'c.txt', 'c.sh'].map((path) => [path, modeOf(path)])),
  { 'a.txt': 0o644, 'run.sh': 0o755, 'c.txt': 0o644, 'c.sh': 0o755 },
  'each checked-out file has its index mode',
);
const objects = [];
for (const dir of kernel.readdir(`${REPO}/.git/objects`)) {
  if (!/^[0-9a-f]{2}$/.test(dir.name)) continue;
  for (const object of kernel.readdir(`${REPO}/.git/objects/${dir.name}`)) objects.push(`${dir.name}/${object.name}`);
}
assert.ok(objects.length > 0, 'the commits wrote loose objects');
const tagObject = new TextDecoder().decode(kernel.readFile(`${REPO}/.git/refs/tags/v1`)).trim();
assert.ok(objects.includes(`${tagObject.slice(0, 2)}/${tagObject.slice(2)}`), 'the annotated tag is a loose object');
assert.deepEqual(objects.filter((object) => modeOf(`.git/objects/${object}`) !== 0o444), [], 'every loose object is 0444');
assert.deepEqual(writableByOthers, [], 'no worktree file or loose object was writable by others at any point');
console.log(`git-modes-at-creation: ok (${objects.length} loose objects)`);
