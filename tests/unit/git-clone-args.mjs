#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { parseCloneArgs, parseGitGlobals } from '../../packages/worker/src/git/commands.ts';

const url = 'https://github.com/example/project.git';

assert.deepEqual(parseCloneArgs(['--depth', '1', url]), {
  url,
  dest: undefined,
  depth: 1,
  noShallow: false,
  isBg: false,
  branch: undefined,
  quiet: false,
});

assert.deepEqual(parseCloneArgs(['--depth', '1', url, 'checkout']), {
  url,
  dest: 'checkout',
  depth: 1,
  noShallow: false,
  isBg: false,
  branch: undefined,
  quiet: false,
});

assert.deepEqual(parseCloneArgs(['--depth=1', url]), {
  url,
  dest: undefined,
  depth: 1,
  noShallow: false,
  isBg: false,
  branch: undefined,
  quiet: false,
});

assert.deepEqual(parseCloneArgs(['--depth', '3', url]), {
  url,
  dest: undefined,
  depth: 3,
  noShallow: false,
  isBg: false,
  branch: undefined,
  quiet: false,
});

assert.deepEqual(parseCloneArgs([url]), {
  url,
  dest: undefined,
  depth: 1,
  noShallow: false,
  isBg: false,
  branch: undefined,
  quiet: false,
});

assert.deepEqual(parseCloneArgs([url, 'mydir']), {
  url,
  dest: 'mydir',
  depth: 1,
  noShallow: false,
  isBg: false,
  branch: undefined,
  quiet: false,
});

assert.deepEqual(parseCloneArgs(['--no-shallow', url]), {
  url,
  dest: undefined,
  depth: undefined,
  noShallow: true,
  isBg: false,
  branch: undefined,
  quiet: false,
});

assert.deepEqual(parseCloneArgs(['--bg', url, 'background-checkout']), {
  url,
  dest: 'background-checkout',
  depth: 1,
  noShallow: false,
  isBg: true,
  branch: undefined,
  quiet: false,
});

assert.deepEqual(parseCloneArgs([url, 'background-checkout', '&']), {
  url,
  dest: 'background-checkout',
  depth: 1,
  noShallow: false,
  isBg: true,
  branch: undefined,
  quiet: false,
});

// --branch takes a value: the value must never be eaten as the URL.
assert.deepEqual(parseCloneArgs(['--branch', 'dev', url]), {
  url,
  dest: undefined,
  depth: 1,
  noShallow: false,
  isBg: false,
  branch: 'dev',
  quiet: false,
});

assert.deepEqual(parseCloneArgs(['--branch=dev', url, 'mydir']), {
  url,
  dest: 'mydir',
  depth: 1,
  noShallow: false,
  isBg: false,
  branch: 'dev',
  quiet: false,
});

assert.deepEqual(parseCloneArgs(['-b', 'release/2.0', url]), {
  url,
  dest: undefined,
  depth: 1,
  noShallow: false,
  isBg: false,
  branch: 'release/2.0',
  quiet: false,
});

// A value-taking flag with no value is a loud error, not a silent default.
assert.throws(
  () => parseCloneArgs([url, '--branch']),
  /option '--branch' requires a value/,
);

// --filter is refused loudly, naming the limitation — never a silent no-op
// that pretends a blobless clone happened.
assert.throws(
  () => parseCloneArgs(['--filter=blob:none', url]),
  /does not support '--filter'.*partial-clone/s,
);
assert.throws(
  () => parseCloneArgs(['--filter', 'blob:none', url]),
  /does not support '--filter'/,
);

// Any other unknown flag is a loud error listing what is supported.
assert.throws(
  () => parseCloneArgs(['--recurse-submodules', url]),
  /unknown option '--recurse-submodules'[\s\S]*usage: git clone/,
);
// ── -q / --quiet, -v / --verbose ──────────────────────────────────────────
//
// Kinu's clone-and-serve runs `git clone -q`; it was refused as an unknown
// option. Quiet drops the progress lines; verbose asks for what is already
// the default.
assert.equal(parseCloneArgs(['-q', url]).quiet, true);
assert.equal(parseCloneArgs(['--quiet', '--depth', '1', url, 'dir']).quiet, true);
assert.deepEqual(parseCloneArgs(['--quiet', '--depth', '1', url, 'dir']), {
  url, dest: 'dir', depth: 1, noShallow: false, isBg: false, branch: undefined, quiet: true,
});
assert.equal(parseCloneArgs(['-v', url]).quiet, false);
assert.throws(() => parseCloneArgs(['--porcelain', url]), /unknown option '--porcelain'/);

// ── git -C <path> ─────────────────────────────────────────────────────────
//
// `git -C <path> <command>` runs the command from <path>: the subcommand and
// its arguments are what follows, and the directory is <path> resolved
// against the cwd. Repeated, each -C is relative to the previous one. An
// unknown leading option is refused, because swallowing it would run the
// next word as the subcommand.
assert.deepEqual(parseGitGlobals(['status'], '/home/user'), { sub: 'status', subArgs: [], dir: '/home/user' });
assert.deepEqual(parseGitGlobals(['-C', '/srv/app', 'branch', '--show-current'], '/home/user'), { sub: 'branch', subArgs: ['--show-current'], dir: '/srv/app' });
assert.deepEqual(parseGitGlobals(['-C', 'app', 'status'], '/home/user'), { sub: 'status', subArgs: [], dir: '/home/user/app' });
assert.deepEqual(parseGitGlobals(['-C', 'a', '-C', 'b', 'log'], '/home/user'), { sub: 'log', subArgs: [], dir: '/home/user/a/b' });
assert.deepEqual(parseGitGlobals(['-C/srv/app', 'status'], '/home/user').dir, '/srv/app');
assert.deepEqual(parseGitGlobals(['--no-pager', 'log', '-1'], '/home/user'), { sub: 'log', subArgs: ['-1'], dir: '/home/user' });
assert.deepEqual(parseGitGlobals(['--version'], '/home/user').sub, '--version');
assert.deepEqual(parseGitGlobals([], '/home/user'), { sub: undefined, subArgs: [], dir: '/home/user' });
assert.throws(() => parseGitGlobals(['-C'], '/home/user'), /requires a value/);
assert.throws(() => parseGitGlobals(['--git-dir=/x', 'status'], '/home/user'), /unknown option '--git-dir=\/x'/);

console.log('git-clone-args: ok');
