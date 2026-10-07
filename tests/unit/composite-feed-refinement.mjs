#!/usr/bin/env bun
// Refinement bridge for Nimbus.Vfs.CompositeFeed (FormalModelsLane 6da08f76)
// (lean/fixtures/composite-feed.json). A reader stages the composite's
// namespace from its feed (list after taking a position), a window of
// operations runs (writes straight into a backend, shadowed ones included;
// mounts appearing and going), and one `since` must bring the staged
// namespace to exactly what the composite shows: poison exactly when the
// model says so, and otherwise a delta that, applied, is exact.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../lean/fixtures/composite-feed.json', import.meta.url), 'utf8'));
const enc = new TextEncoder();
const dec = new TextDecoder();

function backend(changes, entries) {
  let files;
  if (changes) {
    const harness = createSqliteVfsTestHarness();
    files = sqliteFiles(new SqliteVFS(harness.sql, harness.ctx), CRED_KERNEL);
  } else {
    files = new MemoryVFS();
  }
  for (const [path, value] of Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1))) write(files, path, value);
  return files;
}

function parentOf(path) {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '/' : path.slice(0, at);
}

function write(files, path, value) {
  const parent = parentOf(path);
  if (parent !== '/') files.mkdir(parent, { recursive: true });
  if (value === 'dir') {
    const stat = files.stat(path, { follow: false });
    if (stat !== null && stat.type !== 'directory') files.unlink(path);
    if (stat === null || stat.type !== 'directory') files.mkdir(path, { recursive: true });
    return;
  }
  const stat = files.stat(path, { follow: false });
  if (stat !== null && stat.type === 'directory') files.removeRecursive(path);
  files.writeFile(path, enc.encode(value));
}

function remove(files, path) {
  if (files.stat(path, { follow: false }) !== null) files.removeRecursive(path);
}

async function valueOf(vfs, entry) {
  if (entry.kind === 'directory') return 'dir';
  return dec.decode(await vfs.readFile(entry.path));
}

async function listAll(vfs) {
  const out = {};
  let after = null;
  for (;;) {
    const page = vfs.feed.list(after, 3);
    for (const entry of page.entries) out[entry.path] = await valueOf(vfs, entry);
    if (page.next === null) return out;
    after = page.next;
  }
}

function dropTree(staged, path) {
  for (const key of Object.keys(staged)) if (key === path || key.startsWith(`${path}/`)) delete staged[key];
}

/** What a namespace reader does with one delta entry. */
async function apply(vfs, staged, entry) {
  const stat = entry.stat;
  if (stat === null || stat === undefined || entry.subtree || entry.structural || stat.type !== 'directory') {
    dropTree(staged, entry.path);
  }
  if (stat === null || stat === undefined) return;
  staged[entry.path] = stat.type === 'directory' ? 'dir' : dec.decode(await vfs.readFile(entry.path));
  if (stat.type === 'directory' && (entry.subtree || entry.structural)) {
    // Relist what is under it, as a reader does for a structural change.
    const walk = async (dir) => {
      for (const child of await vfs.readdir(dir)) {
        const at = dir === '/' ? `/${child.name}` : `${dir}/${child.name}`;
        const childStat = await vfs.stat(at, { follow: false });
        staged[at] = childStat.type === 'directory' ? 'dir' : dec.decode(await vfs.readFile(at));
        if (childStat.type === 'directory') await walk(at);
      }
    };
    await walk(entry.path);
  }
}

const sorted = (tree) => Object.fromEntries(Object.entries(tree).sort(([a], [b]) => (a < b ? -1 : 1)));

let failures = 0;
let poisons = 0;
for (const [index, testCase] of fixture.cases.entries()) {
  try {
    const root = backend(true, testCase.root);
    const byPoint = new Map([['root', root]]);
    const vfs = new CompositeVFS(root);
    for (const mount of testCase.mounts) {
      const files = backend(mount.changes, mount.entries);
      byPoint.set(mount.point, files);
      vfs.mount(mount.point, files);
    }
    const position = vfs.feed.position();
    const staged = await listAll(vfs);
    assert.deepEqual(sorted(staged), sorted(testCase.atCursor), 'the staged namespace after boot');
    for (const op of testCase.window) {
      if (op.op === 'mount') {
        const files = backend(op.changes, op.entries);
        byPoint.set(op.point, files);
        vfs.mount(op.point, files);
      } else if (op.op === 'unmount') {
        vfs.unmount(op.point);
      } else {
        const files = byPoint.get(op.backend);
        if (op.op === 'write') write(files, op.path, op.bytes ?? 'dir');
        else remove(files, op.path);
      }
    }
    const answer = vfs.feed.since(position, { namespace: true });
    assert.equal(answer.poison, testCase.poison, 'poison exactly when the model says');
    if (answer.poison) {
      poisons++;
      assert.deepEqual(sorted(await listAll(vfs)), sorted(testCase.atAnswer), 'the relisted namespace');
    } else {
      for (const entry of answer.paths) await apply(vfs, staged, entry);
      assert.deepEqual(sorted(staged), sorted(testCase.atAnswer), 'the namespace after one answer');
    }
  } catch (error) {
    failures++;
    if (failures <= 5) console.log(`FAIL case ${index}: ${error.message.split('\n')[0]}\n  ${JSON.stringify(error.actual)}\n  vs ${JSON.stringify(error.expected)}`);
  }
}
if (failures > 0) {
  console.log(`composite-feed-refinement: ${failures} of ${fixture.cases.length} cases disagree with the model`);
  process.exit(1);
}
console.log(`composite-feed-refinement: ${fixture.cases.length} cases of lean/fixtures/composite-feed.json agree with the model (${poisons} poisons)`);
