#!/usr/bin/env bun
// @tier slow — grades 4,800 simulated sets of paired rounds
//
// How often gradePaired (tests/behavioral/_paired.mjs) calls a candidate
// slower, the way remote-probes uses it: red on one set of Previews,
// confirmed on a fresh set, then red again on one more fresh set
// (scripts/ci/lib/rerun.mjs, which reruns a confirmed red once). The noise
// shapes are the probes' own: cold start
// (40 rounds, a 0.3 log-spread, a Preview slow 1.3x for where it landed
// about 3 times in 10) and ruby launch (20 rounds, 0.12, a Preview slow 1.5x
// about half the time). A rule change is judged here: it must keep false reds
// rare and find a real +46% (+300 ms on a 650 ms cold start).
import assert from 'node:assert/strict';
import { gradePaired } from '../behavioral/_paired.mjs';
import { pairedRounds, seeded } from './lib/paired-samples.mjs';

const TRIALS = 300;
const SHAPES = [
  { name: 'cold start', count: 40, sigma: 0.3, pSlow: 0.3, slowBy: 1.3 },
  { name: 'ruby launch', count: 20, sigma: 0.12, pSlow: 0.5, slowBy: 1.5 },
];
const { uniform, normal } = seeded(0x70617764);
/** One set of Previews: each lands slow (`slowBy`) with probability `pSlow`, for the whole set. */
const set = ({ count, sigma, pSlow, slowBy }, factor) => pairedRounds({
  count, factor, sigma, normal,
  offset: Object.fromEntries(['a1', 'a2', 'b1', 'b2'].map((arm) => [arm, uniform() < pSlow ? slowBy : 1])),
});

const rates = {};
for (const shape of SHAPES) {
  for (const factor of [1, 1.3, 1.46]) {
    let once = 0, confirmed = 0, rerun = 0;
    for (let i = 0; i < TRIALS; i++) {
      if (!gradePaired(set(shape, factor)).slower) continue;
      once++;
      if (!gradePaired(set(shape, factor)).slower) continue;
      confirmed++;
      if (gradePaired(set(shape, factor)).slower) rerun++;
    }
    rates[`${shape.name} x${factor}`] = { once: once / TRIALS, confirmed: confirmed / TRIALS, rerun: rerun / TRIALS };
    console.log(`  ${shape.name} x${factor}: red on one set ${Math.round(once / TRIALS * 100)}%, confirmed on a fresh set ${Math.round(confirmed / TRIALS * 100)}%, red again on one more ${Math.round(rerun / TRIALS * 100)}%`);
  }
}
// The grade is the third set's. The rerun costs power for a little more
// trust: measured here (2026-10-24), +30% cold start 62% confirmed and 50%
// after the rerun, +46% ruby launch 64% and 54%, +46% cold start 94% and 89%.
for (const shape of SHAPES) assert.ok(rates[`${shape.name} x1`].rerun <= 0.06, `${shape.name}: unchanged code graded slower too often`);
assert.ok(rates['cold start x1.46'].rerun >= 0.85, 'a real +46% cold start is found');
assert.ok(rates['cold start x1.3'].rerun >= 0.45, 'a real +30% cold start is found about half the time');
assert.ok(rates['ruby launch x1.46'].rerun >= 0.5, 'a real +46% ruby launch is found about half the time');
console.log('paired-grader-power: ok');
