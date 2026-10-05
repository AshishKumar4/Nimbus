#!/usr/bin/env bun
// The Dynamic Worker ledger's deadlock protocol over every interleaving
// (lib/ledger-protocol-model.mjs, wired to production), for families of
// three guest holders in a fork (one holder with two under it), each with
// its holders' children rotated through a queued child, a queued child and a
// builtin, and a queued child and a shell line over a queued program, each
// holder in turn the one whose news and reports race (the others prompt).
// And the fork in which a parent hears two children print, the replies
// crossing. The same two properties as dynamic-worker-protocol-model: never
// a refusal while a holder can progress, and always one when all are stuck.
// Side by side and a chain: dynamic-worker-protocol-model-three.
//
// Every assignment of those three child sets to the three holders, in all
// three shapes, each holder of a chain or a fork in turn the one racing (189
// runs, 7.4M states), ran once with no violation (83 CPU-minutes); these
// files are the sample that fits the suite's per-file budget.

import { checkFamilies } from './lib/ledger-protocol-model.mjs';

const cases = [];
const rotations = [[['q'], ['q', 'b'], ['q', 's']], [['q', 'b'], ['q', 's'], ['q']], [['q', 's'], ['q'], ['q', 'b']]];
// The third rotation with its parent racing is past the budget (537k
// states, 196 s alone); it ran clean in the full sweep.
for (const [r, children] of rotations.entries()) {
  const family = children.map((c, i) => ({ parent: ['R', 0, 0][i], children: c }));
  for (const focus of [10, 20, 30]) {
    if (r === 2 && focus === 10) continue;
    cases.push([family, focus]);
  }
}
for (const focus of [10, 20, 30]) cases.push([[{ parent: 'R', children: ['q'] }, { parent: 0, children: ['q'] }, { parent: 0, children: ['q'] }], focus]);

await checkFamilies(cases);
console.log('ok - dynamic-worker-protocol-model-three-fork (three holders in a fork: no refusal while one can progress, and one whenever all are stuck)');
