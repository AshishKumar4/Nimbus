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
});

assert.deepEqual(parseCloneArgs(['--depth', '1', url, 'checkout']), {
  url,
  dest: 'checkout',
  depth: 1,
  noShallow: false,
  isBg: false,
});

assert.deepEqual(parseCloneArgs(['--depth=1', url]), {
  url,
  dest: undefined,
  depth: 1,
  noShallow: false,
  isBg: false,
});

assert.deepEqual(parseCloneArgs([url]), {
  url,
  dest: undefined,
  depth: 1,
  noShallow: false,
  isBg: false,
});

assert.deepEqual(parseCloneArgs([url, 'mydir']), {
  url,
  dest: 'mydir',
  depth: 1,
  noShallow: false,
  isBg: false,
});

assert.deepEqual(parseCloneArgs(['--no-shallow', url]), {
  url,
  dest: undefined,
  depth: undefined,
  noShallow: true,
  isBg: false,
});

assert.deepEqual(parseCloneArgs(['--bg', url, 'background-checkout']), {
  url,
  dest: 'background-checkout',
  depth: 1,
  noShallow: false,
  isBg: true,
});

assert.deepEqual(parseCloneArgs([url, 'background-checkout', '&']), {
  url,
  dest: 'background-checkout',
  depth: 1,
  noShallow: false,
  isBg: true,
});

console.log('git-clone-args: ok');
