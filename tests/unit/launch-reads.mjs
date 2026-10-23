#!/usr/bin/env bun
// launch-reads — a launch's build is served again after a change only when
// the change names nothing the build asked the filesystem about.
//
// The prefetch cache used to keep a build only while the session's global
// revision stood still, so any write (a shell history line, an agent's file
// tool) rebuilt the next `node -e`'s module map: 1.6-2.5 s each time in an
// express project (throwaway, 2026-10-23). These are the rules that let it
// keep the build instead, without ever serving a stale one.

import assert from 'node:assert/strict';
import { readsUnderMounts, recordLaunchReads, staleReason } from '../../packages/worker/src/facets/launch-reads.ts';
import { launchFs } from './lib/launch-fs.mjs';

const files = {
  'home/user/app/package.json': '{"name":"app"}',
  'home/user/app/index.js': "module.exports = require('./lib');",
  'home/user/app/lib/index.js': 'module.exports = 1;',
  'home/user/notes/a.txt': 'a',
};

// ── What is noted ─────────────────────────────────────────────────────────
const recorded = recordLaunchReads(launchFs(files).fs);
const fs = recorded.view;
await fs.readFile('/home/user/app/index.js');
await fs.stat('/home/user/app/lib.js');
await fs.stat('/home/user/app/lib/index.js');
await fs.readdir('/home/user/app/lib');
await fs.acquire(null, 0);
const reads = recorded.reads();
assert.deepEqual([...reads.paths].sort(), ['home/user/app/index.js', 'home/user/app/lib', 'home/user/app/lib.js', 'home/user/app/lib/index.js'],
  'each path read, stat\'ed or probed (found or not) and each directory listed, by its name without slashes');
assert.deepEqual([...reads.listed.keys()], ['home/user/app/lib']);
assert.deepEqual([...reads.listed.get('home/user/app/lib')], [['index.js', 'file']], 'with the names and kinds the listing answered');
assert.deepEqual([...reads.absent], ['home/user/app/lib.js'], 'what was not there');
assert.equal(reads.whole, false, 'reads and a barrier are not a dependence on everything');
console.log('  reads, probes and listings are noted');

// ── What a change does to them ────────────────────────────────────────────
const change = (path, extra = {}) => ({ path, rev: 9, ...extra });
// What is at a name now: the tree as the test says it is after its changes.
const kinds = (now = {}) => async (name) => now[name] ?? (files[name] !== undefined ? 'file' : null);
const affected = async (r, changes, now) => (await staleReason(r, changes, kinds(now))) !== null;
assert.equal(await affected(reads, []), false, 'no change');
assert.equal(await affected(reads, [change('home/user/notes/a.txt'), change('home/user/.bash_history')]), false,
  'a write to files the build never asked about');
assert.equal(await affected(reads, [change('home/user/app/index.js')]), true, 'a file it read');
assert.equal(await affected(reads, [change('/home/user/app/lib.js')]), true, 'a file it probed and did not find, made since');
assert.equal(await affected(reads, [change('home/user/app/lib/extra.js')], { 'home/user/app/lib/extra.js': 'file' }), true, 'a new name in a directory it listed');
assert.equal(await affected(reads, [change('home/user/app', { structural: true })]), true, 'a directory above what it read, renamed or removed');
assert.equal(await affected(reads, [change('home/user', { subtree: true })]), true, 'a change it may not see, above what it read');
// A symlink on the way to what it read, retargeted: its own record, and its directory's.
assert.equal(await affected(reads, [change('home/user/app'), change('home/user')]), true, 'a name above what it read, changed by itself');
// A write reports its file and the directory the file is in (SqliteVFS's publication).
assert.equal(await affected(reads, [change('home/user/app/other.js'), change('home/user/app')]), false,
  'a new name in a directory it did not list, with that directory\'s record of it');
assert.equal(await affected(reads, [change('home/user/revision-marker'), change('home/user')]), false,
  'a write in a directory above what it read is not a change to what it read');
assert.equal(await affected(reads, [change('home/user/app/lib/index.js'), change('home/user/app/lib')]), true, 'a file it read, with its directory');
assert.equal(await affected(reads, [change('home/user/app/lib')]), true, 'a directory it listed, changed by itself');
// A listing answers names and kinds: a file in it written again leaves it as it was.
{
  const listing = recordLaunchReads(launchFs(files).fs);
  await listing.view.readdir('/home/user/notes');
  assert.equal(await affected(listing.reads(), [change('home/user/notes/a.txt'), change('home/user/notes')]), false,
    'a file it listed and did not read, written again: the listing answers the same');
  assert.equal(await affected(listing.reads(), [change('home/user/notes/b.txt'), change('home/user/notes')], { 'home/user/notes/b.txt': 'file' }), true,
    'a name made in a directory it listed');
  assert.equal(await affected(listing.reads(), [change('home/user/notes/a.txt'), change('home/user/notes')], { 'home/user/notes/a.txt': 'directory' }), true,
    'a name in it that changed kind');
}
// Resolution looked for a directory that was not there; it is made, with a file in it.
{
  const probing = recordLaunchReads(launchFs(files).fs);
  await probing.view.stat('/home/user/app/node_modules/x');
  assert.equal(await affected(probing.reads(), [change('home/user/app/node_modules/x/index.js'), change('home/user/app/node_modules/x'), change('home/user/app/node_modules')]), true,
    'a directory it did not find, made since, counts even beside the file made in it');
}
console.log('  a change counts only where the build asked');

// ── A build that wrote, or enumerated, depends on everything ──────────────
{
  const whole = recordLaunchReads(launchFs(files).fs);
  await whole.view.list(null, 10);
  assert.equal(whole.reads().whole, true);
  assert.equal(await affected(whole.reads(), [change('home/user/notes/a.txt')]), true, 'any change');
  assert.equal(await affected(whole.reads(), []), false, 'but not none');
}
console.log('  an enumeration depends on everything');

// ── Mounts ────────────────────────────────────────────────────────────────
assert.equal(readsUnderMounts(reads, ['/', '/computer']), false, 'the session\'s own store is not a mount here');
assert.equal(readsUnderMounts({ ...reads, paths: new Set(['computer/x.js']) }, ['/', '/computer']), true, 'a read under a mount');
console.log('  reads under a mount are found');

console.log('launch-reads: ok');
