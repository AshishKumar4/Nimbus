#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { parseCloneArgs } from '../../packages/worker/src/git/commands.ts';

const url = 'https://github.com/example/project.git';

assert.deepEqual(parseCloneArgs(['--depth', '1', url]), {
  url,
  dest: undefined,
  depth: 1,
  noShallow: false,
  isBg: false,
  branch: undefined,
});

assert.deepEqual(parseCloneArgs(['--depth', '1', url, 'checkout']), {
  url,
  dest: 'checkout',
  depth: 1,
  noShallow: false,
  isBg: false,
  branch: undefined,
});

assert.deepEqual(parseCloneArgs(['--depth=1', url]), {
  url,
  dest: undefined,
  depth: 1,
  noShallow: false,
  isBg: false,
  branch: undefined,
});

assert.deepEqual(parseCloneArgs(['--depth', '3', url]), {
  url,
  dest: undefined,
  depth: 3,
  noShallow: false,
  isBg: false,
  branch: undefined,
});

assert.deepEqual(parseCloneArgs([url]), {
  url,
  dest: undefined,
  depth: 1,
  noShallow: false,
  isBg: false,
  branch: undefined,
});

assert.deepEqual(parseCloneArgs([url, 'mydir']), {
  url,
  dest: 'mydir',
  depth: 1,
  noShallow: false,
  isBg: false,
  branch: undefined,
});

assert.deepEqual(parseCloneArgs(['--no-shallow', url]), {
  url,
  dest: undefined,
  depth: undefined,
  noShallow: true,
  isBg: false,
  branch: undefined,
});

assert.deepEqual(parseCloneArgs(['--bg', url, 'background-checkout']), {
  url,
  dest: 'background-checkout',
  depth: 1,
  noShallow: false,
  isBg: true,
  branch: undefined,
});

assert.deepEqual(parseCloneArgs([url, 'background-checkout', '&']), {
  url,
  dest: 'background-checkout',
  depth: 1,
  noShallow: false,
  isBg: true,
  branch: undefined,
});

// --branch takes a value: the value must never be eaten as the URL.
assert.deepEqual(parseCloneArgs(['--branch', 'dev', url]), {
  url,
  dest: undefined,
  depth: 1,
  noShallow: false,
  isBg: false,
  branch: 'dev',
});

assert.deepEqual(parseCloneArgs(['--branch=dev', url, 'mydir']), {
  url,
  dest: 'mydir',
  depth: 1,
  noShallow: false,
  isBg: false,
  branch: 'dev',
});

assert.deepEqual(parseCloneArgs(['-b', 'release/2.0', url]), {
  url,
  dest: undefined,
  depth: 1,
  noShallow: false,
  isBg: false,
  branch: 'release/2.0',
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
assert.throws(
  () => parseCloneArgs(['-q', url]),
  /unknown option '-q'/,
);

console.log('git-clone-args: ok');
