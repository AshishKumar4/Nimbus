// Paired perf probes: graded against the baseline (main) measured in the
// same run, not against a fixed bound.
//
// A fixed bound graded the platform's state, not the code: cold-start, the
// same commit, measured 226-3022 ms across full runs, 598 ms at the median
// inside the suite and 1087 ms alone on a fresh deploy, so a bound either
// failed a good commit or let a slow one through by luck.
//
// remote-probes stands up four fresh Previews for a run that selects one of
// these probes: a1 and a2 of the baseline commit, b1 and b2 of the
// candidate, and hands them over in NIMBUS_PAIRED_TARGETS. Fresh and alike,
// so neither side is warmer than the other. Each round measures the four at
// once, one per Preview, so they share that moment's conditions.
//
// Two of each side, because a Preview can be slower than another of the
// same code for a whole run: where it landed, not what it runs.
// ruby-gem-require's three arms had one 300-500 ms behind the other two in
// 9 of 14 runs, a1, a2 or b at random, and graded the candidate slower each
// time it was b. Slower means the code, so it must hold for both candidate
// Previews against both baseline ones.
//
// On a log scale, for each pair of a candidate arm bi and a baseline arm aj,
// a round's d_ij = ln bi - ln aj. The candidate is slower when every d_ij's
// 95% bootstrap interval lies above 0: each of its Previews slower than each
// of the baseline's. One Preview slow for where it landed leaves two of the
// four pairs at 0, whichever side it is on; a Preview slow beside a slower
// candidate leaves all four above it. The reported shift is the candidates'
// mean over the baselines' mean, beside the weakest pair's interval and the
// A/A and B/B intervals (a1 over a2, b1 over b2) that show a slow Preview.
// The bootstrap is seeded, so the same samples always grade the same.
import { median, medianInterval } from '../../scripts/lib/statistics.mjs';
import { createProbeTarget } from './_session-transport.mjs';

/** The probes graded this way, as a selection names them. */
export const PAIRED_PROBES = ['perf-regression/cold-start', 'perf-regression/first-paint', 'perf-regression/install-warm', 'perf-regression/clone-fast', 'perf-regression/module-load', 'perf-regression/ruby-gem-require'];

/** The baseline's arms and the candidate's. */
export const BASELINE_ARMS = ['a1', 'a2'];
export const CANDIDATE_ARMS = ['b1', 'b2'];
export const ARMS = [...BASELINE_ARMS, ...CANDIDATE_ARMS];

/** Where remote-probes hands over the arms: JSON { a1|a2|b1|b2: { base, token } }. */
export const PAIRED_ENV = 'NIMBUS_PAIRED_TARGETS';

/** Below this share of planned rounds measured on every arm, the run does not grade. */
const MIN_ROUND_SHARE = 0.8;

/**
 * The arms' probe targets. A run without them cannot grade a paired probe:
 * it exits 2, not graded, naming the command that provides them.
 */
export function requirePairedTargets(label, env = process.env) {
  if (!env[PAIRED_ENV]) {
    console.error(`${label}: NOT GRADED — a paired probe needs ${PAIRED_ENV}, the baseline and candidate Previews bun scripts/ci/remote-probes.mjs stands up for it`);
    process.exit(2);
  }
  const arms = JSON.parse(env[PAIRED_ENV]);
  return Object.fromEntries(ARMS.map((arm) => [arm, createProbeTarget({ base: arms[arm].base, token: arms[arm].token })]));
}

/**
 * `rounds` rounds of `measure(target, arm)`, the four arms at once in each.
 * `measure` resolves to its metrics (`{ name: ms }`) or throws why the arm
 * could not be measured. A round counts only if every arm measured. A
 * candidate's throw is the candidate failing; a baseline's loses its round.
 */
