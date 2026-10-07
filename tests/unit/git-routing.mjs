#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { classifyGitCommand, GIT_FAMILY_POLICY, parseGitGlobals, routeGitInvocation } from '../../packages/worker/src/git/routing.ts';

const commands = {
  clone: ['clone'],
  init: ['init'],
  status: ['status'],
  diff: ['diff', 'diff-files', 'diff-index', 'diff-tree'],
  add: ['add'],
  commit: ['commit'],
  checkout: ['checkout', 'switch', 'restore'],
  reset: ['reset'],
  history: ['log', 'show', 'blame', 'rev-list'],
  refs: ['branch', 'tag', 'remote', 'config', 'rev-parse', 'show-ref', 'update-ref', 'symbolic-ref', 'for-each-ref', 'ls-files', 'reflog'],
  merge: ['merge', 'cherry-pick', 'revert'],
  rebase: ['rebase'],
  stash: ['stash'],
  sparse: ['sparse-checkout'],
  transport: ['fetch', 'pull', 'push'],
  other: [undefined, '--version', '-v', '--help', '-h', 'help', 'archive', 'user-alias', 'constructor', '__proto__', 'toString'],
};
const jsCommands = new Set([undefined, '--version', '-v', '--help', '-h', 'clone', 'init', 'status', 'diff', 'add', 'commit', 'checkout', 'reset', 'log', 'branch', 'tag', 'remote', 'config', 'rev-parse', 'ls-files', 'merge', 'fetch', 'pull', 'push']);
const regressions = { status: [35, 4798], diff: [27, 2217], add: [31, 2207], commit: [33, 4213], checkout: [56, 4330] };

for (const [family, subs] of Object.entries(commands)) {
  for (const sub of subs) {
    assert.equal(classifyGitCommand(sub), family, String(sub));
    const args = sub === undefined ? [] : [sub];
    const original = [...args];
    const route = routeGitInvocation(args, '/home/user');
    assert.equal(route.family, family);
    assert.equal(route.policy.backend, jsCommands.has(sub) ? 'javascript' : 'wasi', `${sub}: explicit capability route`);
    if (jsCommands.has(sub) && family !== 'other') assert.equal(route.policy, GIT_FAMILY_POLICY[family]);
    if (!jsCommands.has(sub)) assert.equal(route.policy.reason, 'javascript-capability-gap');
    assert.deepEqual(args, original, 'routing preserves the original argv');
  }
}

for (const [args, expected] of [
  [['-C', 'repo', 'clone', '--sparse', 'https://example.test/repo'], { sub: 'clone', subArgs: ['--sparse', 'https://example.test/repo'], dir: '/home/user/repo' }],
  [['-C', 'repo', '-Csrc', '-P', 'status', '--short'], { sub: 'status', subArgs: ['--short'], dir: '/home/user/repo/src' }],
  [['--no-pager', '-C', '/workspace', 'stash', 'push'], { sub: 'stash', subArgs: ['push'], dir: '/workspace' }],
  [['-C', '', '--version'], { sub: '--version', subArgs: [], dir: '/home/user' }],
  [['-C./repo//', '-C', '.', 'fetch'], { sub: 'fetch', subArgs: [], dir: '/home/user/repo' }],
  [[], { sub: undefined, subArgs: [], dir: '/home/user' }],
]) {
  assert.deepEqual(parseGitGlobals(args, '/home/user'), expected);
  const { family, policy, ...parsed } = routeGitInvocation(args, '/home/user');
  assert.deepEqual(parsed, expected);
  assert.equal(family, classifyGitCommand(expected.sub));
  assert.equal(policy.backend, expected.sub === 'stash' ? 'wasi' : 'javascript');
}

for (const args of [['-C'], ['--unknown', 'clone'], ['-c', 'alias.x=clone', 'x'], ['--git-dir=repo', 'status']]) {
  assert.throws(() => parseGitGlobals(args, '/home/user'));
  assert.throws(() => routeGitInvocation(args, '/home/user'), 'routing does not ignore unsupported leading options');
}

assert.deepEqual(Object.keys(GIT_FAMILY_POLICY).sort(), Object.keys(commands).sort());
for (const [family, [javascriptMs, wasiMs]] of Object.entries(regressions)) {
  assert.deepEqual(GIT_FAMILY_POLICY[family], { backend: 'javascript', reason: 'latency-regression', javascriptMs, wasiMs });
}
for (const args of [
  ['merge', '-s', 'ours', 'topic'], ['merge', '--strategy=ort', 'topic'], ['merge', '--ff-only', 'topic'], ['merge', '--abort'], ['merge', 'one', 'two'],
  ['add', '-p'], ['commit', '--amend'], ['branch', '-m', 'new'], ['checkout', '--orphan', 'new'],
  ['config', '--global', 'user.name', 'Ada'], ['log', '--graph'], ['pull', '--rebase'],
  ['show', 'HEAD'], ['blame', 'a'], ['switch', 'main'], ['restore', 'a'], ['notes', 'list'], ['worktree', 'list'],
]) {
  assert.equal(routeGitInvocation(args, '/home/user').policy.backend, 'wasi', args.join(' '));
}
for (const args of [['merge', '-q', 'topic'], ['add', '-A'], ['commit', '-m', 'message'], ['checkout', '--', '--orphan'], ['log', '--oneline', '-n', '10']]) {
  assert.equal(routeGitInvocation(args, '/home/user').policy.backend, 'javascript', args.join(' '));
}
assert.ok(Object.isFrozen(GIT_FAMILY_POLICY));
for (const policy of Object.values(GIT_FAMILY_POLICY)) assert.ok(Object.isFrozen(policy));
console.log('git-routing: command families, explicit performance choices and capability gaps passed');
