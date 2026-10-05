#!/usr/bin/env bun
// The Dynamic Worker ledger's deadlock protocol over every interleaving
// (lib/ledger-protocol-model.mjs, wired to production), for families of two
// guest holders, one under the other, each with up to two children of three
// kinds (a child queued for a worker, a builtin running in the session,
// `sh -c 'node x'`): never a refusal while a holder can progress, and always
// one when all are stuck. Half of them here (the upper holder's children
// every other set), half in dynamic-worker-protocol-model-nested (the time a file
// may take); the rest of the two-holder scope, and the mutants:
// dynamic-worker-protocol-model.

import { checkFamilies, childSets } from './lib/ledger-protocol-model.mjs';

const sets = childSets(2);
const cases = [];
for (const [i, a] of sets.entries()) {
  if (i % 2 !== 1) continue;
  for (const b of sets) cases.push([{ parent: 'R', children: a }, { parent: 0, children: b }]);
}
await checkFamilies(cases);
console.log('ok - dynamic-worker-protocol-model-nested-2 (two holders, one under the other: no refusal while one can progress, and one whenever all are stuck)');
