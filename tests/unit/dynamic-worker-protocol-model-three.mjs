#!/usr/bin/env bun
// @tier slow — long; CI median 93 s wall, 82 s CPU, 0.1 GiB peak (6 runs, 2026-10-06)
// The Dynamic Worker ledger's deadlock protocol over every interleaving
// (lib/ledger-protocol-model.mjs, wired to production), for families of
// three guest holders, side by side and in a chain, each with its holders'
// children rotated through a queued child, a queued child and a builtin, and
// a queued child and a shell line over a queued program; in a chain, each
// holder in turn the one whose news and reports race (the others prompt).
// The same two properties as dynamic-worker-protocol-model: never a refusal
// while a holder can progress, and always one when all are stuck. A fork:
// dynamic-worker-protocol-model-three-fork.
//
// Every assignment of those three child sets to the three holders, in all
// three shapes, each holder of a chain or a fork in turn the one racing (189
// runs, 7.4M states), ran once with no violation (83 CPU-minutes); these
// files are the sample that fits the suite's per-file budget.

import { checkFamilies, threeHolderCases } from './lib/ledger-protocol-model.mjs';

// Side by side and a chain here; a fork in dynamic-worker-protocol-model-three-fork.
const cases = [...threeHolderCases('side'), ...threeHolderCases('chain')];
await checkFamilies(cases);
console.log('ok - dynamic-worker-protocol-model-three (three holders: no refusal while one can progress, and one whenever all are stuck)');
