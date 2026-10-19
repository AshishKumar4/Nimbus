#!/usr/bin/env bun
/**
 * A descriptor names its file by identity (dev, ino), never by a name it
 * once had: what a call that cannot wait answers through it is that file's,
 * as the view has it.
 *   - a peer renames the file and writes it: once the view takes in its new
 *     name, the descriptor's fstat and read are that file's;
 *   - the view's row and the descriptor's change in the same turn: an fstat
 *     inside the barrier that takes the row in sees it;
 *   - a view started anew knows neither the name nor the file: the
 *     descriptor's fstat is refused as a stat by that name is (EAGAIN), and
 *     answers once the name is looked up again;
 *   - a peer's move to a longer name the budget has no room for is not kept
 *     (what is taken stays what is kept): the descriptor answers by identity
 *     alone until a move is kept.
 */

import assert from 'node:assert/strict';
import { session } from './lib/holder-session.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const OTHER = 'home/user/other';
/** No grant comes: what a call that cannot wait decides is the provisional decisions'. */
const never = new Promise(() => {});

async function errnoOf(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error?.code ?? String(error);
  }
}

/** A file of the process's at `name`, `text` in it, read once so the view holds it. */
async function resident(s, name, text) {
  s.kernel.writeFile(`${OTHER}/${name}`, text);
  s.kernel.chown(`${OTHER}/${name}`, 1000, 1000);
  await s.fs.readFile(`/${OTHER}/${name}`);
}

// ── A peer renames the file a descriptor has open, and writes it there ──
{
  const s = session({ view: {}, acquired: never });
  const sync = s.fs.synchronous;
  await resident(s, 'a', 'x');
  const fd = sync.open(`/${OTHER}/a`, { read: true }).id;
  s.kernel.rename(`${OTHER}/a`, `${OTHER}/b`);
  s.kernel.writeFile(`${OTHER}/b`, 'peer');
  // A barrier, and the new name looked up: the view has the file at b.
  s.fs.inbound();
  await s.fs.readFile(`/${OTHER}/b`);
  assert.equal(Number(sync.fstat(fd).size), 4, 'fstat through the descriptor');
  assert.equal(dec.decode(sync.read(fd, 0, 16)), 'peer', 'read through the descriptor');
  sync.close(fd);
}

// ── The view's row and the descriptor's in the same turn ──
{
  let inside = null;
  const s = session({ view: { barrier: () => inside?.() }, acquired: never });
  const sync = s.fs.synchronous;
  await resident(s, 'a', 'x');
  // Read (absent) before: the barrier reads it again.
  assert.equal(await s.fs.stat(`/${OTHER}/b`), null);
  const fd = sync.open(`/${OTHER}/a`, { read: true }).id;
  s.kernel.rename(`${OTHER}/a`, `${OTHER}/b`);
  s.kernel.writeFile(`${OTHER}/b`, 'grown');
  let seen;
  inside = () => { seen = Number(sync.fstat(fd).size); };
  s.fs.inbound();
  await s.fs.stat(`/${OTHER}`);
  inside = null;
  assert.equal(seen, 5, 'fstat within the barrier that took the row in');
  sync.close(fd);
}

// ── A view started anew ──
{
  let forget = false;
  const s = session({ view: { forget: () => forget }, acquired: never });
  const sync = s.fs.synchronous;
  await resident(s, 'a', 'x');
  const fd = sync.open(`/${OTHER}/a`, { read: true }).id;
  forget = true;
  s.fs.inbound();
  await s.fs.stat(`/${OTHER}`);
  forget = false;
  assert.equal(await errnoOf(() => sync.stat(`/${OTHER}/a`)), 'EAGAIN', 'a stat by the name the view no longer knows');
  assert.equal(await errnoOf(() => sync.fstat(fd)), 'EAGAIN', 'fstat of the file the view no longer knows: as a stat by its name');
  // Looked up again by a call that may wait: both answer.
  await s.fs.stat(`/${OTHER}/a`);
  assert.equal(Number(sync.stat(`/${OTHER}/a`).size), 1);
  assert.equal(Number(sync.fstat(fd).size), 1, 'fstat once the view has the file again');
  sync.close(fd);
}

// ── A peer renames a file a descriptor has open to a longer name, the budget full ──
// Its names are a cache: the move it has no room for is not kept, and its descriptor answers by identity alone.
{
  const budget = { used: 0, limit: 1 << 30 };
  const s = session({ view: {}, acquired: never, budget });
  const sync = s.fs.synchronous;
  const kept = () => {
    const stats = s.fs.stats();
    return stats.provisionalBytes + stats.pinnedBytes;
  };
  await resident(s, 'a', 'x');
  const fd = sync.open(`/${OTHER}/a`, { read: true }).id;
  const longer = `/${OTHER}/a-renamed-by-a-peer-to-a-much-longer-name`;
  s.kernel.rename(`${OTHER}/a`, longer.slice(1));
  budget.limit = budget.used;
  s.fs.inbound();
  await s.fs.stat(longer);
  assert.equal(budget.used, kept(), 'the budget full: what is taken is what is kept');
  assert.equal(await errnoOf(() => sync.fstat(fd)), 'EAGAIN', 'a file whose move was not kept: as where the view cannot say');
  budget.limit = 1 << 30;
  s.fs.inbound();
  await s.fs.stat(longer);
  assert.equal(budget.used, kept(), 'with room: what is taken is what is kept');
  assert.equal(Number(sync.fstat(fd).size), 1, 'with room, the move is kept');
  sync.close(fd);
}

console.log('ok - wasi-fd-identity');
