#!/usr/bin/env bun
// tests/behavioral/_paired.mjs gradePaired: how a paired perf probe grades
// the candidate's two arms against the baseline's two. Run on samples it is
// given: the verdict must follow the candidate's shift, not one round's
// luck or one Preview's placement, and be a function of its samples alone.
// Its red and power rates over many sets are paired-grader-power's.

import assert from 'node:assert/strict';
import { gradePaired } from '../behavioral/_paired.mjs';
import { confirmedVerdicts, pairedCpuVerdicts } from '../../scripts/ci/lib/paired-cpu.mjs';
import { median } from '../../scripts/lib/statistics.mjs';
import { pairedRounds, seeded } from './lib/paired-samples.mjs';

/** `count` seeded rounds; see lib/paired-samples.mjs. */
const rounds = ({ count, factor, sigma = 0.25, seed, offset = {} }) => pairedRounds({ count, factor, sigma, offset, normal: seeded(seed).normal });

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

/** 15 rounds at the four arms' given times, each arm with a small jitter of its own. */
const fixed = (a1, a2, b1, b2) => Array.from({ length: 15 }, (_, i) => ({ a1: a1 + (i % 5), a2: a2 + (i % 3), b1: b1 + (i % 4), b2: b2 + (i % 2) }));

// One Preview behind the others for the whole run, the candidate's own
// code unchanged: not slower, whichever arm it is. ruby-gem-require's
// receipts had one arm 1.3-1.6x the others in 9 of 14 runs. How often
// noise alone reds such a set is paired-grader-power's.
for (const [arm, samples] of Object.entries({ a1: fixed(900, 600, 600, 600), a2: fixed(600, 900, 600, 600), b1: fixed(600, 600, 900, 600), b2: fixed(600, 600, 600, 900) })) {
  const grade = gradePaired(samples);
  assert.equal(grade.slower, false, `${arm} 1.5x behind: ${JSON.stringify(grade)}`);
}

// Both candidate Previews 1.3x slower: slower, and still when one Preview,
// on either side, is also slow for where it landed: a slow candidate
// Preview leaves its other Preview's shift, and a slow baseline Preview
// raises the mean by half its offset.
assert.equal(gradePaired(rounds({ count: 20, factor: 1.3, sigma: 0.1, seed: 22 })).slower, true);
for (const [arm, by] of [['a1', 1.2], ['a2', 1.2], ['b1', 1.5], ['b2', 1.5]]) {
  const grade = gradePaired(rounds({ count: 20, factor: 1.3, sigma: 0.1, seed: 23, offset: { [arm]: by } }));
  assert.equal(grade.slower, true, `1.3x slower with ${arm} ${by}x behind: ${JSON.stringify(grade)}`);
}
{
  assert.equal(gradePaired(fixed(600, 600, 1170, 780)).slower, true, 'a 1.3x code shift beside a 1.5x slow candidate Preview');
  assert.equal(gradePaired(fixed(600, 720, 780, 780)).slower, true, 'a 1.3x code shift over a 1.2x slow baseline Preview');
  const grade = gradePaired(fixed(600, 600, 900, 600));
  assert.equal(grade.slower, false, 'one slow candidate Preview alone is not slower');
  assert.equal(grade.weakest.arm, 'b2', 'and the weaker candidate is named');
}

// A verdict is a function of its samples: the same samples grade the same.
{
  const samples = rounds({ count: 15, factor: 1.2, seed: 13 });
  assert.deepEqual(gradePaired(samples), gradePaired(samples.map((round) => ({ ...round }))));
}

function cpuRuns(samples) {
  const result = {
    kind: 'copy-cpu', samples,
    medianA: median(samples.map(({ A1, A2 }) => (A1 + A2) / 2)),
    medianB: median(samples.map(({ real }) => real)),
    medianDelta: median(samples.map(({ real, A1, A2 }) => real - (A1 + A2) / 2)),
    medianNullDelta: median(samples.map(({ null: copy, A1, A2 }) => copy - (A1 + A2) / 2)),
  };
  return Array.from({ length: 8 }, () => [{ ...result, samples: samples.map((sample) => ({ ...sample })) }]);
}

