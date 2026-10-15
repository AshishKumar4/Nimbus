#!/usr/bin/env bun
// What the shell captures as text decodes its bytes as one stream, however
// a command's writes cut them, and the end of the capture ends the stream:
//
//   - a character split between two writes (cat's 64 KiB reads) is one
//     character in exec's stdout and in $( ) alike, where invalid bytes still
//     map one by one (decodeLossless);
//   - a streamed exec (onStdout) carries the same text in its result, its
//     last unfinished character included.
//
// Red before: the capture took text only, so each write was decoded alone
// and a split é was two lone surrogates; a streamed exec's result never
// ended its decoder and lost a trailing unfinished character.

import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
try {
  // 65,535 bytes, then é: its two bytes straddle cat's first 64 KiB read.
  await ws.fs.writeFile('/home/user/split.txt', `${'a'.repeat(65_535)}é`);
  const whole = await ws.exec('cat split.txt', { cwd: '/home/user' });
  assert.equal(whole.stdout.slice(-2), 'aé', 'exec\'s stdout has é whole');
  const counted = await ws.exec('x=$(cat split.txt); echo ${#x}', { cwd: '/home/user' });
  assert.equal(counted.stdout, '65536\n', '$( ) has é as one character');
  await ws.fs.writeFile('/home/user/invalid.bin', Uint8Array.of(0x61, 0xff, 0x62));
  const invalid = await ws.exec('cat invalid.bin', { cwd: '/home/user' });
  assert.equal(invalid.stdout, 'a\udcffb', 'an invalid byte still maps alone, losslessly');
  console.log('  ✓ a character split between writes is captured whole; an invalid byte still maps alone');

  const streamed = [];
  await ws.fs.writeFile('/home/user/unfinished.bin', Uint8Array.of(0x61, 0x62, 0xc3));
  const tail = await ws.exec('cat unfinished.bin', { cwd: '/home/user', onStdout: (bytes) => { streamed.push(...bytes); } });
  assert.deepEqual(streamed, [0x61, 0x62, 0xc3], 'the stream gets the bytes as they are');
  assert.equal(tail.stdout, 'ab\ufffd', 'the streamed exec\'s result ends its decoder: the unfinished character is a replacement');
  console.log('  ✓ a streamed exec\'s result ends with what its last unfinished character decodes to');
} finally {
  await ws.close();
}
console.log('shell-capture-decoding: ok');
