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

import { checkFamilies, nestedCases } from './lib/ledger-protocol-model.mjs';

const cases = nestedCases(1);
await checkFamilies(cases);
console.log('ok - dynamic-worker-protocol-model-nested-2 (two holders, one under the other: no refusal while one can progress, and one whenever all are stuck)');