export async function measurePaired(arms, rounds, measure) {
  const measured = [];
  const candidateFailures = [];
  const baselineFailures = [];
  for (let round = 1; round <= rounds; round++) {
    const settled = await Promise.allSettled(ARMS.map((arm) => measure(arms[arm], arm)));
    const failed = settled.flatMap((outcome, i) => outcome.status === 'rejected'
      ? [{ round, arm: ARMS[i], error: outcome.reason?.message ?? String(outcome.reason) }] : []);
    for (const failure of failed) (CANDIDATE_ARMS.includes(failure.arm) ? candidateFailures : baselineFailures).push(failure);
    if (failed.length === 0) {
      const sample = Object.fromEntries(ARMS.map((arm, i) => [arm, settled[i].value]));
      measured.push(sample);
      console.log(`  round ${round}: ${Object.keys(sample.b1).map((metric) => `${metric} ${ARMS.map((arm) => `${arm}=${sample[arm][metric].toFixed(0)}`).join(' ')} ms`).join('; ')}`);
    } else {
      console.log(`  round ${round}: not measured — ${failed.map((failure) => `${failure.arm}: ${failure.error}`).join('; ')}`);
    }
  }
  return { planned: rounds, measured, candidateFailures, baselineFailures };
}

/**
 * Grade one metric over measured rounds ({ a1, a2, b1, b2 } of positive ms).
 * `ratio` is the candidates over the baselines at the median round, with its
 * interval; `weakest` is the candidate/baseline pair whose interval reaches
 * lowest, with that interval; `aa` and `bb` are a1 over a2's and b1 over
 * b2's intervals; `slower` is the verdict.
 */
export function gradePaired(rounds) {
  const ln = (round, arm) => Math.log(round[arm]);
  const mean = (round, arms) => arms.reduce((sum, arm) => sum + ln(round, arm), 0) / arms.length;
  const shift = rounds.map((round) => mean(round, CANDIDATE_ARMS) - mean(round, BASELINE_ARMS));
  const [low, high] = medianInterval(shift);
  const aa = medianInterval(rounds.map((round) => ln(round, 'a1') - ln(round, 'a2')));
  const bb = medianInterval(rounds.map((round) => ln(round, 'b1') - ln(round, 'b2')));
  const pairs = CANDIDATE_ARMS.flatMap((b) => BASELINE_ARMS.map((a) => ({
    pair: `${b}/${a}`, interval: medianInterval(rounds.map((round) => ln(round, b) - ln(round, a))),
  })));
  const weakest = pairs.reduce((low, pair) => (pair.interval[0] < low.interval[0] ? pair : low));
  return {
    rounds: rounds.length,
    medians: Object.fromEntries(ARMS.map((arm) => [arm, median(rounds.map((round) => round[arm]))])),
    ratio: Math.exp(median(shift)),
    interval: [Math.exp(low), Math.exp(high)],
    weakest: { pair: weakest.pair, interval: weakest.interval.map(Math.exp) },
    aa: aa.map(Math.exp),
    bb: bb.map(Math.exp),
    slower: weakest.interval[0] > 0,
  };
}

/**
 * Check on the asserter `a` that every candidate round did `what`: one
 * failed check per round that did not, with its own error, so each failure
 * stands alone (remote-probes regrades a row only when every failure is a
 * reset it can attribute).
 */
export function assertCandidateRounds(a, what, result) {
  if (result.candidateFailures.length === 0) a.check(`every candidate round: ${what}`, true);
  for (const failure of result.candidateFailures) a.check(`candidate round ${failure.round}: ${what}`, false, failure.error);
}

/**
 * Check `metric` of `result` (measurePaired's) on the asserter `a`. Returns
 * false when too few rounds measured to grade it; the probe then exits 2
 * unless something else failed.
 */
export function assertPaired(a, metric, result) {
  if (result.measured.length < Math.ceil(MIN_ROUND_SHARE * result.planned)) {
    console.log(`  ${metric}: NOT GRADED — ${result.measured.length} of ${result.planned} rounds measured on every arm`);
    return false;
  }
  const grade = gradePaired(result.measured.map((round) => Object.fromEntries(ARMS.map((arm) => [arm, round[arm][metric]]))));
  const range = ([low, high]) => `${low.toFixed(3)}-${high.toFixed(3)}`;
  const detail = `candidate/baseline ${grade.ratio.toFixed(3)} (95% CI ${range(grade.interval)}); weakest pair ${grade.weakest.pair} ${range(grade.weakest.interval)}; `
    + `A/A ${range(grade.aa)}; B/B ${range(grade.bb)}; medians ${ARMS.map((arm) => `${arm} ${grade.medians[arm].toFixed(0)}`).join(' ')} ms over ${grade.rounds} rounds`;
  console.log(`  ${metric}: ${detail}`);
  a.check(`${metric}: the candidate is not slower than the baseline on each of its Previews against each of the baseline's`, !grade.slower, detail);
  return true;
}
