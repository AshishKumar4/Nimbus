#!/usr/bin/env bun
// A MemoryVFS states its change model by a journal feed: what changed since
// a cursor of its epoch, each path's newest change (a removed directory a
// structural one, covering what was under it), and its whole tree listed in
// path order. Its removals are kept no more than its tree has entries; a
// cursor below the newest pruned one is a poison, as SQLite's below its
// tombstone floor.
//
// Red before: a MemoryVFS had no feed, so a mount of one was a snapshot.

import assert from 'node:assert/strict';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';

const paths = (delta) => delta.paths.map((entry) => `${entry.path}${entry.structural ? '!' : ''}`).sort();

{
  const mem = new MemoryVFS();
  const feed = mem.changes;
  assert.ok(feed, 'a MemoryVFS states no change model');
  mem.mkdir('/d');
  mem.writeFile('/d/a', new TextEncoder().encode('A'));
  const start = feed.revision();
  const listed = feed.list(null, 100);
  assert.deepEqual(listed.entries.map((entry) => entry.path), ['/d', '/d/a']);
  assert.equal(listed.epoch, feed.epoch);
  assert.equal(listed.rev, start);

  assert.deepEqual(feed.since(feed.epoch, start), { epoch: feed.epoch, rev: start, paths: [], poison: false });
  mem.writeFile('/d/b', new TextEncoder().encode('B'));
  mem.chmod('/d/a', 0o600);
  const delta = feed.since(feed.epoch, start, { namespace: true });
  assert.equal(delta.poison, false);
  assert.deepEqual(paths(delta), ['/d', '/d/a', '/d/b']);
  const b = delta.paths.find((entry) => entry.path === '/d/b');
  assert.equal(b.stat.size, 1);
  assert.ok(b.rev > start && b.rev <= delta.rev);

  // A directory removed covers what was under it: one structural change, and its parent's.
  const before = feed.revision();
  mem.removeRecursive('/d');
  assert.deepEqual(paths(feed.since(feed.epoch, start)), ['/', '/d!']);
  const gone = feed.since(feed.epoch, before, { namespace: true }).paths.find((entry) => entry.path === '/d');
  assert.equal(gone.stat, null);

  // Renamed: the old name gone (structural for a directory), the new one there.
  mem.mkdir('/e');
  const r0 = feed.revision();
  mem.rename('/e', '/f');
  assert.deepEqual(paths(feed.since(feed.epoch, r0)), ['/', '/e!', '/f']);

  assert.equal(feed.since('another', 0).poison, true, 'a cursor of another epoch');
  assert.equal(feed.since(feed.epoch, feed.revision() + 1).poison, true, 'a cursor from its future');
  assert.notEqual(new MemoryVFS().changes.epoch, feed.epoch, 'two trees, two epochs');
}

// Removals kept no more than the tree has entries: past that, the oldest go and a cursor below them is a poison.
{
  const mem = new MemoryVFS();
  const feed = mem.changes;
  const start = feed.revision();
  for (let i = 0; i < 8; i++) {
    mem.writeFile(`/t${i}`, new Uint8Array(1));
    mem.unlink(`/t${i}`);
  }
  assert.equal(feed.since(feed.epoch, start).poison, true, 'a cursor below a pruned removal still answers');
  const now = feed.revision();
  mem.writeFile('/kept', new Uint8Array(1));
  assert.deepEqual(paths(feed.since(feed.epoch, now)), ['/', '/kept']);
}

console.log('vfs-memory-changes: ok');
