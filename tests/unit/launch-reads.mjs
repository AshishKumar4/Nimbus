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
import { readsAffectedBy, readsUnderMounts, recordLaunchReads } from '../../packages/worker/src/facets/launch-reads.ts';
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
assert.deepEqual([...reads.listed], ['home/user/app/lib']);
assert.equal(reads.whole, false, 'reads and a barrier are not a dependence on everything');
console.log('  reads, probes and listings are noted');

// ── What a change does to them ────────────────────────────────────────────
const change = (path, extra = {}) => ({ path, rev: 9, ...extra });
assert.equal(readsAffectedBy(reads, []), false, 'no change');
assert.equal(readsAffectedBy(reads, [change('home/user/notes/a.txt'), change('home/user/.bash_history')]), false,
  'a write to files the build never asked about');
assert.equal(readsAffectedBy(reads, [change('home/user/app/index.js')]), true, 'a file it read');
assert.equal(readsAffectedBy(reads, [change('/home/user/app/lib.js')]), true, 'a file it probed and did not find, made since');
assert.equal(readsAffectedBy(reads, [change('home/user/app/lib/extra.js')]), true, 'a new name in a directory it listed');
assert.equal(readsAffectedBy(reads, [change('home/user/app', { structural: 'renamed' })]), true, 'a directory above what it read');
assert.equal(readsAffectedBy(reads, [change('home/user/app/other.js')]), false, 'a new name in a directory it did not list');
console.log('  a change counts only where the build asked');

// ── A build that wrote, or enumerated, depends on everything ──────────────
{
  const whole = recordLaunchReads(launchFs(files).fs);
  await whole.view.list(null, 10);
  assert.equal(whole.reads().whole, true);
  assert.equal(readsAffectedBy(whole.reads(), [change('home/user/notes/a.txt')]), true, 'any change');
  assert.equal(readsAffectedBy(whole.reads(), []), false, 'but not none');
}
console.log('  an enumeration depends on everything');

// ── Mounts ────────────────────────────────────────────────────────────────
assert.equal(readsUnderMounts(reads, ['/', '/computer']), false, 'the session\'s own store is not a mount here');
assert.equal(readsUnderMounts({ ...reads, paths: new Set(['computer/x.js']) }, ['/', '/computer']), true, 'a read under a mount');
console.log('  reads under a mount are found');

console.log('launch-reads: ok');
