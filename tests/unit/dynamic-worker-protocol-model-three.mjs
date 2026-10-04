#!/usr/bin/env bun
// The Dynamic Worker ledger's deadlock protocol over every interleaving
// (lib/ledger-protocol-model.mjs), for families of three guest holders:
// side by side, a chain, and a fork, each with its holders' children
// rotated through a queued child, a queued child and a builtin, and a queued
// child and a shell line over a queued program; in a chain or a fork, each
// holder in turn the one whose news and reports race (the others prompt).
// And the fork in which a parent hears two children print, the replies
// crossing. The same two properties as dynamic-worker-protocol-model: never
// a refusal while a holder can progress, and always one when all are stuck.
//
// Every pairing of those children in the three shapes (304 runs, 8.1M
// states) ran once with no violation, in 35 min; this is the sample that
// fits the suite's per-file budget.

import assert from 'node:assert/strict';
import { CURRENT_PROTOCOL, describe, explore } from './lib/ledger-protocol-model.mjs';

const cases = [];
const rotations = [[['q'], ['q', 'b'], ['q', 's']], [['q', 'b'], ['q', 's'], ['q']], [['q', 's'], ['q'], ['q', 'b']]];
for (const [shape, parents] of [['side', ['R', 'R', 'R']], ['chain', ['R', 0, 1]], ['fork', ['R', 0, 0]]]) {
  // The fork's third rotation, its parent racing, is past the budget (more
  // than 500k states); it ran clean in the full sweep.
  for (const [r, children] of rotations.entries()) {
    const family = children.map((c, i) => ({ parent: parents[i], children: c }));
    for (const focus of shape === 'side' ? [null] : [10, 20, 30]) {
      if (shape === 'fork' && r === 2 && focus === 10) continue;
      cases.push([family, focus]);
    }
  }
}
for (const focus of [10, 20, 30]) cases.push([[{ parent: 'R', children: ['q'] }, { parent: 0, children: ['q'] }, { parent: 0, children: ['q'] }], focus]);

let states = 0;
const t0 = Date.now();
for (const [family, focus] of cases) {
  const result = await explore(CURRENT_PROTOCOL, family, { focus, maxStates: 500_000 });
  states += result.states;
  if (result.found.length > 0) {
    const [f] = result.found;
    assert.fail(`${JSON.stringify(family)} (focus ${focus}): ${f.violation}\n  ${describe(f.path)}`);
  }
}
console.log(`  ${cases.length} families, ${states} states, ${Date.now() - t0} ms: no violation`);
console.log('ok - dynamic-worker-protocol-model-three (three holders: no refusal while one can progress, and one whenever all are stuck)');
