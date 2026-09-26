#!/usr/bin/env bun
// The shell's pattern matcher (find -name, case, [[ ]], ${x#pat}, pathname
// expansion) answers as fnmatch(3) with no flags: an unclosed `[` is a
// literal, `\` quotes the next character, a trailing `\` matches nothing,
// `]` first in a class is literal. Where glibc is loadable it is the oracle;
// the recorded answers are glibc 2.43's.

import assert from 'node:assert/strict';
import { globMatch } from '../../packages/core/src/substrate/lifo/utils/glob.ts';

const cases = [
  ['a[b', 'a[b', true], ['a\\*b', 'a*b', true], ['a\\*b', 'axb', false], ['[ab]*', 'bin', true],
  ['[!e-p]*', '3k', true], ['[]a]', ']', true], ['[!]a]', 'b', true], ['a[', 'a[', true], ['*[', 'x[', true],
  ['\\[x]', '[x]', true], ['[a\\]]b', ']b', true], ['*.ts', 'a.ts', true], ['a?c', 'abc', true],
  ['[z-a]', 'm', false], ['\\', '\\', false], ['a\\', 'a\\', false], ['[\\!a]', '!', true], ['[a-\\z]', 'm', true],
  ['*a[', 'xxa[', true], ['[', '[', true], ['[!', '[!', true], ['**x', 'yx', true], ['a*[bc]', 'aqqc', true],
];

let fnmatch = null;
try {
  const { dlopen, FFIType, ptr } = await import('bun:ffi');
  const libc = dlopen('libc.so.6', { fnmatch: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 } });
  const cstr = (s) => ptr(new TextEncoder().encode(`${s}\0`));
  fnmatch = (pattern, text) => libc.symbols.fnmatch(cstr(pattern), cstr(text), 0) === 0;
} catch {}

for (const [pattern, text, recorded] of cases) {
  const expected = fnmatch ? fnmatch(pattern, text) : recorded;
  assert.equal(expected, recorded, `the recorded answer for ${pattern} ~ ${text} is glibc's`);
  assert.equal(globMatch(pattern, text), expected, `${JSON.stringify(pattern)} ~ ${JSON.stringify(text)}`);
}
console.log(`glob-fnmatch: ${cases.length} patterns match fnmatch(3)${fnmatch ? ' (glibc live)' : ''}`);
