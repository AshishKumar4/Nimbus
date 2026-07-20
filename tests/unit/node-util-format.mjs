#!/usr/bin/env bun
// node-util-format — the generated Node util shim must expose
// formatWithOptions(). consola's FancyReporter calls
// util.formatWithOptions(inspectOptions, ...args) directly; its absence
// crashed every consola-based CLI under Nimbus:
//   "TypeError: (0 , import_node_util.formatWithOptions) is not a function"
// (nuxi init, thrown from FancyReporter.formatArgs at its first
// consola.error after printing "Welcome to Nuxt!"). The shim exits fast
// and clean once formatWithOptions returns a string.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

function makeUtil() {
  const code = generateShimsCode();
  const factory = new Function(
    '__vfsBundle', '__vfsWrites', '__vfsDirs', '__vfsManifest', '__supervisor',
    'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + code + '\n;return builtins.util;',
  );
  return factory({}, {}, {}, {}, {}, '/home/user', [], {}, '/home/user/main.mjs', '/home/user');
}

const util = makeUtil();

// The export that was missing — the exact crash.
assert.equal(typeof util.formatWithOptions, 'function', 'formatWithOptions is exported from node:util');

// Formats like format(), threading (ignored) inspect options as arg 1.
assert.equal(util.formatWithOptions({ colors: false }, '%s %d', 'a', 5), 'a 5');
assert.equal(util.formatWithOptions({}, 'no specifiers', 'x'), 'no specifiers x');
assert.equal(util.formatWithOptions({}, '100%% done'), '100% done');

// The exact consola call shape: a reporter formats an error line.
assert.equal(
  util.formatWithOptions({ colors: false }, 'Missing required argument: %s', 'gitInit'),
  'Missing required argument: gitInit',
);

// format() itself is unchanged (regression guard on the delegation).
assert.equal(util.format('%s %d', 'hello', 42), 'hello 42');
assert.equal(util.format('%o', { x: 1 }), JSON.stringify({ x: 1 }, null, 2));

console.log('node-util-format: ok');
