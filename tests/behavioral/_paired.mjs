// Paired perf probes: graded against the baseline (main) measured in the
// same run, not against a fixed bound.
//
// A fixed bound graded the platform's state, not the code: cold-start, the
// same commit, measured 226-3022 ms across full runs, 598 ms at the median
// inside the suite and 1087 ms alone on a fresh deploy, so a bound either
// failed a good commit or let a slow one through by luck.
//
// remote-probes stands up three fresh Previews for a run that selects one of
// these probes: a1 and a2 of the baseline commit, b of the candidate, and
// hands them over in NIMBUS_PAIRED_TARGETS. Fresh and alike, so neither side
// is warmer than the other; two of the baseline, so the A/A spread carries
// the variance between deployments as well as between samples. Each round
// measures the three at once, one per Preview, so they share that moment's
// conditions.
//
// On a log scale, a round's d = ln b - (ln a1 + ln a2) / 2 and its null
// n = ln a1 - ln a2. The candidate is slower when the 95% bootstrap interval
// of the median d lies above 0 and the median d lies above the A/A interval
// (the median n's). The bootstrap is seeded, so the same samples always
// grade the same.
import { createProbeTarget } from './_session-transport.mjs';

/** The probes graded this way, as a selection names them. */
export const PAIRED_PROBES = ['perf-regression/cold-start', 'perf-regression/first-paint', 'perf-regression/install-warm'];

/** The baseline twice and the candidate once. */
export const ARMS = ['a1', 'a2', 'b'];

/** Where remote-probes hands over the arms: JSON { a1|a2|b: { base, token } }. */
export const PAIRED_ENV = 'NIMBUS_PAIRED_TARGETS';

/** Below this share of planned rounds measured on every arm, the run does not grade. */
const MIN_ROUND_SHARE = 0.8;
const RESAMPLES = 4000;
const SEED = 0x6e696d62;

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
 * `rounds` rounds of `measure(target, arm)`, the three arms at once in each.
 * `measure` resolves to its metrics (`{ name: ms }`) or throws why the arm
 * could not be measured. A round counts only if all three arms measured. A
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
    for (const failure of failed) (failure.arm === 'b' ? candidateFailures : baselineFailures).push(failure);
    if (failed.length === 0) {
      const sample = Object.fromEntries(ARMS.map((arm, i) => [arm, settled[i].value]));
      measured.push(sample);
      console.log(`  round ${round}: ${Object.keys(sample.b).map((metric) => `${metric} ${ARMS.map((arm) => `${arm}=${sample[arm][metric].toFixed(0)}`).join(' ')} ms`).join('; ')}`);
    } else {
      console.log(`  round ${round}: not measured — ${failed.map((failure) => `${failure.arm}: ${failure.error}`).join('; ')}`);
    }
  }
  return { planned: rounds, measured, candidateFailures, baselineFailures };
}

/** The median of `values`. */
export const median = (values) => {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** mulberry32: a small seeded generator, so a verdict is a function of its samples. */
function generator(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The 95% percentile-bootstrap interval of `values`' median. */
function medianInterval(values) {
  const random = generator(SEED);
  const medians = Array.from({ length: RESAMPLES }, () => median(values.map(() => values[Math.floor(random() * values.length)])));
  medians.sort((x, y) => x - y);
  return [medians[Math.floor(0.025 * RESAMPLES)], medians[Math.ceil(0.975 * RESAMPLES) - 1]];
}

/**
 * Grade one metric over measured rounds ({ a1, a2, b } of positive ms).
 * `ratio` is b over the baseline at the median round, with its interval;
 * `aa` is a1 over a2's interval; `slower` is the verdict.
 */
export function gradePaired(rounds) {
  const d = rounds.map(({ a1, a2, b }) => Math.log(b) - (Math.log(a1) + Math.log(a2)) / 2);
  const n = rounds.map(({ a1, a2 }) => Math.log(a1) - Math.log(a2));
  const shift = median(d);
  const [low, high] = medianInterval(d);
  const [aaLow, aaHigh] = medianInterval(n);
  return {
    rounds: rounds.length,
    medians: Object.fromEntries(ARMS.map((arm) => [arm, median(rounds.map((round) => round[arm]))])),
    ratio: Math.exp(shift),
    interval: [Math.exp(low), Math.exp(high)],
    aa: [Math.exp(aaLow), Math.exp(aaHigh)],
    slower: low > 0 && shift > aaHigh,
  };
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
  const detail = `candidate/baseline ${grade.ratio.toFixed(3)} (95% CI ${range(grade.interval)}); A/A ${range(grade.aa)}; `
    + `medians a1 ${grade.medians.a1.toFixed(0)} a2 ${grade.medians.a2.toFixed(0)} b ${grade.medians.b.toFixed(0)} ms over ${grade.rounds} rounds`;
  console.log(`  ${metric}: ${detail}`);
  a.check(`${metric}: the candidate is not slower than the baseline beyond the A/A spread`, !grade.slower, detail);
  return true;
}
