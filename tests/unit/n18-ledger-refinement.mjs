#!/usr/bin/env bun
// Refinement bridge for Nimbus.Vfs.Ledger.step (FormalModelsLane, N18-001,
// lean/fixtures/n18-ledger.json). Each case runs its operations through a
// StorageLedger over a real SQLite database. The environment plays the
// session DO: its own bytes grow by an admitted write and shrink by a delete,
// and its databaseSize includes the images the ledger records (they live in
// it); an evicted image's rows go when the ledger asks. `restart` builds a new
// ledger over the same database. After every operation the answer, the
// images evicted (oldest first) and the whole ledger must be the model's.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StorageLedger, registerImageEvictor } from '../../packages/core/src/runtime/storage-ledger.ts';
import { isVfsError } from '../../packages/core/src/vfs/vfs-error.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../lean/fixtures/n18-ledger.json', import.meta.url), 'utf8'));

let steps = 0;
const failures = [];
for (const [index, testCase] of fixture.cases.entries()) {
  const { sql } = createSqliteVfsTestHarness();
  let own = testCase.session;
  let evicted = [];
  const imageBytes = () => Number([...sql.exec('SELECT COALESCE(SUM(bytes), 0) AS n FROM nimbus_image_storage')][0].n);
  registerImageEvictor(sql, (principal) => evicted.push(Number(principal)));
  const open = () => new StorageLedger(sql, { limit: testCase.limit, sessionBytes: () => own + imageBytes() });
  let ledger = open();
  for (const [at, step] of testCase.steps.entries()) {
    steps++;
    evicted = [];
    const before = ledger.view().images.map(([principal]) => Number(principal));
    let answer = 'ok';
    try {
      switch (step.op) {
        case 'write': ledger.admit(step.bytes); own += step.bytes; break;
        case 'fill': ledger.fill(step.facet, step.bytes); break;
        case 'image': ledger.writeImage(String(step.principal), step.bytes); break;
        case 'touch': ledger.touchImage(String(step.principal)); break;
        case 'delSess': own = Math.max(0, own - step.bytes); break;
        case 'delFacet': ledger.deleteFacet(step.facet); break;
        case 'settle': ledger.settle(step.facet, step.bytes); break;
        case 'report': ledger.report(step.facet, step.bytes); break;
        case 'dropImages': ledger.dropImages(step.keep.map(String)); break;
        case 'abort': break;
        case 'restart': ledger = open(); break;
        default: throw new Error(`unknown op ${step.op}`);
      }
    } catch (error) {
      if (!isVfsError(error, 'ENOSPC')) throw error;
      answer = 'ENOSPC';
    }
    const view = ledger.view();
    const got = {
      expect: answer,
      // The model's evictions are admission's; an epoch drop deletes the images it drops.
      evicted: step.op === 'dropImages' ? [] : evicted,
      ledger: {
        used: view.used,
        overshoot: view.overshoot,
        session: view.session,
        facets: view.facets,
        images: view.images.map(([principal, bytes]) => [Number(principal), bytes]),
      },
    };
    if (step.op === 'dropImages') {
      const dropped = before.filter((principal) => !step.keep.includes(principal));
      if (JSON.stringify(evicted) !== JSON.stringify(dropped)) failures.push(`case ${index} step ${at}: dropImages deleted ${JSON.stringify(evicted)}, not ${JSON.stringify(dropped)}`);
    }
    const want = { expect: step.expect, evicted: step.evicted, ledger: { ...step.ledger, facets: Object.fromEntries(Object.entries(step.ledger.facets).sort()) } };
    try {
      assert.deepEqual(got, want);
    } catch {
      failures.push(`case ${index} step ${at} ${JSON.stringify({ op: step.op, facet: step.facet, principal: step.principal, bytes: step.bytes, keep: step.keep })}: got ${JSON.stringify(got)}, model ${JSON.stringify(want)}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures.slice(0, 10)) console.log(`FAIL ${failure}`);
  console.log(`n18-ledger-refinement: ${failures.length} of ${steps} steps disagree with the model`);
  process.exit(1);
}
console.log(`n18-ledger-refinement: ${steps} steps in ${fixture.cases.length} cases agree with the model`);
