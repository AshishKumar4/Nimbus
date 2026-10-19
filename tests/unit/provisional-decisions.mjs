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

// A late receipt naming a file a grant holds (its cell), named or not: what was made through that open folds into its
// one content, the cell's bytes handed over first; its descriptors read and write that content, and through a
// description the session has of it.
for (const detached of [false, true]) {
  for (const truncate of [false, true]) {
    const label = `${detached ? 'a detached' : 'a named'} held file, ${truncate ? 'O_TRUNC' : 'no O_TRUNC'}`;
    const { decisions, rows, contents, pending, answer } = overlay();
    const row = { type: 'file', dev: 1, ino: 9, nlink: 1, size: 3, atime: 1, mtime: 1, ctime: 1, mode: 0o100644, uid: 1000, gid: 1000, revision: 1, target: null };
    rows.set('p/h', row);
    contents.set('p/h', new TextEncoder().encode('OLD'));
    const inode = decisions.inodeFor('p/h', row);
    const room = new Uint8Array(16);
    room.set(new TextEncoder().encode('HELD-LONG'));
    decisions.hold(inode, { bytes: room, length: 9, mode: 0o644, ...(detached ? { detached: { ...row, nlink: 0, size: 9 } } : {}) });
    const held = decisions.heldDescriptor(inode, '/p/h', true, false);
    // Through a name the view has as absent, the session's open of which reaches the held file.
    const opened = decisions.open('p/x', '/p/x', { read: true, write: true, create: true, truncate }, null);
    assert.equal(decisions.write(opened.id, 0, new TextEncoder().encode('ab')), 2);
    while (pending.length > 0) {
      const { op } = pending[0];
      await answer(op.type === 'call' && op.call.call === 'open'
        ? { receipt: { dev: 1, ino: 9, size: truncate ? 0 : 9, mode: 0o100644, uid: 1000, gid: 1000, mtimeMs: 2, ctimeMs: 2, handle: 5 } }
        : {});
    }
    const expected = truncate ? 'ab' : 'abLD-LONG';
    assert.equal(inode.cell, undefined, `${label}: a cell beside the fold the receipt's effects went into`);
    for (const [fd, name] of [[held.id, 'the held descriptor'], [opened.id, 'the reconciled descriptor']]) {
      assert.equal(new TextDecoder().decode(decisions.read(fd, 0, 64)), expected, `${label}: ${name} reads`);
      assert.equal(decisions.fstat(fd).size, expected.length, `${label}: ${name}'s fstat`);
    }
    decisions.write(held.id, 0, new TextEncoder().encode('Z'));
    assert.equal(new TextDecoder().decode(decisions.read(opened.id, 0, 64)), `Z${expected.slice(1)}`, `${label}: a write through the held descriptor`);
    assert.ok('description' in pending.at(-1).op.call, `${label}: the held descriptor writes through a description the session has of the file`);
  }
}

console.log('provisional-decisions: ok');
