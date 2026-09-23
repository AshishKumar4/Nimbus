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
    '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest',
    '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + code + '\n;return builtins.util;',
  );
  return factory(
    {}, {}, {}, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
  );
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

// console.log() with no arguments prints an empty line, as in Node.
assert.equal(util.format(), '');
assert.equal(util.formatWithOptions({}), '');
assert.equal(util.format(undefined), 'undefined', 'an explicit undefined argument still prints');

// An Error prints like Node's util.inspect: stack, own fields, [cause].
{
  const plain = new Error('plain failure');
  assert.equal(util.format(plain), plain.stack, 'an error with no own fields is its stack');
  assert.equal(util.inspect(plain), plain.stack);

  const inner = new TypeError('inner reason');
  const outer = new Error('Cannot find native binding.');
  outer.cause = inner;
  outer.__nimbusModulePath = 'node_modules/rolldown/dist/shared/binding.mjs';
  for (const [how, text] of [
    ['format', util.format(outer)],
    ['inspect', util.inspect(outer)],
    ['%o', util.format('%o', outer)],
    ['format with a leading string', util.format('failed:', outer)],
  ]) {
    assert.ok(text.includes(outer.stack), `${how}: the stack (message and frames) is printed:\n${text}`);
    assert.ok(text.includes('[cause]: TypeError: inner reason'), `${how}: the cause is printed:\n${text}`);
    assert.ok(text.includes('__nimbusModulePath: "node_modules/rolldown/dist/shared/binding.mjs"'),
      `${how}: own fields are printed:\n${text}`);
  }

  // An option-bag cause (non-enumerable) prints too; a cycle terminates.
  const looped = new Error('outer', { cause: new Error('middle') });
  looped.cause.cause = looped;
  const text = util.format(looped);
  assert.ok(text.includes('[cause]: Error: middle'), text);
  assert.ok(text.includes('[Circular *]'), text);
}

console.log('node-util-format: ok');
