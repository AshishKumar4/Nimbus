#!/usr/bin/env bun
// Which git answers each form, with real git installed: the routing table.
//   - every form the built-in git runs as git does (the hot plain forms:
//     status, add, diff, plain commit and checkout, ...) is the built-in's;
//   - every form main's built-in mis-ran (it ignored an option or operand)
//     and every form it never ran is real git's, handed over before any
//     effect with the invocation untouched (LittleButterfly's inventory of
//     main vs this branch, lists A and B);
//   - a sparse-checkout the built-in implements stays the built-in's;
//   - a form whose message git takes from an editor (a commit with no -m,
//     an annotated tag with no -m or -F, a merge or pull with
//     GIT_MERGE_AUTOEDIT) is real git's, which runs the editor; the
//     built-in made a message up;
//   - a command whose hooks (githooks(5)) the repository makes executable
//     is real git's: the built-in runs no hook. Where git looks for them
//     (core.hooksPath, a relative one from the worktree's top) is honored,
//     and a hook that is not executable is not run by git either. status
//     and diff, which write an index only if able, stay the built-in's and
//     keep no refresh where writing it would run post-index-change.

import assert from 'node:assert/strict';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
vfs.as(CRED_KERNEL).mkdir('home/user', { recursive: true, mode: 0o755 });
vfs.as(CRED_KERNEL).chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const files = new ProcessFiles(vfs);
const user = vfs.as(CRED_SESSION_USER);

/** `git <words>` in repo through the front door, real git installed, in `env`: who answered. */
async function engine(words, env = {}) {
  const args = ['-C', 'repo', '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', ...words];
  const handed = [];
  let stdout = '';
  let stderr = '';
  await runGitCommand({
    pid: 1, cred: CRED_SESSION_USER, args, cwd: '/home/user', env,
    stdout: { write(s) { stdout += s; }, writeBytes(b) { stdout += Buffer.from(b).toString('utf8'); } },
    stderr: { write(s) { stderr += s; } },
    vfs: files.view({ pid: 1, cred: CRED_SESSION_USER }),
    signal: new AbortController().signal,
  }, vfs, undefined, undefined, undefined, undefined, undefined, async () => {
    assert.equal(stdout + stderr, '', `${words.join(' ')}: nothing of the built-in's before the handoff`);
    handed.push([...args]);
    return 0;
  });
  if (handed.length === 0) return 'built-in';
  assert.deepEqual(handed, [args], `${words.join(' ')}: the invocation reaches real git untouched`);
  return 'real git';
}

// A repository with a commit, a branch and a remote, as the forms expect.
async function setup() {
  const plain = async (words) => {
    const handed = [];
    const code = await runGitCommand({
      pid: 1, cred: CRED_SESSION_USER, args: ['-C', 'repo', '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', ...words], cwd: '/home/user', env: {},
      stdout: { write() {}, writeBytes() {} }, stderr: { write() {} },
      vfs: files.view({ pid: 1, cred: CRED_SESSION_USER }), signal: new AbortController().signal,
    }, vfs, undefined, undefined, undefined, undefined, undefined, async () => { handed.push(words); return 0; });
    assert.equal(code, 0, words.join(' '));
    assert.deepEqual(handed, [], words.join(' '));
  };
  user.mkdir('home/user/repo', { recursive: true });
  await plain(['init', '-q', '-b', 'main']);
  user.writeFile('home/user/repo/a.txt', 'one\n');
  user.writeFile('home/user/repo/msg.txt', 'from a file\n');
  await plain(['add', 'a.txt']);
  await plain(['commit', '-q', '-m', 'first']);
  await plain(['branch', 'topic']);
  await plain(['remote', 'add', 'origin', 'https://example.com/repo.git']);
}
await setup();

