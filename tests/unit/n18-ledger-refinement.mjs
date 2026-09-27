#!/usr/bin/env bun
// Refinement bridge for Nimbus.Vfs.Ledger.step (FormalModelsLane, N18-001,
// lean/fixtures/n18-ledger.json). Each case runs its operations through a
// StorageLedger over a real SQLite database. The environment plays the
// session DO: its own bytes grow by an admitted write and shrink by a delete.
// `restart` builds a new ledger over the same database. After every operation
// the answer and the whole ledger must be the model's.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StorageLedger } from '../../packages/core/src/runtime/storage-ledger.ts';
import { isVfsError } from '../../packages/core/src/vfs/vfs-error.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../lean/fixtures/n18-ledger.json', import.meta.url), 'utf8'));

let steps = 0;
const failures = [];
for (const [index, testCase] of fixture.cases.entries()) {
  const { sql } = createSqliteVfsTestHarness();
  let own = testCase.session;
  const open = () => new StorageLedger(sql, { limit: testCase.limit, kernelReserve: 0, sessionBytes: () => own });
  let ledger = open();
  for (const [at, step] of testCase.steps.entries()) {
    steps++;
    let answer = 'ok';
    try {
      switch (step.op) {
        case 'write': ledger.admit(step.bytes); own += step.bytes; break;
        case 'fill': ledger.fill(step.facet, step.bytes); break;
        case 'delSess': own = Math.max(0, own - step.bytes); break;
        case 'delFacet': ledger.deleteFacet(step.facet); break;
        case 'settle': ledger.settle(step.facet, step.bytes); break;
        case 'report': ledger.report(step.facet, step.bytes); break;
        case 'abort': break;
        case 'reserve': ledger.reserve(step.id, step.bytes); break;
        // The operation's write lands: the session grows by it.
        case 'draw': ledger.draw(step.id, step.bytes); own += step.bytes; break;
        // It rolled back: the session never grew by it.
        case 'refund': { const back = Math.min(step.bytes, own); ledger.refund(step.id, back); own -= back; break; }
        case 'release': ledger.release(step.id); break;
        case 'releaseAll': ledger.releaseAll(); break;
        // A new engine: no operation outlives it, so nothing stays reserved.
        case 'restart': ledger = open(); ledger.releaseAll(); break;
        default: throw new Error(`unknown op ${step.op}`);
      }
    } catch (error) {
      if (!isVfsError(error, 'ENOSPC')) throw error;
      answer = 'ENOSPC';
    }
    const view = ledger.view();
    const got = {
      expect: answer,
      ledger: {
        used: view.used,
        overshoot: view.overshoot,
        session: view.session,
        facets: view.facets,
        reserved: view.reserved,
        reservations: view.reservations,
      },
    };
    const want = { expect: step.expect, ledger: { ...step.ledger, facets: Object.fromEntries(Object.entries(step.ledger.facets).sort()), reservations: Object.fromEntries(Object.entries(step.ledger.reservations).sort()) } };
    try {
      assert.deepEqual(got, want);
    } catch {
      failures.push(`case ${index} step ${at} ${JSON.stringify({ op: step.op, id: step.id, facet: step.facet, bytes: step.bytes })}: got ${JSON.stringify(got)}, model ${JSON.stringify(want)}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures.slice(0, Number(process.env.SHOW ?? 10))) console.log(`FAIL ${failure}`);
  console.log(`n18-ledger-refinement: ${failures.length} of ${steps} steps disagree with the model`);
  process.exit(1);
}
console.log(`n18-ledger-refinement: ${steps} steps in ${fixture.cases.length} cases agree with the model`);
