#!/usr/bin/env bun
// tests/behavioral/_paired.mjs gradePaired: how a paired perf probe grades
// the candidate against the baseline's two arms. Run on samples it is
// given: the verdict must follow the candidate's shift, not one round's
// luck, hold back when the baseline disagrees with itself as much as the
// candidate differs, and be a function of its samples alone.

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
 * shared by a round's three arms (one moment's conditions); the candidate
 * scaled by `factor`.
 */
function rounds({ count, factor, sigma = 0.25, seed }) {
  const normal = normals(seed);
  const shared = Math.SQRT1_2;
  return Array.from({ length: count }, () => {
    const moment = normal();
    const draw = () => 600 * Math.exp(sigma * (shared * moment + shared * normal()));
    return { a1: draw(), a2: draw(), b: draw() * factor };
  });
}

// The same three numbers on every arm: nothing to grade against.
{
  const same = [610, 580, 720, 640, 590, 605, 660, 700].map((ms) => ({ a1: ms, a2: ms, b: ms }));
  const grade = gradePaired(same);
  assert.equal(grade.slower, false);
  assert.equal(grade.ratio, 1);
  assert.deepEqual(grade.medians, { a1: 625, a2: 625, b: 625 });
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
// as the candidate exceeds it: the shift is inside the A/A spread.
{
  const spread = [600, 640, 580, 700, 620, 660, 610, 590, 650, 630].map((ms) => ({ a1: ms * 2, a2: ms, b: ms * 1.8 }));
  const grade = gradePaired(spread);
  assert.ok(grade.interval[0] > 1, JSON.stringify(grade));
  assert.equal(grade.slower, false, JSON.stringify(grade));
}

// A verdict is a function of its samples: the same samples grade the same.
{
  const samples = rounds({ count: 15, factor: 1.2, seed: 13 });
  assert.deepEqual(gradePaired(samples), gradePaired(samples.map((round) => ({ ...round }))));
}

// Over many seeded runs: a candidate that is the baseline is rarely called
// slower, and a 1.5x slower one nearly always is. 15 rounds at a 0.25
// log-spread; a Python port of this grader measured 2% and 96% there.
{
  const trials = 100;
  const red = (factor, offset) => Array.from({ length: trials }, (_, i) => gradePaired(rounds({ count: 15, factor, seed: offset + i })).slower)
    .filter(Boolean).length;
  const nullRed = red(1, 1000);
  const slowRed = red(1.5, 5000);
  assert.ok(nullRed <= 6, `${nullRed} of ${trials} A/A/A runs graded slower`);
  assert.ok(slowRed >= 85, `${slowRed} of ${trials} 1.5x runs graded slower`);
}

console.log('paired-grading: ok');
