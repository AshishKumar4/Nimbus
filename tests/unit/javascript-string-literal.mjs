#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { DECODE_JAVASCRIPT_STRING_LITERAL_SOURCE } from '../../packages/worker/src/runtime/javascript-string-literal.ts';

// The exact text generateShimsCode embeds in every guest.
const decode = new Function(`return (${DECODE_JAVASCRIPT_STRING_LITERAL_SOURCE});`)();

// es-module-lexer decodes names using non-strict indirect eval. Only the data
// subset is implemented: a single StringLiteral, with all its escape forms.
for (const source of [
  '"virtual:astro:manifest"', "'react/jsx-runtime'", '  ""\n',
  String.raw`'can\'t'`, String.raw`"back\\slash\"quote"`,
  String.raw`'\n\r\t\b\f\v\0'`, String.raw`'\x41\u0042\u{1f600}'`,
  String.raw`'\uD800\uDC00'`, String.raw`'\377\400\08\9\z'`,
  "'line\\\ncontinuation'", "'CR\\\r\nLF'", '"\u2028\u2029"',
]) {
  assert.equal(decode(source), (0, eval)(source), source);
}
// Expressions, statements, templates and malformed escapes are never treated
// as data. They must retain workerd's native evaluation refusal.
for (const source of [
  '"x" + "y"', '"x"; globalThis.sideEffect = true', '("x")', '`x`',
  '"x" // comment', '/* comment */ "x"', '1 + 1', 'Function("null")',
  '"unterminated', '"raw\nnewline"', String.raw`'\x0g'`, String.raw`'\u{}'`,
  String.raw`'\u{110000}'`, String.raw`'\u000'`, "'dangling\\",
]) {
  assert.equal(decode(source), undefined, source);
}
console.log('javascript-string-literal: ok');
