#!/usr/bin/env bun
// perf-regression/clone-fast — git clone, against the baseline.
//
// User flow timed: `git clone https://github.com/AshishKumar4/markflow.git`
// on a fresh session. End-to-end including HTTPS handshake, packfile
// fetch, and VFS write.
//
// Graded paired (_paired.mjs): each round clones on the baseline's two
// Previews and the candidate's, at once, so all three share GitHub's and
// the network's state at that moment. The fixed 5600 ms bound it replaces
// failed 5 of 591 full runs of main commits (10-09..10-17) on unchanged code
// at 6130-13135 ms, and passed any clone up to 2.2x the 2517 ms median.
//
// Realistic causes of a fail here:
//   - cf-git pack-fetch path slowed.
//   - VFS writeBatchStream regressed (pack expansion).
//   - Network-facet round-trip inflation.

import { mintSession, Terminal, makeAsserter, deleteSession } from '../_driver.mjs';
import { assertCandidateRounds, assertPaired, measurePaired, requirePairedTargets } from '../_paired.mjs';

const a = makeAsserter('perf-regression/clone-fast');
const arms = requirePairedTargets('perf-regression/clone-fast');
console.log(`perf-regression/clone-fast — baseline ${arms.a1.base}, ${arms.a2.base}; candidate ${arms.b.base}`);

// Three runs of the unchanged code against itself (2026-10-17), cut into
// disjoint blocks and graded with each arm in turn as the candidate: at 40
// rounds, the unchanged code red in 0 of 9 and a +600 ms clone red in 9 of 9;
// at 20, 1 of 18 and 17 of 18. A +600 ms clone ran red on its own run, with
// a median of 2908 ms that the fixed bound passed. A round takes about 4 s.
const ROUNDS = 40;

const result = await measurePaired(arms, ROUNDS, async (target) => {
  const sid = await mintSession(target);
  const t = new Terminal(sid);
  try {
    await t.connect();
    await t.waitForPrompt(30_000);
    const t0 = performance.now();
    const { output, exitCode } = await t.run('git clone https://github.com/AshishKumar4/markflow.git mf', 60_000);
    const ms = performance.now() - t0;
    if (exitCode !== 0) throw new Error(`${sid}: git clone exited ${exitCode}; tail=${JSON.stringify(output.slice(-300))}`);
    return { clone: ms };
  } finally {
    await t.close();
    await deleteSession(sid);
  }
});

assertCandidateRounds(a, 'git clone exits 0', result);
const graded = assertPaired(a, 'clone', result);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : graded ? 0 : 2);
