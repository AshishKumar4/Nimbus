#!/usr/bin/env bun
// less, nano and sl read keys and draw with one helper (commands/term-screen.ts):
// less and nano each kept the same escape table, nano's a superset.
import assert from 'node:assert/strict';
import { moveTo, parseKey } from '../../packages/core/src/substrate/lifo/commands/term-screen.ts';

for (const [data, type] of [
  ['\r', 'enter'], ['\x7f', 'backspace'], ['\b', 'backspace'], ['\t', 'tab'], ['\x1b', 'escape'],
  ['\x0f', 'ctrl-o'], ['\x18', 'ctrl-x'], ['\x0b', 'ctrl-k'], ['\x15', 'ctrl-u'], ['\x17', 'ctrl-w'], ['\x03', 'ctrl-c'],
  ['\x1b[A', 'up'], ['\x1b[B', 'down'], ['\x1b[C', 'right'], ['\x1b[D', 'left'],
  ['\x1b[H', 'home'], ['\x1b[1~', 'home'], ['\x1b[7~', 'home'], ['\x1b[F', 'end'], ['\x1b[4~', 'end'], ['\x1b[8~', 'end'],
  ['\x1b[3~', 'delete'], ['\x1b[5~', 'pageup'], ['\x1b[6~', 'pagedown'], ['\x1b[Z', 'unknown'], ['\x01', 'unknown'],
]) {
  assert.deepEqual(parseKey(data), { type }, JSON.stringify(data));
}
assert.deepEqual(parseKey('q'), { type: 'char', char: 'q' });
assert.deepEqual(parseKey('é'), { type: 'char', char: 'é' });
assert.equal(moveTo(0, 0), '\x1b[1;1H');
assert.equal(moveTo(4, 9), '\x1b[5;10H');
console.log('term-screen-keys: ok');
