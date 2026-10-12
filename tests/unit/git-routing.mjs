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
import { encodeIndexFile } from '../../packages/worker/src/git/worktree/dircache.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { stagedAssets } from './lib/staged-assets.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
vfs.as(CRED_KERNEL).mkdir('home/user', { recursive: true, mode: 0o755 });
vfs.as(CRED_KERNEL).chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const files = new ProcessFiles(vfs);
const user = vfs.as(CRED_SESSION_USER);

/** `git <args>` through the front door; `real` is whether real git is installed. What real git was handed, if anything. */
async function git(args, { real = true, env = {}, view, status = 7, doCtx, doEnv, stdoutError, signal = new AbortController().signal } = {}) {
  let stdout = '';
  let stderr = '';
  const handed = [];
  const code = await runGitCommand({
    pid: 1, cred: CRED_SESSION_USER, args, cwd: '/home/user', env,
    stdout: { write(s) { if (stdoutError) throw stdoutError; stdout += s; }, writeBytes(b) { if (stdoutError) throw stdoutError; stdout += Buffer.from(b).toString('utf8'); } },
    stderr: { write(s) { stderr += s; } },
    vfs: view ?? files.view({ pid: 1, cred: CRED_SESSION_USER }),
    signal,
  }, vfs, doCtx, doEnv, undefined, undefined, undefined, real ? async () => {
    assert.equal(stdout, '', 'no built-in output before handoff');
    assert.equal(stderr, '', 'no built-in diagnostic before handoff');
    handed.push([...args]);
    return status;
  } : undefined);
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

const identity = ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.com'];
const inRepo = ['-C', 'repo'];
assert.equal((await git([...inRepo, ...identity, 'commit', '-qamseed', '--allow-empty'])).code, 0);
assert.equal((await git([...inRepo, 'tag', 'seed'])).code, 0);
const indexBefore = user.readFile('home/user/repo/.git/index');
const headBefore = user.readFile('home/user/repo/.git/refs/heads/master');
user.writeFile('home/user/repo/f', 'unstaged\n');
user.copyTree('home/user/repo/.git', 'home/user/bare');
const bareDiff = ['-C', 'bare', 'diff', 'HEAD', 'HEAD'];
assert.deepEqual((await git(bareDiff)).real, [bareDiff], 'two-commit diff is unsupported in a bare repository too');

// Every command's parser owns its capability boundary, including later
// letters in clusters and flags after operands on mutating commands.
const unsupported = [
  ['init', '--shared', 'not-created'],
  ['clone', '--filter=object:type=blob', 'https://example.com/repo', 'not-cloned'],
  ['clone', '--filter=combine:blob:none+tree:0', 'https://example.com/repo'],
  ['clone', '--filter=sparse:oid=HEAD', 'https://example.com/repo'],
  ['clone', '-qvZ', 'https://example.com/repo'],
  ['status', '-sb'], ['status', '--porcelain=v2'], ['status', '--short=yes'],
  ['add', '-vN', 'f'], ['add', '--all=yes'],
  ['ls-files', '-ct'], ['diff', '--word-diff'], ['diff', 'seed', 'HEAD'],
  ['diff', '--stat', '--name-only'], ['diff', '--stat', '--patch'],
  ['reset', '--keep', 'HEAD'], ['tag', '-as', '-m', 'signed', 'not-created'],
  ['tag', '-F-', 'stdin-tag'],
  ['rev-parse', '--show-toplevel', '--show-prefix'],
  ['commit', '-aqpm', 'no-commit'], ['commit', '--dry-run', '-m', 'no-commit'],
  ['commit', '--', 'f'], ['commit', '--allow-empty=yes', '-m', 'no-commit'],
  ['log', '--grep=needle'], ['log', 'HEAD'], ['log', '--', 'f'],
  ['branch', '--show-current', '--sort=-committerdate'],
  ['branch', 'new-branch', 'HEAD'], ['branch', '-d', 'a', 'b'], ['branch', '--list', '*'],
  ['checkout', '-qbnew-branch', '--no-overlay'], ['checkout', '-b', 'new-branch', 'HEAD'],
  ['remote', 'set-url', 'origin', 'https://example.com/repo'],
  ['remote', 'add', '--fetch', 'origin', 'https://example.com/repo'],
  ['fetch', 'origin', '--prune'], ['fetch', 'origin', 'main'],
  ['pull', 'origin', 'main', '--dry-run'], ['push', 'origin', 'main', '--dry-run'],
  ['push', '-qn', 'origin', 'main'], ['push', 'origin', 'main:other'],
  ['merge', '--squash', 'topic'], ['merge', 'a', 'b'],
  ['config', '--worktree', 'user.name', 'wrong'],
  ['config', '--get', 'user.name', 'pattern'], ['config', 'set', 'user.name', 'wrong'],
];
for (const words of unsupported) {
  const args = [...inRepo, ...words];
  const original = [...args];
  const ran = await git(args, { status: 37 });
  assert.deepEqual(ran.real, [original], `${words.join(' ')}: unsupported invocation handed off`);
  assert.deepEqual(args, original, 'the invocation is untouched');
  assert.equal(ran.code, 37, 'real git status passes through');
  assert.deepEqual(user.readFile('home/user/repo/.git/index'), indexBefore, 'no index mutation before handoff');
  assert.deepEqual(user.readFile('home/user/repo/.git/refs/heads/master'), headBefore, 'no commit before handoff');
  const alone = await git(args, { real: false });
  assert.ok(alone.code !== 0, `${words.join(' ')}: not silently ignored without real git`);
  assert.equal(alone.stdout, '', 'a refused invocation has no partial stdout');
  assert.ok(alone.stderr, 'the parser diagnostic is preserved without real git');
}
assert.equal(user.exists('home/user/repo/not-created'), false);
assert.equal(user.exists('home/user/repo/not-cloned'), false);
assert.equal(user.exists('home/user/repo/.git/refs/heads/new-branch'), false);
assert.equal(user.exists('home/user/repo/.git/refs/tags/not-created'), false);

// Syntax-only handoffs need no filesystem or JavaScript git acquisition.
const noFs = new Proxy({}, { get() { throw new Error('unexpected JavaScript filesystem acquisition'); } });
assert.equal((await git([...inRepo, 'commit', '--dry-run', '-m', 'x'], { view: noFs })).code, 7);

for (const args of [
  [...inRepo, ...identity, 'commit', '-qqam--dry-run', '--allow-empty'],
  [...inRepo, ...identity, 'commit', '--message', '--amend', '--allow-empty', '--'],
  [...inRepo, 'log', '-n1', '--oneline'], [...inRepo, 'log', '-1', '--oneline'],
  [...inRepo, 'status', '-szuall', '--', '--porcelain=v2'],
  [...inRepo, 'ls-files', '-csz', '--', '--bogus'],
  [...inRepo, 'config', 'test.option', '--global'],
  [...inRepo, 'config', '--get', '--', 'test.option'],
  [...inRepo, 'remote', '-v'], [...inRepo, 'branch', '--show-current', '--'],
]) {
  const ran = await git(args);
  assert.deepEqual(ran.real, [], `${args.join(' ')}: implemented forms stay JavaScript`);
  assert.equal(ran.code, 0, ran.stderr);
  if (args.includes('log')) assert.equal(ran.stdout.trim().split('\n').length, 1, 'attached log count is consumed');
}

// Operational failures never hand off, even when they sound unsupported.
for (const words of [
  ['add', 'missing'], ['commit', '--cleanup=invalid', '-m', 'x'],
  ['checkout', 'no-such-branch'], ['fetch', 'no-such-remote'],
  ['pull', 'no-such-remote'], ['push', 'no-such-remote'], ['merge', 'no-such-branch'],
  ['tag', '-d', 'seed', 'missing'], ['reset', '--hard', 'no-such-revision'],
  ['checkout', 'HEAD', '--', 'f', '--no-overlay'],
  ['checkout', '-b', 'bad..branch'],
]) {
  const ran = await git([...inRepo, ...words]);
  assert.deepEqual(ran.real, [], `${words.join(' ')}: operational failure is not a capability refusal`);
  assert.notEqual(ran.code, 0);
}
const failure = new Proxy(files.view({ pid: 1, cred: CRED_SESSION_USER }), {
  get(target, key) {
    if (key === 'readFileUncached') return () => { throw new Error('unsupported storage backend'); };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
assert.deepEqual((await git([...inRepo, 'status'], { view: failure })).real, []);
const pipe = new Error('the reader closed');
pipe.code = 'EPIPE';
const piped = await git([...inRepo, 'status'], { stdoutError: pipe });
assert.equal(piped.code, 141);
assert.deepEqual(piped.real, []);
user.writeFile('home/user/repo/.git/index.lock', 'external owner');
const locked = await git([...inRepo, 'add', 'f']);
assert.equal(locked.code, 128);
assert.deepEqual(locked.real, [], 'a real index lock is an operational refusal');
assert.equal(user.readFileString('home/user/repo/.git/index.lock'), 'external owner');
user.unlink('home/user/repo/.git/index.lock');

// Network failures and cancellation are not parser refusals. A later flag
// cannot start even a quiet transport before its capability handoff.
adoptCtxExports({ SupervisorRPC() { return { async stdout() {}, [Symbol.dispose]() {} }; } });
const networkCalls = [];
let networkResult = { success: false, error: 'unsupported transport operation' };
const doEnv = { ASSETS: stagedAssets, LOADER: { load() { return { getEntrypoint() { return { async fetch(request) {
  networkCalls.push(await request.json());
  return Response.json(networkResult);
} }; } }; } } };
const doCtx = { id: { toString: () => 'git-routing-network' }, waitUntil() {} };
assert.equal((await git([...inRepo, 'remote', '-v', 'add', 'origin', 'https://example.invalid/repo'])).code, 0);
for (const words of [['fetch', '-q', 'origin', '--prune'], ['pull', '-q', 'origin', 'master', '--dry-run'], ['push', '-q', 'origin', 'master', '--dry-run']]) {
  const ran = await git([...inRepo, ...words], { doCtx, doEnv });
  assert.equal(ran.code, 7);
  assert.equal(networkCalls.length, 0, 'no transport before handoff');
}
for (const command of ['fetch', 'pull', 'push']) {
  networkCalls.length = 0;
  const args = [...inRepo, ...identity, command, '-q', 'origin', ...(command === 'fetch' ? [] : ['master'])];
  const failed = await git(args, { doCtx, doEnv });
  assert.deepEqual(failed.real, [], 'a network failure that says unsupported never hands off');
  assert.notEqual(failed.code, 0);
  assert.equal(networkCalls.length, 1);
}
networkCalls.length = 0;
networkResult = { success: true, filesWritten: 1, elapsed: 1 };
const afterFetch = { ...doEnv, LOADER: { load() { return { getEntrypoint() { return { async fetch(request) {
  networkCalls.push(await request.json());
  user.writeFile('home/user/repo/.git/FETCH_HEAD', 'fetch completed before merge refusal\n');
  return Response.json(networkResult);
} }; } }; } } };
const refusedPull = await git([...inRepo, ...identity, 'pull', '-q', 'origin', 'missing'], { doCtx, doEnv: afterFetch });
assert.notEqual(refusedPull.code, 0);
assert.deepEqual(refusedPull.real, [], 'a merge refusal after a successful fetch is not replayed');
assert.equal(networkCalls.length, 1);
assert.equal(user.readFileString('home/user/repo/.git/FETCH_HEAD'), 'fetch completed before merge refusal\n');
networkResult = { success: false, cancelled: 'interrupted' };
const stopped = new AbortController();
stopped.abort('SIGINT');
const cancelled = await git([...inRepo, 'fetch', '-q', 'origin'], { doCtx, doEnv, signal: stopped.signal });
assert.deepEqual(cancelled.real, []);
assert.notEqual(cancelled.code, 0);
adoptCtxExports(undefined);

// An implemented config action must delete, not silently turn into a read.
assert.equal((await git([...inRepo, 'config', 'test.delete', 'present'])).code, 0);
const unset = await git([...inRepo, 'config', '--unset', 'test.delete']);
assert.deepEqual(unset.real, []);
assert.equal(unset.code, 0, unset.stderr);
assert.equal((await git([...inRepo, 'config', '--get', 'test.delete'])).code, 1);

// Config made by real git is shared by JavaScript identity and settings.
user.mkdir('home/user/xdg/git', { recursive: true });
user.writeFile('home/user/xdg/git/config', '[user]\n name = XDG\n email = xdg@example.com\n[init]\n defaultBranch = xdg\n');
user.writeFile('home/user/.gitconfig', '[user]\n name = Global\n email = global@example.com\n[init]\n defaultBranch = global\n');
user.writeFile('home/user/explicit-config', '[user]\n name = Explicit\n email = explicit@example.com\n[init]\n defaultBranch = explicit\n');
const configEnv = { HOME: '/home/user', XDG_CONFIG_HOME: '/home/user/xdg' };
for (const [name, env] of [
  ['Global', configEnv],
  ['Explicit', { ...configEnv, GIT_CONFIG_GLOBAL: '/home/user/explicit-config' }],
  ['XDG', { HOME: '/home/user/no-home-config', XDG_CONFIG_HOME: '/home/user/xdg' }],
]) {
  const directory = `identity-${name}`;
  assert.equal((await git(['init', '-q', directory], { env })).code, 0);
  assert.equal(user.readFileString(`home/user/${directory}/.git/HEAD`), `ref: refs/heads/${name.toLowerCase()}\n`);
  const ran = await git(['-C', directory, 'commit', '-q', '-m', 'identity', '--allow-empty'], { env });
  assert.deepEqual(ran.real, [], 'global identity remains JavaScript');
  assert.equal(ran.code, 0, ran.stderr);
  assert.match((await git(['-C', directory, 'log', '-n1'], { env })).stdout, new RegExp(`Author: ${name} <`));
}
assert.equal((await git([...inRepo, 'config', 'user.name', 'Local'], { env: configEnv })).code, 0);
assert.equal((await git([...inRepo, '-c', 'user.name=Override', 'config', '--get', 'user.name'], { env: configEnv })).stdout, 'Override\n');
assert.equal((await git([...inRepo, 'config', '--get', 'user.name'], { env: configEnv })).stdout, 'Local\n');
assert.equal((await git([...inRepo, 'config', '--get', 'init.defaultBranch'], {
  env: { ...configEnv, GIT_CONFIG_GLOBAL: '../explicit-config' },
})).stdout, 'explicit\n', 'a relative global config is relative to the command cwd');
user.writeFile('home/user/.gitconfig', user.readFileString('home/user/.gitconfig') + '[status]\n showUntrackedFiles = no\n');
assert.equal((await git([...inRepo, 'status', '--short'], { env: configEnv })).stdout, '', 'ordinary settings read the global config too');

// Real git's unreadable index modes are identified before any writes,
// including checkout -b and commit -a's otherwise early mutations.
for (const signature of ['link', 'sdir']) {
  user.writeFile('home/user/repo/.git/index', encodeIndexFile([], [{ signature, bytes: new Uint8Array(20) }]));
  const before = user.readFile('home/user/repo/.git/index');
  for (const words of [['checkout'], ['checkout', 'HEAD'], ['add'], ['reset', '--soft', 'HEAD']]) {
    const ran = await git([...inRepo, ...words]);
    assert.deepEqual(ran.real, [], `${signature}: ${words.join(' ')} does not consume the index`);
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(user.readFile('home/user/repo/.git/index'), before);
  }
  for (const words of [['status'], ['add', 'f'], ['commit', '-am', 'no-commit'], ['checkout', '-b', 'unreadable'], ['reset', '--hard', 'HEAD'], ['merge', 'topic']]) {
    const ran = await git([...inRepo, ...identity, ...words]);
    assert.deepEqual(ran.real, [[...inRepo, ...identity, ...words]], `${signature}: ${words[0]} hands off`);
    assert.deepEqual(user.readFile('home/user/repo/.git/index'), before);
    assert.equal(user.exists('home/user/repo/.git/index.lock'), false);
    assert.equal(user.exists('home/user/repo/.git/refs/heads/unreadable'), false);
    const alone = await git([...inRepo, ...words], { real: false });
    assert.equal(alone.code, 128);
    assert.equal(alone.stdout, '');
  }
}
user.writeFile('home/user/repo/.git/index', indexBefore);
user.writeFile('home/user/repo/.git/config.worktree', '[core]\n sparseCheckout = true\n sparseCheckoutCone = false\n');
assert.equal((await git([...inRepo, 'config', 'extensions.worktreeConfig', 'true'])).code, 0);
user.mkdir('home/user/repo/.git/info', { recursive: true });
user.writeFile('home/user/repo/.git/info/sparse-checkout', '*.txt\n');
for (const words of [['add', 'f'], ['checkout', '-b', 'noncone'], ['commit', '-am', 'no-commit'], ['pull', 'origin', 'main']]) {
  assert.equal((await git([...inRepo, ...words])).code, 7, 'non-cone state hands off before mutation');
  assert.equal(user.exists('home/user/repo/.git/refs/heads/noncone'), false);
}

console.log('git-routing: built-in, real git, its children, and git alone');
