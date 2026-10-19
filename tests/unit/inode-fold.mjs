#!/usr/bin/env bun
// An inode as the process sees it with its own operations pending (rev 5
// §0.2): its baseline with each operation folded over it, in log order. The
// one fold serves an appended operation, a re-fold after a refusal, and a
// merge. Plain values only.

import assert from 'node:assert/strict';
import { applyOp, foldOps } from '../../packages/core/src/runtime/wasi/inode-fold.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const base = (text, extra = {}) => ({ bytes: enc.encode(text), size: enc.encode(text).byteLength, mode: 0o100644, uid: 1000, gid: 1000, atime: 1, mtime: 1, ctime: 1, ...extra });
const text = (state) => dec.decode(state.bytes.subarray(0, state.size));
const write = (offset, data, at = 2) => ({ kind: 'write', offset, data: enc.encode(data), at });
const append = (data, at = 2) => ({ kind: 'append', data: enc.encode(data), at });
const truncate = (size, at = 2) => ({ kind: 'truncate', size, at });

// Writes, appends, holes and truncates.
assert.equal(text(foldOps(base('ab'), [write(0, 'Y')])), 'Yb');
assert.equal(text(foldOps(base('ab'), [append('X')])), 'abX');
assert.deepEqual([...foldOps(base('ab'), [write(4, 'Z')]).bytes.subarray(0, 5)], [97, 98, 0, 0, 90]);
assert.equal(text(foldOps(base('abcdef'), [truncate(2), append('Q')])), 'abQ');
assert.deepEqual([...foldOps(base('abcdef'), [truncate(2), truncate(4)]).bytes.subarray(0, 4)], [97, 98, 0, 0]);

// The baseline is not changed by a fold over it.
const kept = base('ab');
foldOps(kept, [write(0, 'ZZZZ')]);
assert.equal(text(kept), 'ab');

// A refused operation leaves, and the rest re-fold from the baseline: never a value computed from it.
const r1 = append('X');
const r2 = write(0, 'Y');
assert.equal(text(foldOps(base('ab'), [r1, r2])), 'YbX');
assert.equal(text(foldOps(base('ab'), [r2])), 'Yb');

// Appended one at a time, the fold is the same as from the baseline.
const ops = [write(0, 'hello'), append(' world'), truncate(8), write(2, 'LL'), append('!')];
let state = foldOps(base(''), []);
for (const op of ops) state = applyOp(state, op);
assert.equal(text(state), text(foldOps(base(''), ops)));
assert.equal(text(state), 'heLLo wo!');

// A chown by anyone but root clears the set-id bits, from what precedes it.
const chmod = (mode) => ({ kind: 'chmod', mode, at: 3 });
const chown = (uid, gid, by) => ({ kind: 'chown', uid, gid, by, at: 4 });
assert.equal(foldOps(base(''), [chmod(0o4755), chown(1000, null, 1000)]).mode & 0o7777, 0o755);
assert.equal(foldOps(base(''), [chmod(0o4755)]).mode & 0o7777, 0o4755, 'the chown refused: its clearing goes with it');
assert.equal(foldOps(base(''), [chown(1000, null, 1000)]).mode & 0o7777, 0o644, 'the chmod refused: its set-id bit goes with it');
assert.equal(foldOps(base(''), [chmod(0o4755), chown(1000, null, 0)]).mode & 0o7777, 0o4755, 'root keeps them');
assert.deepEqual([foldOps(base(''), [chown(null, 50, 1000)]).uid, foldOps(base(''), [chown(null, 50, 1000)]).gid], [1000, 50]);

// Times: explicit, now, and kept.
const times = foldOps(base(''), [{ kind: 'utimes', atime: 'omit', mtime: 9_000, at: 7 }]);
assert.deepEqual([times.atime, times.mtime, times.ctime], [1, 9_000, 7]);
assert.deepEqual([foldOps(base(''), [{ kind: 'utimes', atime: 'now', mtime: 'now', at: 8 }]).atime], [8]);

// Bytes the view does not hold: their size and attributes still fold.
const blind = foldOps(base('', { bytes: null, size: 10 }), [write(8, 'abcd'), chmod(0o600)]);
assert.deepEqual([blind.bytes, blind.size, blind.mode & 0o7777], [null, 12, 0o600]);

// Truncated to nothing, unknown bytes are known: none. What is written after them is all there is.
const emptied = foldOps(base('', { bytes: null, size: 10 }), [truncate(0), write(0, 'NEW')]);
assert.deepEqual([text(emptied), emptied.size], ['NEW', 3]);
assert.deepEqual(text(foldOps(base('', { bytes: null, size: 10 }), [truncate(0), { kind: 'append', data: enc.encode('ab'), at: 5 }, write(4, 'z')])), 'ab\0\0z');
// No bytes written or appended: nothing changes, past the end or at it.
const still = base('abc');
const unchanged = foldOps(still, [write(9, ''), { kind: 'append', data: new Uint8Array(0), at: 9 }]);
assert.deepEqual([text(unchanged), unchanged.size, unchanged.mtime, unchanged.ctime], ['abc', 3, still.mtime, still.ctime]);

console.log('inode-fold: ok');
