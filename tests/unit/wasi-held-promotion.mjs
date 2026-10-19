#!/usr/bin/env bun
/**
 * A file a grant decides alone (the holder's cell) and the provisional
 * decisions (§11, rev 6): one owner per file, and every byte read through
 * one owner-aware source.
 *   - its bytes given back with no descriptor open are not the view's until
 *     a barrier covers them: a read that cannot wait, by a new descriptor
 *     or a copy, is the new bytes or EAGAIN, never the old;
 *   - a copy that cannot wait reads a held source's bytes from its cell,
 *     cold or once resident, to a destination no grant holds;
 *   - a change the budget refuses leaves a held file with a descriptor open
 *     the grant's: nothing of it moved or logged for a failed call.
 */

import assert from 'node:assert/strict';
import { withRecall } from '../../packages/core/src/vfs/recall.ts';
import { session } from './lib/holder-session.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Resolves once `ready()` answers, polling. */
async function until(ready, what) {
  for (let i = 0; i < 400; i++) {
    const value = ready();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never: ${what}`);
}

/** `fn`'s errno, or null. */
async function errnoOf(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error?.code ?? String(error);
  }
}

/** A run's write of `text` to `path`, emptied first, through a descriptor it closes. */
async function rewrite(fs, path, text) {
  const handle = await fs.open(path, { write: true, create: true, truncate: true, mode: 0o644 });
  await fs.write(handle.id, null, enc.encode(text));
  await fs.close(handle.id);
}

/** A session whose process holds home/user/proj (a first change there takes it). */
async function holding(options) {
  const s = session({ view: {}, ...options });
  await rewrite(s.fs, '/home/user/proj/warm', 'w');
  await until(() => s.filesystem.delegations.size === 1, 'the subtree taken');
  return s;
}

// ── An overwritten resident file given back with no descriptor: a new descriptor or a copy reads NEW or EAGAIN, never OLD ──
{
  const s = session({ view: {} });
  s.kernel.writeFile('home/user/proj/a', 'OLD1');
  s.kernel.chown('home/user/proj/a', 1000, 1000);
  // Resident: the view reads it.
  assert.equal(dec.decode(await s.fs.readFile('/home/user/proj/a')), 'OLD1');
  await rewrite(s.fs, '/home/user/proj/warm', 'w');
  await until(() => s.filesystem.delegations.size === 1, 'the subtree taken');
  // Same size, under the grant: the holder's cell, no descriptor left open.
  await rewrite(s.fs, '/home/user/proj/a', 'NEW1');
  // A peer's change recalls the grant: given back, before any barrier.
  await withRecall(() => s.kernel.writeFile('home/user/proj/peer', 'p'));
  await until(() => s.filesystem.delegations.size === 0, 'the grant given back');
  const sync = s.fs.synchronous;
  let read;
  const opened = await errnoOf(() => {
    const handle = sync.open('/home/user/proj/a', { read: true });
    read = sync.read(handle.id, 0, 16);
    sync.close(handle.id);
  });
  if (opened !== 'EAGAIN') {
    assert.equal(opened, null, 'a new read-only descriptor of the given-back file');
    assert.equal(dec.decode(read), 'NEW1', 'a new descriptor read the old bytes of a file given back');
  }
  const copied = await errnoOf(() => sync.copyFile('/home/user/proj/a', '/tmp/a-copy'));
  if (copied !== 'EAGAIN') {
    assert.equal(copied, null, 'a copy of the given-back file');
    await s.fs.settle();
    assert.equal(s.kernel.readFileString('tmp/a-copy'), 'NEW1', 'a copy took the old bytes of a file given back');
  }
  await s.fs.settle();
}

// ── A copy that cannot wait reads a held source from its cell, cold or once resident ──
{
  const s = session({ view: {} });
  // Resident before the grant.
  s.kernel.writeFile('home/user/proj/warm2', 'OLD2');
  s.kernel.chown('home/user/proj/warm2', 1000, 1000);
  assert.equal(dec.decode(await s.fs.readFile('/home/user/proj/warm2')), 'OLD2');
  await rewrite(s.fs, '/home/user/proj/warm', 'w');
  await until(() => s.filesystem.delegations.size === 1, 'the subtree taken');
  // Cold: made under the grant, never the view's.
  await rewrite(s.fs, '/home/user/proj/cold', 'NEWC');
  assert.equal(await errnoOf(() => s.fs.synchronous.copyFile('/home/user/proj/cold', '/tmp/cold-copy')), null, 'a copy of a held source its cell has the bytes of');
  // Rewritten same-size under the grant.
  await rewrite(s.fs, '/home/user/proj/warm2', 'NEW2');
  assert.equal(await errnoOf(() => s.fs.synchronous.copyFile('/home/user/proj/warm2', '/tmp/warm2-copy')), null, 'a copy of a held source once resident');
  await s.fs.settle();
  assert.equal(s.kernel.readFileString('tmp/cold-copy'), 'NEWC');
  assert.equal(s.kernel.readFileString('tmp/warm2-copy'), 'NEW2', 'a copy took the resident bytes of a held source, not its cell');
}

// ── A change the budget refuses leaves a held file with a descriptor open the grant's ──
for (const change of ['open', 'rename', 'unlink']) {
  const budget = { used: 0, limit: 1 << 30 };
  const s = await holding({ budget });
  const handle = await s.fs.open('/home/user/proj/h', { write: true, create: true, truncate: true, mode: 0o644 });
  await s.fs.write(handle.id, null, enc.encode('held'));
  const sync = s.fs.synchronous;
  const ops = s.fs.stats().client.ops;
  // No room: anything the provisional decisions would admit is refused.
  budget.limit = budget.used;
  const code = await errnoOf(() => {
    if (change === 'open') sync.open('/home/user/proj/h', { read: true });
    // To a subtree the grant does not hold: the provisional decisions' to decide.
    else if (change === 'rename') sync.rename('/home/user/proj/h', '/tmp/h');
    else sync.unlink('/home/user/proj/h');
  });
  budget.limit = 1 << 30;
  if (code === null) continue;
  assert.equal(code, 'ENOSPC', `${change}: refused`);
  assert.equal(s.fs.stats().client.ops, ops, `${change}: a refused change moved the held file (its descriptor's open logged)`);
  // Still the grant's: its descriptor writes here, and the session has its bytes once sent.
  await s.fs.write(handle.id, null, enc.encode('!'));
  await s.fs.close(handle.id);
  await s.fs.settle();
  assert.equal(s.kernel.readFileString('home/user/proj/h'), 'held!', `${change}: the held file's bytes`);
}

console.log('ok - wasi-held-promotion');
