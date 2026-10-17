#!/usr/bin/env bun
// tests/behavioral/_paired.mjs gradePaired: how a paired perf probe grades
// the candidate's two arms against the baseline's two. Run on samples it is
// given: the verdict must follow the candidate's shift, not one round's
// luck or one Preview's placement, hold back when either side disagrees
// with itself as much as the candidate differs, and be a function of its
// samples alone.

import assert from 'node:assert/strict';
import { gradePaired } from '../behavioral/_paired.mjs';

/** A seeded normal source (Box-Muller over mulberry32), so every run draws the same samples. */
function normals(seed) {
  let state = seed;
  const uniform = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

/**
 * `count` rounds around 600 ms, log-normal with spread `sigma`, half of it
 * shared by a round's four arms (one moment's conditions); the candidate's
 * arms scaled by `factor`, and each arm by its Preview's `offset` (1: none).
 */
function rounds({ count, factor, sigma = 0.25, seed, offset = {} }) {
  const normal = normals(seed);
  const shared = Math.SQRT1_2;
  return Array.from({ length: count }, () => {
    const moment = normal();
    const draw = (arm) => 600 * Math.exp(sigma * (shared * moment + shared * normal())) * (offset[arm] ?? 1);
    return { a1: draw('a1'), a2: draw('a2'), b1: draw('b1') * factor, b2: draw('b2') * factor };
  });
}

// The same three numbers on every arm: nothing to grade against.
{
  const same = [610, 580, 720, 640, 590, 605, 660, 700].map((ms) => ({ a1: ms, a2: ms, b1: ms, b2: ms }));
  const grade = gradePaired(same);
  assert.equal(grade.slower, false);
  assert.equal(grade.ratio, 1);
  assert.deepEqual(grade.medians, { a1: 625, a2: 625, b1: 625, b2: 625 });
}

// A candidate 1.5x slower in every round, under mild noise, is slower.
{
  const grade = gradePaired(rounds({ count: 15, factor: 1.5, sigma: 0.1, seed: 11 }));
  assert.equal(grade.slower, true, JSON.stringify(grade));
  assert.ok(grade.interval[0] > 1 && grade.ratio > 1.3, JSON.stringify(grade));
}

// A faster candidate is never slower.
assert.equal(gradePaired(rounds({ count: 15, factor: 0.6, sigma: 0.1, seed: 12 })).slower, false);

// The baseline disagreeing with itself (a1 twice a2 in every round) as much
// as the candidate exceeds it: the candidate is faster than a1, so not slower.
{
  const spread = [600, 640, 580, 700, 620, 660, 610, 590, 650, 630].map((ms) => ({ a1: ms * 2, a2: ms, b1: ms * 1.8, b2: ms * 1.8 }));
  const grade = gradePaired(spread);
  assert.ok(grade.interval[0] > 1, JSON.stringify(grade));
  assert.equal(grade.slower, false, JSON.stringify(grade));
}

// One Preview behind the others for the whole run, the candidate's own
// code unchanged: not slower, whichever arm it is. ruby-gem-require's
// receipts had one arm 1.3-1.6x the others in 9 of 14 runs.
for (const arm of ['a1', 'a2', 'b1', 'b2']) {
  const grade = gradePaired(rounds({ count: 20, factor: 1, sigma: 0.1, seed: 21, offset: { [arm]: 1.5 } }));
  assert.equal(grade.slower, false, `${arm} 1.5x behind: ${JSON.stringify(grade)}`);
}

// Both candidate Previews 1.3x slower: slower, and still when one Preview,
// on either side, is also slow for where it landed. A slow candidate
// Preview does not hide the shift its other Preview shows, and a slow
// baseline Preview counts once.
assert.equal(gradePaired(rounds({ count: 20, factor: 1.3, sigma: 0.1, seed: 22 })).slower, true);
for (const [arm, by] of [['a1', 1.15], ['a2', 1.2], ['b1', 1.5], ['b2', 1.5]]) {
  const grade = gradePaired(rounds({ count: 20, factor: 1.3, sigma: 0.1, seed: 23, offset: { [arm]: by } }));
  assert.equal(grade.slower, true, `1.3x slower with ${arm} ${by}x behind: ${JSON.stringify(grade)}`);
}
{
  const fixed = (a1, a2, b1, b2) => Array.from({ length: 15 }, (_, i) => ({ a1: a1 + (i % 5), a2: a2 + (i % 3), b1: b1 + (i % 4), b2: b2 + (i % 2) }));
  assert.equal(gradePaired(fixed(600, 600, 1170, 780)).slower, true, 'a 1.3x code shift beside a 1.5x slow candidate Preview');
  assert.equal(gradePaired(fixed(600, 720, 780, 780)).slower, true, 'a 1.3x code shift over a 1.2x slow baseline Preview');
}

// A verdict is a function of its samples: the same samples grade the same.
{
  const samples = rounds({ count: 15, factor: 1.2, seed: 13 });
  assert.deepEqual(gradePaired(samples), gradePaired(samples.map((round) => ({ ...round }))));
}

// Over many seeded runs: a candidate that is the baseline is rarely called
// slower, also with one Preview of the four 1.5x behind the rest, and a
// 1.5x slower one nearly always is. 15 rounds at a 0.25 log-spread.
{
  const trials = 100;
  const red = (factor, seedFrom, slowArm) => Array.from({ length: trials }, (_, i) => gradePaired(rounds({
    count: 15, factor, seed: seedFrom + i, offset: slowArm ? { [['a1', 'a2', 'b1', 'b2'][i % 4]]: 1.5 } : {},
  })).slower).filter(Boolean).length;
  const nullRed = red(1, 1000, false);
  const slowArmRed = red(1, 3000, true);
  const slowRed = red(1.5, 5000, false);
  const shiftRed = red(1.3, 7000, false);
  const shiftSlowArmRed = red(1.3, 9000, true);
  console.log(`  rates over ${trials}: A/A/B/B ${nullRed}, one slow Preview ${slowArmRed}, 1.5x ${slowRed}, 1.3x ${shiftRed}, 1.3x with one slow Preview ${shiftSlowArmRed}`);
  assert.ok(nullRed <= 6, `${nullRed} of ${trials} A/A/B/B runs graded slower`);
  assert.ok(slowArmRed <= 6, `${slowArmRed} of ${trials} runs with one slow Preview graded slower`);
  assert.ok(slowRed >= 80, `${slowRed} of ${trials} 1.5x runs graded slower`);
  assert.ok(shiftRed >= 50, `${shiftRed} of ${trials} 1.3x runs graded slower`);
  assert.ok(shiftSlowArmRed >= 40, `${shiftSlowArmRed} of ${trials} 1.3x runs with one slow Preview graded slower`);
}

console.log('paired-grading: ok');
