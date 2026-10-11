#!/usr/bin/env bun
// The one `git`, with real git installed beside it: each invocation goes to
// the built-in git or to real git, chosen before either runs.
//   - what the built-in git implements runs there, `-c` and `-C` included;
//   - what it lacks (a command, an option, a leading option it does not
//     take) runs on real git, with the invocation as it was given;
//   - a git real git started (its environment says so) is real git;
//   - with no real git, the built-in git answers everything itself.

import assert from 'node:assert/strict';

import { CRED_KERNEL, CRED_SESSION_USER, GIT_WASI_ENV } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
vfs.as(CRED_KERNEL).mkdir('home/user', { recursive: true, mode: 0o755 });
vfs.as(CRED_KERNEL).chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const files = new ProcessFiles(vfs);

/** `git <args>` through the front door; `real` is whether real git is installed. What real git was handed, if anything. */
async function git(args, { real = true, env = {} } = {}) {
  let stdout = '';
  let stderr = '';
  const handed = [];
  const code = await runGitCommand({
    pid: 1, cred: CRED_SESSION_USER, args, cwd: '/home/user', env,
    stdout: { write(s) { stdout += s; }, writeBytes(b) { stdout += Buffer.from(b).toString('utf8'); } },
    stderr: { write(s) { stderr += s; } },
    vfs: files.view({ pid: 1, cred: CRED_SESSION_USER }),
    signal: new AbortController().signal,
  }, vfs, undefined, undefined, undefined, undefined, undefined, real ? async () => { handed.push([...args]); return 7; } : undefined);
  return { code, stdout, stderr, real: handed };
}

// The built-in git's own: it runs them, real git is not asked.
assert.equal((await git(['init', '-q', 'repo'])).code, 0);
for (const args of [
  ['-C', 'repo', 'status', '--porcelain'],
  ['-C', 'repo', '-c', 'user.name=Ada', 'config', 'user.name'],
  ['--version'],
  ['-C', 'repo', 'log', '--oneline', '-n', '1'],
  ['-C', 'repo', 'commit', '-m', '--amend', '--allow-empty', '-q'],
]) {
  const ran = await git(args);
  assert.deepEqual(ran.real, [], `${args.join(' ')}: the built-in git's`);
  assert.notEqual(ran.code, 7, args.join(' '));
}
assert.equal((await git(['-C', 'repo', '-c', 'user.name=Ada', 'config', 'user.name'])).stdout, 'Ada\n', '-c reaches the built-in git');

// What the built-in git lacks is real git's, the invocation untouched.
for (const args of [
  ['-C', 'repo', 'stash', 'push'],
  ['-C', 'repo', 'rebase', '-i', 'HEAD~1'],
  ['-C', 'repo', 'commit', '--amend', '-m', 'again'],
  ['-C', 'repo', 'log', '--graph'],
  ['-C', 'repo', 'merge', '--ff-only', 'topic'],
  ['-C', 'repo', 'show', 'HEAD'],
  ['-C', 'repo', 'switch', 'main'],
  ['--git-dir=repo/.git', 'status'],
  ['-C', 'repo', 'worktree', 'list'],
]) {
  const ran = await git(args);
  assert.deepEqual(ran.real, [args], `${args.join(' ')}: real git's`);
  assert.equal(ran.code, 7, 'its exit status is the command\'s');
}

// A git real git started is real git, whatever it runs.
assert.deepEqual((await git(['-C', 'repo', 'status'], { env: { [GIT_WASI_ENV]: '1' } })).real, [['-C', 'repo', 'status']]);

// Without real git, the built-in git answers everything itself.
const alone = await git(['-C', 'repo', 'stash', 'push'], { real: false });
assert.deepEqual(alone.real, []);
assert.notEqual(alone.code, 0, 'a command it lacks is its own refusal');
const unknownOption = await git(['--git-dir=repo/.git', 'status'], { real: false });
assert.equal(unknownOption.code, 129);
assert.match(unknownOption.stderr, /unknown option/);

console.log('git-routing: built-in, real git, its children, and git alone');
