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
 *     alone until a move is kept;
 *   - the process's own bytes, answered, a peer's write, then a barrier that
 *     admits the row without bytes: the descriptor reads the peer's version
 *     or EAGAIN, never its own bytes stamped as the peer's;
 *   - a file made here whose creating answer is late, renamed by a peer and
 *     opened at the new name the view admitted: one owner, one content; and
 *     opened twice before that answer: both answers settle on that owner,
 *     and nothing is kept once all is closed and the view has it.
 */

import assert from 'node:assert/strict';
import { session } from './lib/holder-session.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const OTHER = 'home/user/other';
/** The session grants nothing (EBUSY): what a call that cannot wait decides is the provisional decisions'. */
const refusing = { then: (_resolve, reject) => reject(Object.assign(new Error('EBUSY: another holds it'), { code: 'EBUSY' })) };

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
  const s = session({ view: {}, acquired: refusing });
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
  const s = session({ view: { barrier: () => inside?.() }, acquired: refusing });
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
  const s = session({ view: { forget: () => forget }, acquired: refusing });
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
  const s = session({ view: {}, acquired: refusing, budget });
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
  // An unrelated name record settles (made, answered, retired): replayed, its names as they were, it is still lost.
  budget.limit = 1 << 30;
  sync.close(sync.open(`/${OTHER}/unrelated`, { write: true, create: true }).id);
  budget.limit = budget.used;
  await s.fs.flush();
  s.fs.inbound();
  await s.fs.readdir(`/${OTHER}`);
  assert.equal(await errnoOf(() => sync.fstat(fd)), 'EAGAIN', 'still lost once an unrelated record settled');
  budget.limit = 1 << 30;
  s.fs.inbound();
  await s.fs.stat(longer);
  assert.equal(budget.used, kept(), 'with room: what is taken is what is kept');
  assert.equal(Number(sync.fstat(fd).size), 1, 'with room, the move is kept');
  sync.close(fd);
}

// ── The process's own bytes, answered, then a peer's write, then a barrier that admits the row without its bytes ──
// What the descriptor reads is the peer's version or not here (EAGAIN): never the process's own bytes as the peer's.
{
  let contentless = false;
  const s = session({ view: { contentless: () => contentless }, acquired: refusing });
  const sync = s.fs.synchronous;
  await resident(s, 'f', 'base');
  const fd = sync.open(`/${OTHER}/f`, { read: true, write: true }).id;
  sync.write(fd, 0, enc.encode('OWN!'));
  await s.fs.flush();
  s.kernel.writeFile(`${OTHER}/f`, 'peer-longer');
  contentless = true;
  s.fs.inbound();
  await s.fs.stat(`/${OTHER}`);
  contentless = false;
  const read = await errnoOf(() => sync.read(fd, 0, 64)) ?? dec.decode(sync.read(fd, 0, 64));
  assert.ok(read === 'EAGAIN' || read === 'peer-longer', `what the descriptor reads: ${read}`);
  assert.equal(Number(sync.fstat(fd).size), 11, 'its fstat: the peer\'s');
  sync.close(fd);
}

// ── A file made here, its creating open's answer late; a peer renames it; the view admits it there; it is opened there ──
// The answer names the file the process opened at the new name: one owner, whose content both descriptors share.
{
  let holding = null;
  const s = session({ view: {}, acquired: refusing, answering: () => holding?.promise });
  const sync = s.fs.synchronous;
  await resident(s, 'warm', 'w');
  holding = Promise.withResolvers();
  const made = sync.open(`/${OTHER}/p`, { read: true, write: true, create: true, mode: 0o644 }).id;
  sync.write(made, 0, enc.encode('mine'));
  const sent = s.fs.flush().catch(() => {});
  for (let tries = 0; tries < 400 && !s.kernel.exists(`${OTHER}/p`); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(s.kernel.exists(`${OTHER}/p`), 'the session made it');
  s.kernel.rename(`${OTHER}/p`, `${OTHER}/q`);
  s.fs.inbound();
  await s.fs.stat(`/${OTHER}/q`);
  const there = sync.open(`/${OTHER}/q`, { read: true, write: true }).id;
  holding.resolve();
  holding = null;
  await sent;
  sync.write(made, 0, enc.encode('XY'));
  assert.equal(dec.decode(sync.read(there, 0, 64)), 'XYne', 'what the descriptor opened at the new name reads');
  assert.equal(Number(sync.fstat(there).size), Number(sync.fstat(made).size), 'both descriptors\' fstat');
  assert.equal(Number(sync.fstat(there).ino), Number(sync.fstat(made).ino), 'one file');
  sync.close(made);
  sync.close(there);
  await s.fs.flush();
  assert.equal(s.kernel.readFileString(`${OTHER}/q`), 'XYne', 'the session\'s');
}

// ── A file made here opened twice before its creating answer; a peer moves it; the view admits it; it is opened there ──
// Both answers settle on the one owner: once every descriptor is closed and a barrier covers them, nothing is kept.
{
  let holding = null;
  const budget = { used: 0, limit: 1 << 30 };
  const s = session({ view: {}, acquired: refusing, budget, answering: () => holding?.promise });
  const sync = s.fs.synchronous;
  const kept = () => {
    const stats = s.fs.stats();
    return stats.provisionalBytes + stats.pinnedBytes;
  };
  await resident(s, 'warm', 'w');
  holding = Promise.withResolvers();
  const made = sync.open(`/${OTHER}/p`, { read: true, write: true, create: true, mode: 0o644 }).id;
  const again = sync.open(`/${OTHER}/p`, { read: true, write: true }).id;
  sync.write(again, 0, enc.encode('mine'));
  const sent = s.fs.flush().catch(() => {});
  for (let tries = 0; tries < 400 && !s.kernel.exists(`${OTHER}/p`); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  s.kernel.rename(`${OTHER}/p`, `${OTHER}/q`);
  s.fs.inbound();
  await s.fs.stat(`/${OTHER}/q`);
  const there = sync.open(`/${OTHER}/q`, { read: true, write: true }).id;
  holding.resolve();
  holding = null;
  await sent;
  await s.fs.flush();
  sync.write(made, 0, enc.encode('XY'));
  assert.equal(dec.decode(sync.read(again, 0, 64)), 'XYne', 'the second descriptor of the made file');
  assert.equal(dec.decode(sync.read(there, 0, 64)), 'XYne', 'the descriptor opened at the new name');
  for (const fd of [made, again, there]) sync.close(fd);
  await s.fs.flush();
  s.fs.inbound();
  await s.fs.readdir(`/${OTHER}`);
  assert.equal(budget.used, kept(), 'what is taken is what is kept');
  assert.equal(s.fs.stats().provisionalBytes, 0, 'nothing kept once all is closed and the view has it');
  assert.equal(s.kernel.readFileString(`${OTHER}/q`), 'XYne');
}

console.log('ok - wasi-fd-identity');
