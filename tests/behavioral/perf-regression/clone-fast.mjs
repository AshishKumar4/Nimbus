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

const ROUNDS = 40;

const result = await measurePaired(arms, ROUNDS, async (target) => {
  const sid = await mintSession(target);
  const t = new Terminal(sid);
  try {
    await t.connect();
    await t.waitForPrompt(30_000);
    const t0 = performance.now();
    const { output } = await t.run('git clone https://github.com/AshishKumar4/markflow.git mf', 60_000);
    const ms = performance.now() - t0;
    if (!/Cloning into|cloned/.test(output) || /clone failed/.test(output)) throw new Error(`${sid}: git clone did not report success; tail=${JSON.stringify(output.slice(-300))}`);
    return { clone: ms };
  } finally {
    await t.close();
    await deleteSession(sid);
  }
});

assertCandidateRounds(a, 'git clone reports success', result);
const graded = assertPaired(a, 'clone', result);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : graded ? 0 : 2);
