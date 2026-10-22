#!/usr/bin/env bun
// perf-regression/cjs-global-reads — a node program's loops that read a
// global, against the baseline: in a strict CommonJS module it requires, and
// in its sloppy entry.
//
// User flow timed: `node strict.js` and `node entry.js`, each 2e7 rounds of
// Math.imul, from the command to its last line; the least of REPEATS a round.
// workerd compiles a `{ cjs }` module so that each global read costs ~140 ns:
// 2e7 of them took 2.9-3.1 s there and the whole loop 28-54 ms in an ES
// module (2026-10-21, verdict 20261021T224745-d95ed4dfaace). A strict cell is
// an ES module and a sloppy entry is compiled as the launch loads (core
// commonjs-cell.ts THE WRAPPER); this guards both.
//
// Graded paired (_paired.mjs): each round runs the flow on the baseline's
// two Previews and the candidate's, at once.
//
// Realistic causes of a fail here:
//   - a strict cell emitted as a `{ cjs }` module again (strictModuleCell);
//   - a sloppy entry required as a module, not compiled at load
//     (manager.ts programEntry, the guest's __nimbusEntryLoaded).

import { mintSession, Terminal, makeAsserter, deleteSession, stripAnsi } from '../_driver.mjs';
import { assertCandidateRounds, assertPaired, measurePaired, requirePairedTargets } from '../_paired.mjs';

const a = makeAsserter('perf-regression/cjs-global-reads');
const arms = requirePairedTargets('perf-regression/cjs-global-reads');
console.log(`perf-regression/cjs-global-reads — baseline ${arms.a1.base}, ${arms.a2.base}; candidate ${arms.b1.base}, ${arms.b2.base}`);

const ROUNDS = 12;
/**
 * Runs a round: a single wall carries a launch's own spikes, and the least of
 * a few is the program's. The command's cost here is seconds against tens of
 * milliseconds between the two kinds, so two suffice to see it.
 */
const REPEATS = 2;
const LOOP = 'let h = 0; for (let i = 0; i < 2e7; i++) h = Math.imul(h ^ i, 16777619);';
const FILES = {
  'loop-strict.js': `"use strict";\nmodule.exports = () => { ${LOOP} return h; };\n`,
  'strict.js': 'console.log("strict " + require("./loop-strict")());\n',
  'entry.js': `${LOOP}\nconsole.log("entry " + h);\n`,
};

/** `command`'s least wall over REPEATS, once it printed its line. */
async function leastWall(t, command, line) {
  const walls = [];
  for (let i = 0; i < REPEATS; i++) {
    const timed = await t.run(command, 120_000);
    if (!new RegExp(`^${line} -?\\d+$`, 'm').test(stripAnsi(timed.output))) throw new Error(`${command}: ${JSON.stringify(stripAnsi(timed.output).slice(-300))}`);
    walls.push(timed.elapsed);
  }
  return Math.min(...walls);
}

const result = await measurePaired(arms, ROUNDS, async (target) => {
  const sid = await mintSession(target);
  const t = new Terminal(sid);
  try {
    await t.connect();
    await t.waitForPrompt(30_000);
    await t.run('mkdir -p cg && cd cg', 30_000);
    for (const [name, text] of Object.entries(FILES)) await t.writeFile(name, text);
    // Once untimed, so each program's map is staged, as every arm's is.
    await t.run('node strict.js && node entry.js', 120_000);
    return { 'strict cell global reads': await leastWall(t, 'node strict.js', 'strict'), 'sloppy entry global reads': await leastWall(t, 'node entry.js', 'entry') };
  } finally {
    await t.close();
    await deleteSession(sid);
  }
});

assertCandidateRounds(a, 'its programs run their loops', result);
const strict = assertPaired(a, 'strict cell global reads', result);
const entry = assertPaired(a, 'sloppy entry global reads', result);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : strict && entry ? 0 : 2);