// The built-in's: forms main ran as git does.
const BUILT_IN = [
  ['status'], ['status', '--porcelain'], ['status', '-s'], ['status', '-sz'], ['status', '--porcelain=v1', '-uno'],
  ['add', 'a.txt'], ['add', '-A'], ['add', '.'], ['add', '-u'], ['add', '-n', 'a.txt'],
  ['diff'], ['diff', '--stat'], ['diff', '--cached'], ['diff', '--name-only'], ['diff', 'HEAD'],
  ['commit', '-m', 'x', '--allow-empty'], ['commit', '-qam', 'x', '--allow-empty'], ['commit', '--allow-empty', '-m', '--amend'],
  ['checkout', 'topic'], ['checkout', '-b', 'fresh'], ['checkout', '--', 'a.txt'], ['checkout', 'main', '--', 'a.txt'],
  ['log'], ['log', '--oneline'], ['log', '-n', '5'], ['log', '-3'], ['log', '--max-count=2', '--oneline'],
  ['branch'], ['branch', 'another'], ['branch', '-D', 'another'], ['branch', '--show-current'],
  ['tag', 'v1'], ['tag'], ['tag', '-d', 'v1'],
  ['remote'], ['remote', '-v'], ['remote', 'add', 'up', 'https://example.com/up.git'], ['remote', 'remove', 'up'],
  ['config', 'core.editor', 'vi'], ['config', 'core.editor'], ['config', '--unset', 'core.editor'],
  ['rev-parse', 'HEAD'], ['rev-parse', '--abbrev-ref', 'HEAD'], ['rev-parse', '--show-toplevel'],
  ['ls-files'], ['ls-files', '-s'],
  ['reset', '--hard', 'HEAD'], ['reset', '--soft', 'HEAD'], ['reset', 'a.txt'],
  ['merge', 'topic'], ['merge', '--no-edit', 'topic'],
  ['fetch', 'origin'], ['pull', 'origin', 'main'], ['push', 'origin', 'main'],
  ['tag', '-a', '-m', 'x', 'v2'], ['tag', '-m', 'x', 'v3'], ['tag', '-aF', 'msg.txt', 'v4'],
  ['sparse-checkout', 'list'],
];

// Real git's: lists A and B (main mis-ran them) and commands the built-in never ran.
const REAL_GIT = [
  // commit
  ['commit', '--amend', '-m', 'x'], ['commit', '--no-verify', '-m', 'x'], ['commit', '-n', '-m', 'x'], ['commit', '-m', 'x', 'a.txt'],
  ['commit', '-m', 'x', '--', 'a.txt'], ['commit', '-F', 'msg.txt'], ['commit', '-s', '-m', 'x'], ['commit', '-S', '-m', 'x'],
  ['commit', '--author=A <a@b>', '-m', 'x'], ['commit', '--date=2020-01-01', '-m', 'x'], ['commit', '--reset-author', '-m', 'x'],
  ['commit', '--dry-run', '-m', 'x'], ['commit', '-v', '-m', 'x'],
  // log
  ['log', 'main'], ['log', 'main..topic'], ['log', '--', 'a.txt'], ['log', '--all'], ['log', '--decorate'],
  ['log', '--pretty=format:%s'], ['log', '--since=2020-01-01'], ['log', '--author=Ada'], ['log', '--grep=x'], ['log', '--graph', '--oneline'],
  ['log', '--stat'], ['log', '-p'], ['log', '--reverse'], ['log', '--no-merges'],
  // branch
  ['branch', '-d', 'topic'], ['branch', '--list', 'top*'], ['branch', 'new', 'topic'], ['branch', '-D', 'topic', 'other'],
  ['branch', '-m', 'renamed'], ['branch', '-vv'], ['branch', '--show-current', 'extra'],
  // checkout
  ['checkout', '-b', 'fresh2', 'topic'], ['checkout', '-f', 'topic'], ['checkout', '--detach', 'topic'], ['checkout', '--ours', '--', 'a.txt'],
  ['checkout', '--theirs', '--', 'a.txt'], ['checkout', '-B', 'main'], ['checkout', '--track', 'origin/main'], ['checkout', 'topic', 'extra'],
  // remote
  ['remote', 'set-url', 'origin', 'https://example.com/new.git'], ['remote', 'show', 'origin'], ['remote', 'rename', 'origin', 'upstream'],
  ['remote', 'update'], ['remote', 'prune', 'origin'], ['remote', 'get-url', 'origin'],
  // transport
  ['fetch', 'origin', 'main'], ['fetch', 'origin', '--prune'], ['fetch', 'origin', '--tags'], ['fetch', '--all'], ['fetch', '--unshallow=x', 'origin'],
  ['pull', 'origin', 'main', '--rebase'], ['pull', '--ff-only', 'origin', 'main'], ['pull', 'origin', 'main', '--no-rebase'], ['pull', 'origin', 'main', 'other'],
  ['push', 'origin', 'main', '-u'], ['push', 'origin', 'main', '--set-upstream'], ['push', 'origin', 'main', '--force'],
  ['push', 'origin', 'main', '--force-with-lease'], ['push', 'origin', 'main', '--tags'], ['push', 'origin', 'main', '--delete'], ['push', 'origin', 'main', 'other'],
  // merge
  ['merge', '--ff-only', 'topic'], ['merge', '--no-ff', 'topic'], ['merge', '--squash', 'topic'], ['merge', '--no-commit', 'topic'],
  ['merge', '-s', 'ours', 'topic'], ['merge', '-X', 'theirs', 'topic'], ['merge', 'topic', 'main'],
  // tag, status, add, diff
  ['tag', '-F', '-', 'v2'], ['status', '--short=x'], ['status', '-sb'], ['status', '--porcelain=v2'], ['add', '--all=x'], ['add', '-p'], ['add', '-N', 'a.txt'],
  ['diff', '-p', '--stat'], ['diff', 'main', 'topic'],
  // commands the built-in never ran
  ['stash'], ['stash', 'pop'], ['rebase', 'main'], ['switch', 'topic'], ['restore', 'a.txt'], ['show', 'HEAD'], ['blame', 'a.txt'],
  ['cherry-pick', 'topic'], ['revert', 'HEAD'], ['worktree', 'list'], ['reflog'], ['gc'], ['bisect', 'start'], ['notes', 'list'],
  // a message from an editor
  ['commit'], ['commit', '-a'], ['commit', '-q', '--allow-empty'], ['commit', '--allow-empty-message', '--allow-empty'], ['commit', '--cleanup=strip', '-a'],
  ['tag', '-a', 'v5'], ['tag', '--annotate', 'v5', 'HEAD'],
];

