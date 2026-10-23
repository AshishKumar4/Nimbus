#!/usr/bin/env bun
// perf-regression/cjs-global-reads — a node program's loop that reads a
// global in a strict CommonJS module it requires, against the baseline; and a
// resident's writes, each stat'ed after, as a dev server writes its output.
//
// User flow timed: `node strict.js`, 2e7 rounds of Math.imul, from the
// command to its last line; the least of REPEATS a round. workerd compiles a
// `{ cjs }` module so that each global read costs ~140 ns: 2e7 of them took
// 2.9-3.1 s there and the whole loop 28-54 ms in an ES module (2026-10-21,
// verdict 20261021T224745-d95ed4dfaace). A strict cell is an ES module (core
// commonjs-cell.ts THE WRAPPER); this guards it.
//
// Graded paired (_paired.mjs): each round runs the flow on the baseline's
// two Previews and the candidate's, at once.
//
// Realistic causes of a fail here:
//   - a strict cell emitted as a `{ cjs }` module again (strictModuleCell).
//   - a resident's awaited write, or the stat after it, taking more round
//     trips to the session (core runtime/wasi/resident-filesystem.ts).

import { mintSession, Terminal, makeAsserter, deleteSession, stripAnsi } from '../_driver.mjs';
import { assertCandidateRounds, assertPaired, measurePaired, requirePairedTargets } from '../_paired.mjs';

const a = makeAsserter('perf-regression/cjs-global-reads');
const arms = requirePairedTargets('perf-regression/cjs-global-reads');
console.log(`perf-regression/cjs-global-reads — baseline ${arms.a1.base}, ${arms.a2.base}; candidate ${arms.b1.base}, ${arms.b2.base}`);

/**
 * What it guards is tenfold: 2e7 reads in a `{ cjs }` module cost 2.9-3.1 s, and the whole program here 0.2-0.5 s.
 * Two A/As of one commit at 12 rounds passed at 0.910-0.912, their arms' intervals within 0.70-1.38 (2026-10-22,
 * verdicts 20261022T012719-3f5d0a132e46 and 20261022T014024-3f5d0a132e46): a twofold change is outside every one.
 */
const ROUNDS = 12;
/**
 * Runs a round: a single wall carries a launch's own spikes, and the least of
 * a few is the program's. The command's cost here is seconds against tens of
 * milliseconds between the two kinds, so two suffice to see it.
 */
const REPEATS = 2;
const LOOP = 'let h = 0; for (let i = 0; i < 2e7; i++) h = Math.imul(h ^ i, 16777619);';
/** Writes a resident makes, each awaited and then stat'ed, into a directory of its own: its time, in the resident. */
const WRITES = 200;
const FILES = {
  'loop-strict.js': `"use strict";\nmodule.exports = () => { ${LOOP} return h; };\n`,
  'strict.js': 'console.log("strict " + require("./loop-strict")());\n',
  // A server is a resident (it listens): its writes run where a dev server's do.
  'writes.js': [
    'const fs = require("fs");',
    'const server = require("http").createServer((q, s) => s.end()).listen(0, async () => {',
    '  fs.mkdirSync("out", { recursive: true });',
    '  const begin = performance.now();',
    `  for (let i = 0; i < ${WRITES}; i++) { await fs.promises.writeFile("out/f" + (i % 20) + ".js", "export default " + i + ";\\n"); fs.statSync("out/f" + (i % 20) + ".js"); }`,
    '  console.log("writes " + Math.round(performance.now() - begin));',
    '  server.close();',
    '});',
  ].join('\n') + '\n',
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

/** The least `line` reports of its own time over REPEATS: a resident's loop, timed where it runs. */
async function leastReported(t, command, line) {
  const reported = [];
  for (let i = 0; i < REPEATS; i++) {
    const timed = await t.run(command, 120_000);
    const found = new RegExp(`^${line} (\\d+)$`, 'm').exec(stripAnsi(timed.output));
    if (found === null) throw new Error(`${command}: ${JSON.stringify(stripAnsi(timed.output).slice(-300))}`);
    reported.push(Number(found[1]));
  }
  return Math.min(...reported);
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
    await t.run('node strict.js', 120_000);
    await t.run('node writes.js', 120_000);
    return {
      'strict cell global reads': await leastWall(t, 'node strict.js', 'strict'),
      'resident write then stat': await leastReported(t, 'node writes.js', 'writes'),
    };
  } finally {
    await t.close();
    await deleteSession(sid);
  }
});

assertCandidateRounds(a, 'its programs run their loops', result);
const gradedReads = assertPaired(a, 'strict cell global reads', result);
const gradedWrites = assertPaired(a, 'resident write then stat', result);
const graded = gradedReads && gradedWrites;

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : graded ? 0 : 2);
