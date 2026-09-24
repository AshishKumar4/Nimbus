#!/usr/bin/env bun
// Refinement bridge for Nimbus.Coherence.VisibleDelta. Each case in
// lean/fixtures/vfs-visible-delta.json runs setup and window steps as the
// kernel, then asks for the reader's ACQUIRE delta over the window. A reader
// holding every file it could list at the cursor evicts each held row an
// entry names, and each held row at or under an entry marked `subtree` or
// `structural`. The model says which rows must go (mustEvict) and which names
// the reader may never be told (forbidden); evicting more is allowed. The
// fixture is the model's own output (lean/RefinementFixtures.lean), so the
// proofs cannot outlive this code.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../lean/fixtures/vfs-visible-delta.json', import.meta.url), 'utf8'));
assert.equal(fixture.fixture, 'vfs-visible-delta');
assert.ok(fixture.cases.length > 0);
const reader = Object.freeze({ ...fixture.reader, groups: Object.freeze([...fixture.reader.groups]) });

function apply(vfs, step, where) {
  switch (step.op) {
    case 'mkdir':
      vfs.mkdir(step.path, { mode: step.mode });
      assert.equal(vfs.stat(step.path).mode & 0o7777, step.mode, `${where}: mkdir ${step.path} mode`);
      return;
    case 'write':
      vfs.writeFile(step.path, where);
      return;
    case 'chmod':
      vfs.chmod(step.path, step.mode);
      return;
    case 'rmrf':
      vfs.removeRecursive(step.path);
      return;
    case 'rename':
      vfs.rename(step.path, step.to);
      return;
    default:
      throw new Error(`${where}: unknown op ${step.op}`);
  }
}

function listedFiles(view) {
  const files = [];
  let after = null;
  do {
    const page = view.list(after, 256);
    for (const entry of page.entries) if (entry.kind === 'file') files.push(entry.path);
    after = page.next;
  } while (after !== null);
  return files.sort();
}

/**
 * The reader may see `path` now: every directory above it exists and lets it
 * in. Every fixture directory is the kernel's, so the reader, which is neither
 * its owner nor in its group, enters by the other-execute bit.
 */
function visibleNow(kernel, path) {
  const parts = path.split('/');
  for (let depth = 1; depth < parts.length; depth++) {
    const dir = parts.slice(0, depth).join('/');
    if (!kernel.exists(dir)) return false;
    const stat = kernel.lstat(dir);
    if (stat.type !== 'directory' || (stat.mode & 0o001) === 0) return false;
  }
  return true;
}

const covers = (entry, path) =>
  path === entry.path || ((entry.subtree === true || entry.structural === true) && path.startsWith(`${entry.path}/`));

let scoped = 0;
let evictedTotal = 0;
for (const [index, testCase] of fixture.cases.entries()) {
  const where = `case ${index}`;
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  const view = raw.as(reader);
  for (const [at, step] of testCase.setup.entries()) apply(kernel, step, `${where} setup ${at}`);
  const held = listedFiles(view);
  assert.deepEqual(held, [...testCase.held].sort(), `${where}: the reader holds what it could list at the cursor`);

  const cursor = raw.revision();
  for (const [at, step] of testCase.window.entries()) apply(kernel, step, `${where} window ${at}`);
  const delta = view.invalidatedSince(raw.epoch, cursor);
  assert.equal(delta.poison, false, `${where}: the delta was poisoned`);

  for (const entry of delta.paths) {
    assert.ok(entry.rev > cursor && entry.rev <= raw.revision(), `${where}: ${entry.path} reported at ${entry.rev}`);
    assert.ok(visibleNow(kernel, entry.path), `${where}: the reader was told ${entry.path}, which it may not see`);
  }
  const reported = new Set(delta.paths.map((entry) => entry.path));
  for (const name of testCase.forbidden) assert.ok(!reported.has(name), `${where}: the reader was told ${name}`);

  // Every held row was stamped at the cursor and every entry is newer, so a
  // covered row always goes.
  const evicted = new Set(held.filter((path) => delta.paths.some((entry) => covers(entry, path))));
  for (const name of testCase.mustEvict) assert.ok(evicted.has(name), `${where}: a row for ${name} was kept`);
  if (delta.paths.some((entry) => entry.subtree === true || entry.structural === true)) scoped++;
  evictedTotal += evicted.size;
}
assert.ok(scoped > 0, 'no case produced a subtree or structural entry');
console.log(
  `vfs-visible-delta-fixture: ${fixture.cases.length} cases agree with the model `
  + `(${scoped} with subtree or structural entries, ${evictedTotal} rows evicted)`,
);
