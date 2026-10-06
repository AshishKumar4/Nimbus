#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { describe, exploreStoppedAdmissions, checkBrokerRefusalMapping } from './lib/ledger-protocol-model.mjs';

// The pre-fix behaviour is a mutant at the production stop seam: the
// launch stays held, and resume does nothing. The model must find its
// circular wait before we accept the production result.
const retained = await exploreStoppedAdmissions({ suspend: () => async () => {} });
assert.equal(retained.found.length, 1, 'retaining stopped admissions reproduces the deadlock');
assert.match(retained.found[0].violation, /B never ran/);
console.log(`red - retained admissions: ${describe(retained.found[0].path)}: ${retained.found[0].violation}`);
for (const kills of [false, true]) {
  const result = await exploreStoppedAdmissions({ kills });
  assert.deepEqual(result.found, [], `every stopped/replay/B/kill interleaving completes: ${JSON.stringify(result.found)}`);
  assert.ok(result.finals > 0);
  console.log(`green - stopped admissions (kills ${kills}): ${result.states} states, ${result.finals} finals, no violation`);
}
const broker = await checkBrokerRefusalMapping();
console.log(`green - broker refusal: ${broker.traces} start/READY/status/output-news interleavings preserve the started child's exit and the initial spawn error`);
console.log('ok - stopped-launch-admission-model (retained-hold mutant deadlocks; production releases, readmits and cancels in every interleaving)');