// GIT_MERGE_AUTOEDIT: git's merge (and a pull's) takes its message from an editor, unless --no-edit.
const AUTOEDIT = [
  [{ GIT_MERGE_AUTOEDIT: 'yes' }, ['merge', 'topic'], 'real git'],
  [{ GIT_MERGE_AUTOEDIT: 'true' }, ['pull', 'origin', 'main'], 'real git'],
  [{ GIT_MERGE_AUTOEDIT: 'yes' }, ['merge', '--no-edit', 'topic'], 'built-in'],
  [{ GIT_MERGE_AUTOEDIT: 'no' }, ['merge', 'topic'], 'built-in'],
  [{ GIT_MERGE_AUTOEDIT: 'false' }, ['pull', 'origin', 'main'], 'built-in'],
];

const wrong = [];
for (const words of BUILT_IN) if (await engine(words) !== 'built-in') wrong.push(`built-in expected: git ${words.join(' ')}`);
for (const words of REAL_GIT) if (await engine(words) !== 'real git') wrong.push(`real git expected: git ${words.join(' ')}`);
for (const [env, words, who] of AUTOEDIT) if (await engine(words, env) !== who) wrong.push(`${who} expected: ${JSON.stringify(env)} git ${words.join(' ')}`);

// Hooks: each case writes one hook where git looks for it, then asks who answers each form.
const HOOKS = [
  // [hook, its directory in the repository, executable, config to set, [form, who]...]
  ['pre-commit', '.git/hooks', true, null, [['commit', '-m', 'x', '--allow-empty'], 'real git'], [['status'], 'built-in'], [['add', 'a.txt'], 'built-in']],
  ['pre-commit', '.git/hooks', false, null, [['commit', '-m', 'x', '--allow-empty'], 'built-in']],
  ['commit-msg', '.git/hooks', true, null, [['commit', '-m', 'x', '--allow-empty'], 'real git'], [['merge', 'topic'], 'real git'], [['checkout', 'topic'], 'built-in']],
  ['post-checkout', '.git/hooks', true, null, [['checkout', 'topic'], 'real git'], [['commit', '-m', 'x', '--allow-empty'], 'built-in']],
  ['post-merge', '.git/hooks', true, null, [['merge', 'topic'], 'real git'], [['pull', 'origin', 'main'], 'real git'], [['fetch', 'origin'], 'built-in']],
  ['pre-push', '.git/hooks', true, null, [['push', 'origin', 'main'], 'real git'], [['fetch', 'origin'], 'built-in']],
  // status and diff write an index only if able: the built-in's, writing none (below).
  ['post-index-change', '.git/hooks', true, null, [['add', 'a.txt'], 'real git'], [['reset', 'a.txt'], 'real git'], [['status'], 'built-in'], [['diff'], 'built-in'], [['log'], 'built-in']],
  ['reference-transaction', '.git/hooks', true, null, [['branch', 'more'], 'real git'], [['tag', 'v9'], 'real git'], [['fetch', 'origin'], 'real git'], [['status'], 'built-in'], [['rev-parse', 'HEAD'], 'built-in']],
  ['pre-commit', 'githooks', true, ['core.hooksPath', 'githooks'], [['commit', '-m', 'x', '--allow-empty'], 'real git']],
  ['pre-commit', '.git/hooks', true, ['core.hooksPath', 'githooks'], [['commit', '-m', 'x', '--allow-empty'], 'built-in']],
];
for (const [hook, dir, executable, config, ...forms] of HOOKS) {
  const path = `home/user/repo/${dir}/${hook}`;
  user.mkdir(`home/user/repo/${dir}`, { recursive: true });
  user.writeFile(path, '#!/bin/sh\nexit 0\n');
  user.chmod(path, executable ? 0o755 : 0o644);
  if (config) user.writeFile('home/user/repo/.git/config', user.readFileString('home/user/repo/.git/config') + `[core]\n\thooksPath = ${config[1]}\n`);
  for (const [words, who] of forms) {
    if (await engine(words) !== who) wrong.push(`${who} expected with ${executable ? 'an executable' : 'a non-executable'} ${dir}/${hook}${config ? ` (${config.join(' = ')})` : ''}: git ${words.join(' ')}`);
  }
  user.unlink(path);
  if (config) user.writeFile('home/user/repo/.git/config', user.readFileString('home/user/repo/.git/config').replace(`[core]\n\thooksPath = ${config[1]}\n`, ''));
}
// The refresh a status or diff writes back runs post-index-change in git:
// where that hook is executable the built-in keeps none, as git keeps none
// it cannot lock, and so runs no hook. Without it, the refresh is kept.
const index = 'home/user/repo/.git/index';
const indexChange = 'home/user/repo/.git/hooks/post-index-change';
let later = Date.now() + 60_000;
// a.txt's stat moves on, its content does not: the refresh is due.
const touch = () => { later += 1000; user.utimes('home/user/repo/a.txt', later, later); };
assert.equal(await engine(['add', 'a.txt']), 'built-in');
user.writeFile(indexChange, '#!/bin/sh\nexit 0\n');
user.chmod(indexChange, 0o755);
for (const words of [['status'], ['diff']]) {
  const before = user.readFile(index);
  touch();
  if (await engine(words) !== 'built-in') wrong.push(`built-in expected with an executable post-index-change: git ${words.join(' ')}`);
  else if (Buffer.compare(user.readFile(index), before) !== 0) wrong.push(`git ${words.join(' ')} wrote the index with an executable post-index-change`);
}
user.unlink(indexChange);
for (const words of [['status'], ['diff']]) {
  const before = user.readFile(index);
  touch();
  assert.equal(await engine(words), 'built-in');
  if (Buffer.compare(user.readFile(index), before) === 0) wrong.push(`git ${words.join(' ')} kept no refresh, with no hook`);
}
assert.deepEqual(wrong, [], wrong.join('\n'));
console.log(`git-routing-table: ${BUILT_IN.length} forms built-in, ${REAL_GIT.length} real git, ${HOOKS.length} hook cases`);
