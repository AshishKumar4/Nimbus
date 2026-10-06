#!/usr/bin/env bun
/**
 * jsonc.ts reads a tsconfig as tsconfck and as esbuild do. The esbuild
 * dialect is held against esbuild-wasm itself in tsconfig-jsx-differential.mjs;
 * this pins where the two dialects part, and what they share.
 */

import assert from 'node:assert/strict';
import { jsoncToJson } from '../../packages/core/src/runtime/jsonc.ts';
import { toJson } from '../../packages/core/src/runtime/tsconfck.ts';

const parse = (text, dialect) => {
  try {
    return { value: JSON.parse(jsoncToJson(text, dialect)) };
  } catch (error) {
    return { error: error.message };
  }
};
const both = (text, value) => {
  assert.deepEqual(parse(text, 'tsconfck'), { value }, `tsconfck ${JSON.stringify(text)}`);
  assert.deepEqual(parse(text, 'esbuild'), { value }, `esbuild ${JSON.stringify(text)}`);
};

// Shared: BOM, comments, dangling commas, and none of them looked for inside a string.
both('\uFEFF{"a": 1}', { a: 1 });
both('{\n  // c\n  "a": [1, 2, /* x */ ],\n}', { a: [1, 2] });
both('{"u": "http://x/*y*/", "c": "a,}", "q": "\\"//"}', { u: 'http://x/*y*/', c: 'a,}', q: '"//' });
both('{"a": 1} // trailing', { a: 1 });

// A `//` comment: tsconfck ends it at a line feed only, esbuild at any line terminator.
assert.deepEqual(parse('{"a": // c\r"b"}', 'esbuild'), { value: { a: 'b' } });
assert.ok(parse('{"a": // c\r"b"}', 'tsconfck').error, 'a lone CR does not end a tsconfck comment');
assert.deepEqual(parse('{"a": // c\u2028"b"}', 'esbuild'), { value: { a: 'b' } });

// A line terminator between tokens is whitespace to esbuild, not to JSON.
assert.deepEqual(parse('{"a":\u20281}\u2029', 'esbuild'), { value: { a: 1 } });
assert.ok(parse('{"a":\u20281}', 'tsconfck').error);
// tsconfck blanks a comment rather than dropping it, so its U+2028 still fails JSON.
assert.ok(parse('{"a": 1 /* \u2028 */}', 'tsconfck').error);
assert.deepEqual(parse('{"a": 1 /* \u2028 */}', 'esbuild'), { value: { a: 1 } });

// An open block comment: tsconfck runs it to the end, esbuild refuses it.
assert.deepEqual(parse('{"a": 1} /* open', 'tsconfck'), { value: { a: 1 } });
assert.deepEqual(parse('{"a": 1} /* open', 'esbuild'), { error: 'Expected "*/" to terminate multi-line comment' });

// tsconfck's reading of an empty tsconfig.
assert.equal(toJson(''), '{}');
assert.equal(toJson('\uFEFF  // nothing\n'), '{}');

console.log('jsonc-dialects: ok');
