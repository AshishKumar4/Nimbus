#!/usr/bin/env bun
// The expander finds the end of a `$(...)` or `${...}` it was handed raw
// with the lexer's scanner (readBalancedCommand), which skips quotes: a `)`
// or `}` inside quotes does not end the span. The expander's own scanner
// (skipBalanced) counted brackets inside quotes and ended `$(echo ")")` at
// the quoted `)`. Brace expansion skips such spans the same way.
import assert from 'node:assert/strict';
import { expandWord, expandWords } from '../../packages/core/src/substrate/lifo/shell/expander.ts';

const ran = [];
const ctx = {
  env: { v: '' }, lastExitCode: 0, cwd: '/', vfs: null, options: {},
  executeCapture: async (input) => { ran.push(input); return { output: input === 'echo ")"' ? ')\n' : '}\n', exitCode: 0 }; },
};
assert.equal(await expandWord([{ text: '$(echo ")")x', quoted: 'none' }], ctx), ')x');
assert.deepEqual(ran, ['echo ")"']);
assert.deepEqual(await expandWords([[{ text: '{a,b}$(echo "}")', quoted: 'none' }]], ctx), ['a}', 'b}']);
console.log('expander-balanced-scan: ok');
