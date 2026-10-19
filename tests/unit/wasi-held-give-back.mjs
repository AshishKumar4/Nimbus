#!/usr/bin/env bun
/**
 * A file a grant decides (its cell) across give-backs, and the provisional
 * decisions beside it:
 *   - its bytes given back with no descriptor open are not the view's until
 *     a barrier covers them: a read that cannot wait, by a new descriptor
 *     or a copy, is the new bytes or EAGAIN, never the old;
 *   - a copy that cannot wait reads a held source's bytes from its cell,
 *     cold or once resident, to a destination no grant holds;
 *   - a change refused, for room or permission, by name or through a
 *     descriptor of a held file, changes nothing, and the file's
 *     descriptor writes on as before;
 *   - a grant's rename above a file the provisional decisions changed, while
 *     a barrier begun before it lands: the moved decision stays (newer than
 *     the barrier's answer), with what they made of the file;
 *   - a decision given back, then moved under a later grant before the
 *     barrier its give-back waits on lands, stays;
 *   - a held directory renamed to a longer name, the budget full: what its
 *     files' names grow by is admitted first, or the rename is refused with
 *     nothing done; what is taken of the budget is always what is kept.
 */

import assert from 'node:assert/strict';
import { withRecall } from '../../packages/core/src/vfs/recall.ts';
import { ownNames } from '../../packages/core/src/runtime/wasi/own-names.ts';
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

