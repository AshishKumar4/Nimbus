#!/usr/bin/env bun
// Refinement bridge for Nimbus.Vfs.RevisionFloor (lean/traceability.yaml
// VFS-REV-001). Each case in lean/fixtures/revision-floor.json is a sequence of
// mkdir/writeFile/unlink/rename steps and embedder transactions, with the
// revision the Lean model reports for every path after each step and what the
// invalidation log names each published path at; the deployed SqliteVFS, under
// the same per-path budget, must report the same numbers and publish the same
// log. The fixture is the model's own output (lean/RefinementFixtures.lean),
// so the proofs cannot outlive this code.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../lean/fixtures/revision-floor.json', import.meta.url), 'utf8'));
assert.equal(fixture.fixture, 'revision-floor');
assert.ok(fixture.cases.length > 0);

let dropped = 0;
let below = 0;
for (const [index, testCase] of fixture.cases.entries()) {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx, undefined, { pathRevisionBytes: fixture.budget });
  const vfs = raw.as(CRED_KERNEL);
  for (const [at, step] of testCase.steps.entries()) {
    const body = `case ${index} step ${at}`;
    const before = vfs.revision();
    if (step.op === 'mkdir') vfs.mkdir(step.path);
    else if (step.op === 'write') vfs.writeFile(step.path, body);
    else if (step.op === 'rm') vfs.unlink(step.path);
    else if (step.op === 'rename') vfs.rename(step.from, step.path);
    else {
      raw.withTransaction(() => {
        for (const [i, inner] of step.ops.entries()) {
          if (inner.op === 'write') vfs.writeFile(inner.path, `${body}.${i}`);
          else vfs.unlink(inner.path);
        }
      });
    }
    const where = `case ${index} step ${at} (${step.op} ${step.path ?? step.ops.map((inner) => inner.path).join(',')})`;
    assert.equal(vfs.revision(), step.clock, `${where}: clock`);
    assert.equal(raw.getStats().pathRevisions.floor, step.floor, `${where}: floor`);
    for (const [path, rev] of Object.entries(step.revisions)) {
      assert.equal(vfs.revision(path), rev, `${where}: revision(${path})`);
    }
    const delta = raw.invalidatedSince(raw.epoch, before);
    assert.deepEqual(Object.fromEntries(delta.paths.map((entry) => [entry.path, entry.rev])), step.log, `${where}: log`);
    for (const [path, rev] of Object.entries(step.log)) {
      assert.equal(vfs.revision(path), rev, `${where}: the log names ${path} at a revision it does not report`);
      if (rev < step.clock) below++;
    }
  }
  if (raw.getStats().pathRevisions.floor > 0) dropped++;
}
assert.ok(dropped > 0, 'no case dropped a revision, so the floor was never exercised');
assert.ok(below > 0, 'no path was published below its operation\'s revision, so no operation of several transactions ran');
console.log(`revision-floor-refinement: ${fixture.cases.length} cases agree with the model (${dropped} dropped revisions, ${below} paths published below their operation's revision)`);