// Median subtraction is not paired subtraction. A baseline's changing cost
// and one noisy copy sample cannot make the copies' median difference 10.
{
  const samples = [
    { A1: 100, A2: 100, null: 100, real: 100 },
    { A1: 200, A2: 200, null: 210, real: 210 },
    { A1: 300, A2: 300, null: 300, real: 310 },
  ];
  const runs = cpuRuns(samples);
  assert.equal(runs[0][0].medianDelta - runs[0][0].medianNullDelta, 10,
    'the old difference-of-medians estimator falsely calls a copy slower');
  assert.equal(median(samples.map((sample) => sample.real - sample.null)), 0);
  const [verdict] = pairedCpuVerdicts(runs);
  assert.equal(verdict.medianDelta, 0, JSON.stringify(verdict));
  assert.deepEqual(verdict.ci95, [0, 0]);
  assert.deepEqual(verdict.failures, []);
  const drifted = cpuRuns(samples.map((sample, i) => ({ ...sample, A1: i * 1000, A2: i * 1000 })));
  assert.equal(pairedCpuVerdicts(drifted)[0].medianDelta, verdict.medianDelta,
    'the common A cancels inside every pair, before any median');
}

// Keeping the pairing cannot hide a genuine cost on every candidate sample.
for (const shift of [-10, 0, 10]) {
  const samples = [100, 200, 300].map((ms) => ({ A1: ms, A2: ms, null: ms + 5, real: ms + 5 + shift }));
  const [verdict] = pairedCpuVerdicts(cpuRuns(samples));
  assert.equal(verdict.medianDelta, shift);
  assert.deepEqual(verdict.ci95, [shift, shift]);
  assert.equal(verdict.failures.length > 0, shift > 0);
}

// A slower kind is slower only when a second set of runs finds it slower
// too; a kind the first set clears is not asked again.
{
  const graded = (shift) => pairedCpuVerdicts(cpuRuns([100, 200, 300].map((ms) => ({ A1: ms, A2: ms, null: ms, real: ms + shift }))))[0];
  const [held] = confirmedVerdicts([graded(10)], [graded(10)]);
  assert.equal(held.failures.length, 2, JSON.stringify(held));
  assert.deepEqual(held.confirmation.ci95, [10, 10]);
  const [cleared] = confirmedVerdicts([graded(10)], [graded(0)]);
  assert.deepEqual(cleared.failures, [], 'slower on one set of runs only: not slower');
  assert.deepEqual(cleared.confirmation.ci95, [0, 0], 'and the verdict keeps what the second set found');
  const [untouched] = confirmedVerdicts([graded(0)], [graded(10)]);
  assert.deepEqual(untouched, graded(0), 'a kind the first set clears is graded by it alone');
  const [unmeasured] = confirmedVerdicts([graded(10)], pairedCpuVerdicts([]));
  assert.equal(unmeasured.failures.length, 2, `a second set that measured nothing leaves it slower: ${JSON.stringify(unmeasured)}`);
}

// Each kind any run measured is graded over the runs that measured it, and
// says how many did: remotePairedCpu passes no set with a kind some run missed.
{
  const runs = cpuRuns([100, 200, 300].map((ms) => ({ A1: ms, A2: ms, null: ms, real: ms + 10 })));
  const other = { ...runs[1][0], kind: 'other-cpu' };
  const verdicts = pairedCpuVerdicts([runs[0], [...runs[1], other], ...runs.slice(2)]);
  assert.deepEqual(verdicts.map(({ kind, runs: measured }) => [kind, measured]), [['copy-cpu', 8], ['other-cpu', 1]]);
}

console.log('paired-grading: ok');
