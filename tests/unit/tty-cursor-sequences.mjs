#!/usr/bin/env bun
// The lifo node's tty.WriteStream cursor methods are readline's, as in Node,
// and write what Node's do (the sequences below are Node 22.22's readline): they were a
// second copy of readline's four functions.
import assert from 'node:assert/strict';
import { WriteStream } from '../../packages/core/src/substrate/lifo/node-compat/tty.ts';
import * as readline from '../../packages/core/src/substrate/lifo/node-compat/readline.ts';

const calls = [
  [(s) => s.clearLine(-1), '\x1b[1K'], [(s) => s.clearLine(1), '\x1b[0K'], [(s) => s.clearLine(0), '\x1b[2K'],
  [(s) => s.clearScreenDown(), '\x1b[0J'],
  [(s) => s.cursorTo(4), '\x1b[5G'], [(s) => s.cursorTo(4, 2), '\x1b[3;5H'],
  [(s) => s.moveCursor(-2, 3), '\x1b[2D\x1b[3B'], [(s) => s.moveCursor(1, -1), '\x1b[1C\x1b[1A'],
];
for (const [call, want] of calls) {
  let out = '';
  const stream = new WriteStream();
  stream.write = (chunk) => { out += chunk; return true; };
  assert.equal(call(stream), true);
  assert.equal(out, want, String(call));
  let viaReadline = '';
  const sink = { write: (chunk) => { viaReadline += chunk; } };
  call({
    clearLine: (d) => readline.clearLine(sink, d), clearScreenDown: () => readline.clearScreenDown(sink),
    cursorTo: (x, y) => readline.cursorTo(sink, x, y), moveCursor: (x, y) => readline.moveCursor(sink, x, y),
  });
  assert.equal(viaReadline, want, `readline: ${call}`);
}
let called = false;
new WriteStream().cursorTo(0, () => { called = true; });
assert.ok(called, 'cursorTo(x, callback) calls back');
console.log('tty-cursor-sequences: ok');