/** A session whose process holds home/user/proj (a first change there takes it), `prepare` given its kernel first. */
async function holding({ prepare, ...options } = {}) {
  const s = session({ view: {}, ...options });
  prepare?.(s.kernel);
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

// ── A change refused, for room or permission, of a held file with a descriptor open changes nothing ──
// By name (open, rename, unlink, chmod) and through its descriptor (fchmod; fchown and futimes the grant declines).
// `refusal`: its errno, or null where it may also succeed.
for (const [change, refusal] of [['open', null], ['rename', null], ['unlink', null], ['chmod', 'ENOSPC'], ['fchmod', 'ENOSPC'], ['fchown', 'EPERM'], ['futimes', 'EPERM']]) {
  const budget = { used: 0, limit: 1 << 30 };
  // Another's file the process may write: its times are not the process's to set (futimes).
  const s = await holding({ budget, prepare: change !== 'futimes' ? undefined : (kernel) => {
    kernel.writeFile('home/user/proj/h', 'x');
    kernel.chown('home/user/proj/h', 2000, 2000);
    kernel.chmod('home/user/proj/h', 0o666);
  } });
  const handle = await s.fs.open('/home/user/proj/h', { write: true, create: true, truncate: true, mode: 0o644 });
  await s.fs.write(handle.id, null, enc.encode('held'));
  const sync = s.fs.synchronous;
  const before = sync.stat('/home/user/proj/h');
  // No room: anything the provisional decisions would admit is refused.
  budget.limit = budget.used;
  const code = await errnoOf(() => {
    if (change === 'open') sync.open('/home/user/proj/h', { read: true });
    // To a subtree the grant does not hold: the provisional decisions' to decide.
    else if (change === 'rename') sync.rename('/home/user/proj/h', '/tmp/h');
    else if (change === 'unlink') sync.unlink('/home/user/proj/h');
    else if (change === 'chmod') sync.chmod('/home/user/proj/h', 0o600);
    else if (change === 'fchmod') sync.fchmod(handle.id, 0o600);
    else if (change === 'fchown') sync.fchown(handle.id, 0, -1);
    else sync.futimes(handle.id, 1_600_000_000_000, 1_600_000_000_000);
  });
  budget.limit = 1 << 30;
  if (refusal === null && code === null) continue;
  assert.equal(code, refusal ?? 'ENOSPC', `${change}: refused`);
  const after = sync.stat('/home/user/proj/h');
  assert.deepEqual([after.ino, after.mode, after.uid, Number(after.mtime)], [before.ino, before.mode, before.uid, Number(before.mtime)], `${change}: a refused change changed the file`);
  assert.equal(sync.stat('/tmp/h'), null, `${change}: a refused rename moved the file`);
  // Its descriptor writes on, and the session has its bytes once sent.
  await s.fs.write(handle.id, null, enc.encode('!'));
  await s.fs.close(handle.id);
  await s.fs.settle();
  assert.equal(s.kernel.readFileString('home/user/proj/h'), 'held!', `${change}: the held file's bytes`);
}

// ── A grant's rename above a file the provisional decisions changed, while a barrier begun before it lands ──
// Its decision of the file, moved, is newer than that barrier's answer: it stays, with what they made of the file.
{
  let land;
  let pausing = false;
  const s = await holding({
    view: { barrier: () => (pausing ? new Promise((resolve) => { land = resolve; }) : undefined) },
    prepare: (kernel) => {
      kernel.mkdir('home/user/proj/p');
      kernel.chown('home/user/proj/p', 1000, 1000);
      kernel.writeFile('home/user/proj/p/f', 'ab');
      kernel.chown('home/user/proj/p/f', 1000, 1000);
    },
  });
  const sync = s.fs.synchronous;
  await s.fs.readFile('/home/user/proj/p/f');
  // Opened to write, neither made nor emptied: the provisional decisions' descriptor.
  const fd = sync.open('/home/user/proj/p/f', { read: true, write: true });
  await s.fs.chmod('/home/user/proj/p/f', 0o640);
  sync.write(fd.id, 0, enc.encode('xyz'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  // A barrier begins (a call that may wait catches up), and waits.
  pausing = true;
  const catching = s.fs.stat('/home/user/proj/p/f').catch(() => null);
  await until(() => land !== undefined, 'the barrier begun');
  pausing = false;
  sync.rename('/home/user/proj/p', '/home/user/proj/q');
  land();
  await catching;
  const now = sync.stat('/home/user/proj/q/f');
  assert.deepEqual([now.size, now.mode & 0o777], [3, 0o640], 'what a call that cannot wait sees of the moved file');
  const waited = await s.fs.stat('/home/user/proj/q/f');
  assert.deepEqual([waited.size, waited.mode & 0o777], [3, 0o640], 'what a call that may wait sees of the moved file');
  sync.close(fd.id);
  await s.fs.settle();
  assert.equal(s.kernel.readFileString('home/user/proj/q/f'), 'xyz', 'the moved file\'s bytes');
  assert.equal(s.kernel.stat('home/user/proj/q/f').mode & 0o777, 0o640, 'the moved file\'s mode');
}

// ── A decision given back, then moved under a later grant before the barrier its give-back waits on lands: it stays ──
{
  const names = ownNames({ entry: () => undefined, forgot: () => {} });
  const row = { type: 'file', dev: 1, ino: 9, nlink: 1, size: 3, atime: 1, mtime: 1, ctime: 1, mode: 0o100644, uid: 1000, gid: 1000, revision: 0, target: null };
  names.decide('p/d/f', row);
  names.released('p');
  const begun = names.barrierBegun();
  names.move('p/d', 'p/e');
  names.retire(begun);
  assert.equal(names.entry('p/e/f'), row, 'a moved decision was forgotten by the give-back marker of its old name');
  // Not moved, it retires then.
  names.decide('p/g', row);
  names.released('p');
  names.retire(names.barrierBegun());
  assert.equal(names.entry('p/g'), undefined, 'a decision given back stayed after a barrier begun after it landed');
}

// ── A held directory renamed to a longer name with files open beneath it, the budget full, then with room ──
{
  const budget = { used: 0, limit: 1 << 30 };
  const s = await holding({ budget });
  const sync = s.fs.synchronous;
  const kept = () => {
    const stats = s.fs.stats();
    return stats.provisionalBytes + stats.pinnedBytes;
  };
  sync.mkdir('/home/user/proj/d');
  const handles = [];
  for (let i = 0; i < 3; i++) {
    const handle = sync.open(`/home/user/proj/d/f${i}`, { write: true, create: true, truncate: true, mode: 0o644 });
    sync.write(handle.id, null, enc.encode(`f${i}`));
    handles.push(handle);
  }
  assert.equal(budget.used, kept(), 'before: what is taken is what is kept');
  const longer = '/home/user/proj/d-renamed-to-a-much-longer-name';
  budget.limit = budget.used;
  const code = await errnoOf(() => sync.rename('/home/user/proj/d', longer));
  budget.limit = 1 << 30;
  assert.equal(budget.used, kept(), `a rename the budget had no room for (${code}): what is taken is what is kept`);
  assert.equal(code, 'ENOSPC', 'a rename whose names have no room is refused');
  assert.ok(sync.stat('/home/user/proj/d/f0') !== null && sync.stat(`${longer}/f0`) === null, 'a refused rename moved nothing');
  assert.equal(await errnoOf(() => sync.rename('/home/user/proj/d', longer)), null, 'with room');
  assert.equal(budget.used, kept(), 'renamed: what is taken is what is kept');
  for (const handle of handles) sync.close(handle.id);
  await s.fs.settle();
  assert.equal(s.kernel.readFileString(`${longer.slice(1)}/f2`), 'f2', 'its files moved with it');
}

console.log('ok - wasi-held-give-back');
