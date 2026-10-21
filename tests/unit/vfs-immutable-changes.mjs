#!/usr/bin/env bun
// A mount states its change model by its feed (VFS.changes). /dev and
// /proc state theirs as immutable: a reader that listed them is current
// until their tree changes (a /proc file registered), which is another
// epoch. /proc's stats are procfs's: a volatile file (made at each read) is
// size 0, and every stat's time is the tree's, not the read's.
//
// Red before: neither had a feed (a reader could only snapshot them), and a
// /proc stat generated its content to size it and said mtime = now.

import assert from 'node:assert/strict';
import { DevVFS } from '../../packages/core/src/vfs/dev-vfs.ts';
import { standardProc } from '../../packages/core/src/vfs/proc-vfs.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── /dev: its whole tree, in path order, current at every cursor of its epoch ──
{
  const dev = new DevVFS();
  assert.ok(dev.changes, '/dev states no change model');
  const page = dev.changes.list(null, 100);
  const paths = page.entries.map((entry) => entry.path);
  assert.deepEqual(paths, [...paths].sort(), 'not in path order');
  assert.ok(paths.includes('/null') && paths.includes('/urandom'), paths.join(' '));
  assert.equal(page.next, null);
  assert.equal(page.entries.find((entry) => entry.path === '/null').kind, 'file');
  const twoAtATime = [];
  for (let after = null; ;) {
    const part = dev.changes.list(after, 2);
    twoAtATime.push(...part.entries.map((entry) => entry.path));
    if (part.next === null) break;
    after = part.next;
  }
  assert.deepEqual(twoAtATime, paths, 'paged, it lists the same tree');
  assert.deepEqual(dev.changes.since(dev.changes.epoch, 0), { epoch: dev.changes.epoch, rev: 0, paths: [], poison: false });
  assert.equal(dev.changes.since('another', 0).poison, true, 'a cursor of another tree is current');
  assert.equal(new DevVFS().changes.epoch, dev.changes.epoch, 'the same devices are the same epoch');
}

// ── /proc: constant files their size, volatile ones size 0, every time the tree's ──
{
  const proc = standardProc();
  assert.ok(proc.changes, '/proc states no change model');
  const first = proc.stat('/uptime');
  assert.equal(first.size, 0, 'a volatile file is size 0');
  assert.equal(proc.stat('/meminfo').size, 0);
  assert.equal(proc.stat('/net/info').size, 0);
  const version = proc.stat('/version');
  assert.equal(version.size, proc.readFile('/version').byteLength, 'a constant file is its content\'s size');
  await sleep(5);
  assert.equal(proc.stat('/uptime').mtimeMs, first.mtimeMs, 'a stat\'s time is the tree\'s, not the read\'s');
  assert.equal(proc.stat('/version').mtimeMs, first.mtimeMs);
  assert.ok(proc.readFile('/uptime').byteLength > 0, 'a volatile file still reads its content');

  const epoch = proc.changes.epoch;
  const listed = proc.changes.list(null, 100).entries;
  assert.equal(listed.find((entry) => entry.path === '/uptime').size, 0);
  assert.ok(listed.some((entry) => entry.path === '/net' && entry.kind === 'directory'));
  assert.equal(proc.changes.since(epoch, 0).poison, false);

  // A file registered is another tree: every view's reader lists again.
  const view = proc.as({ uid: 1000, gid: 1000, groups: [1000] });
  assert.equal(view.changes.epoch, epoch, 'a principal\'s view is the same tree');
  proc.register('nimbus/extra', () => 'x\n');
  assert.notEqual(proc.changes.epoch, epoch);
  assert.equal(view.changes.since(epoch, 0).poison, true, 'a view kept the tree from before the registration');
  assert.ok(view.changes.list(null, 100).entries.some((entry) => entry.path === '/nimbus/extra'));
}

console.log('vfs-immutable-changes: ok');
