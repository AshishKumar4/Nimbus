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

/** A provisional overlay over a view holding `/` and `/p`, whose session answers each logged op when the test says. */
function overlay() {
  const rows = new Map([['', directory(1)], ['p', directory(2)]]);
  const pending = [];
  let handles = -1;
  const decisions = provisional({
    device: 1,
    cred: { uid: 1000, gid: 1000, groups: [1000] },
    row: (key) => (rows.has(key) ? rows.get(key) : null),
    children: () => [],
    content: () => undefined,
    reserve: () => true,
    release: () => {},
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
    settled: () => false,
  });
  const answer = async (outcome) => {
    pending.shift().resolve(outcome);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { decisions, rows, pending, answer };
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

console.log('provisional-decisions: ok');
