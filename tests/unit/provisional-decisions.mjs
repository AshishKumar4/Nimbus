#!/usr/bin/env bun
// What a caller that cannot wait decides where no held subtree does
// (provisional.ts), over a view and a session of plain values: when its
// records leave the overlay. One the session refused leaves at once (the
// session never applied it); one answered, or whose fate is unknown (a lost
// epoch, the process ended), stays until a barrier that began after its
// answer lands, so the view has the session's version first.

import assert from 'node:assert/strict';
import { provisional } from '../../packages/core/src/runtime/wasi/provisional.ts';

const directory = (ino) => ({ type: 'directory', dev: 1, ino, nlink: 2, size: 0, atime: 1, mtime: 1, ctime: 1, mode: 0o40755, uid: 1000, gid: 1000, revision: 1, target: null });

/** A provisional overlay over a view holding `/` and `/p`, whose session answers each logged op when the test says; `budget` counts what it takes. */
function overlay(budget = { used: 0 }) {
  const rows = new Map([['', directory(1)], ['p', directory(2)]]);
  const contents = new Map();
  const pending = [];
  let handles = -1;
  const decisions = provisional({
    device: 1,
    cred: { uid: 1000, gid: 1000, groups: [1000] },
    row: (key) => (rows.has(key) ? rows.get(key) : null),
    children: () => [],
    content: (key) => contents.get(key),
    reserve: (bytes) => { budget.used += bytes; return true; },
    release: (bytes) => { budget.used -= bytes; },
    client: {
      submit: (op) => new Promise((resolve) => { pending.push({ op, resolve }); }),
      fitsSync: () => {},
    },
    drain: () => {},
    sent: () => {},
    active: () => {},
    held: () => false,
    count: () => {},
    umask: () => 0o022,
    now: () => 5,
    nextHandle: () => handles--,
    // As the holder hands a grant's file over (no description of its own opened here).
    unhold: (inode) => decisions.unhold(inode, inode.row),
    // No grant decides anything here: nothing to settle or absorb.
    generation: () => undefined,
    settled: () => false,
    absorb: () => undefined,
  });
  const answer = async (outcome) => {
    pending.shift().resolve(outcome);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { decisions, rows, contents, pending, answer };
}

for (const [fate, outcome] of [
  ['answered', {}],
  ['of unknown fate', { failed: { errno: 'EIO', message: 'the session lost the epoch it was sent in' } }],
]) {
  const { decisions, answer } = overlay();
  assert.equal(decisions.mkdir('p/d', '/p/d', 0o755, null, undefined), true);
  assert.equal(decisions.entry('p/d')?.type, 'directory');
  // A barrier that began before the answer does not retire it.
  const before = decisions.barrierBegun();
  await answer(outcome);
  decisions.retire(before);
  assert.equal(decisions.entry('p/d')?.type, 'directory', `a record ${fate} left before the view could have it`);
  // One that began after it does.
  decisions.retire(decisions.barrierBegun());
  assert.equal(decisions.entry('p/d'), undefined, `a record ${fate} stayed after the view had the session's version`);
}

{
  const { decisions, answer } = overlay();
  decisions.mkdir('p/d', '/p/d', 0o755, null, undefined);
  await answer({ failed: { errno: 'EACCES', message: 'refused', refused: true } });
  assert.equal(decisions.entry('p/d'), undefined, 'a refused record stayed in the overlay');
}

// A grant's file given back keeps the bytes it was written, charged as kept: not the room the grant drew for more.
{
  const budget = { used: 0 };
  const { decisions } = overlay(budget);
  const row = { type: 'file', dev: 1, ino: 9, nlink: 1, size: 0, atime: 1, mtime: 1, ctime: 1, mode: 0o100644, uid: 1000, gid: 1000, revision: 1, target: null };
  const inode = decisions.inodeFor('p/f', row);
  const room = new Uint8Array(4096);
  room[0] = 7;
  decisions.hold(inode, { bytes: room, length: 1, mode: 0o644 });
  const before = budget.used;
  decisions.unhold(inode, row);
  assert.equal(budget.used, decisions.kept(), 'what is taken of the budget is what is kept');
  assert.ok(budget.used - before >= inode.base.bytes.buffer.byteLength, `a given-back file keeps ${inode.base.bytes.buffer.byteLength} bytes, charged ${budget.used - before}`);
  assert.deepEqual([...decisions.content(row)], [7], 'its bytes');
}

// Every op the session resolves by name carries the file it was decided on (none, for a file it makes): the session
// refuses one whose name leads elsewhere, and its refusal leaves what was decided undone.
{
  const { decisions, rows, pending, answer } = overlay();
  const file = (ino) => ({ type: 'file', dev: 1, ino, nlink: 1, size: 0, atime: 1, mtime: 1, ctime: 1, mode: 0o100644, uid: 1000, gid: 1000, revision: 1, target: null });
  for (const [key, ino] of [['p/a', 11], ['p/b', 12], ['p/c', 13], ['p/e', 14]]) rows.set(key, file(ino));
  rows.set('p/d', directory(15));
  decisions.open('p/a', '/p/a', { write: true, truncate: true }, rows.get('p/a'));
  decisions.open('p/n', '/p/n', { write: true, create: true }, null);
  decisions.open('p/x', '/p/x', { write: true, create: true, exclusive: true }, null);
  decisions.unlink('p/b', '/p/b', rows.get('p/b'));
  decisions.rmdir('p/d', '/p/d', rows.get('p/d'));
  decisions.rename('p/c', 'p/e', '/p/c', rows.get('p/c'), rows.get('p/e'));
  decisions.setattr('p/a', '/p/a', { mode: 0o600 }, rows.get('p/a'));
  const expected = pending.map(({ op }) => (op.type === 'call' ? [op.call.call, op.call.path, op.call.expect] : op.type === 'rename' ? ['rename', op.from, op.expect, op.expectTo] : [op.type, op.path, op.expect]));
  assert.deepEqual(expected, [
    ['open', 'p/a', 11],
    ['open', 'p/n', null],
    ['open', 'p/x', undefined],
    ['unlink', 'p/b', 12],
    ['rmdir', 'p/d', 15],
    ['rename', 'p/c', 13, 14],
    ['setattr', 'p/a', 11],
  ], 'what each op expects at its names');
  // The rename refused (its source led elsewhere): the names are as they were.
  while (pending.length > 0) {
    const { op } = pending[0];
    await answer(op.type === 'rename' ? { failed: { errno: 'ENOENT', message: 'the name leads elsewhere', refused: true } } : {});
  }
  assert.equal(decisions.entry('p/c'), undefined, 'a refused rename left its source decided');
  assert.equal(decisions.entry('p/e'), undefined, 'a refused rename left its target decided');
}

// A whole write's payload is what the session is sent, unchanged, when a later change to its file is decided before the wave
// goes: the state shares the payload until a change copies it (copy-on-write), and the payload is charged once, not twice.
{
  const budget = { used: 0 };
  const { decisions, rows, pending } = overlay(budget);
  const row = { type: 'file', dev: 1, ino: 21, nlink: 1, size: 0, atime: 1, mtime: 1, ctime: 1, mode: 0o100644, uid: 1000, gid: 1000, revision: 1, target: null };
  rows.set('p/w', row);
  const payload = Uint8Array.from({ length: 64 * 1024 }, (_, i) => i & 0xff);
  const handle = decisions.open('p/w', '/p/w', { write: true, truncate: true }, row);
  const before = budget.used;
  decisions.write(handle.id, 0, payload);
  const charged = budget.used - before;
  assert.ok(charged >= payload.byteLength && charged < 2 * payload.byteLength, `a whole write is charged once: ${charged} bytes for ${payload.byteLength}`);
  decisions.write(handle.id, 2, Uint8Array.of(9, 9));
  decisions.setStatus(handle.id, { append: true });
  decisions.write(handle.id, null, Uint8Array.of(10, 11));
  const sent = pending.map(({ op }) => op.call).filter((call) => call.call === 'write' || call.call === 'append');
  assert.deepEqual(sent.map((call) => call.call), ['write', 'write', 'append']);
  assert.deepEqual(sent[0].data, payload, 'the whole write is sent as it was written, before the change decided after it');
  assert.deepEqual([...sent[1].data], [9, 9], 'the in-place write is sent at its offset');
  assert.deepEqual([...sent[2].data], [10, 11], 'the append is sent');
  const expected = new Uint8Array(payload.byteLength + 2);
  expected.set(payload);
  expected.set([9, 9], 2);
  expected.set([10, 11], payload.byteLength);
  assert.deepEqual(decisions.content(row), expected, 'the bytes the process sees are the ones it wrote');
}

console.log('provisional-decisions: ok');
