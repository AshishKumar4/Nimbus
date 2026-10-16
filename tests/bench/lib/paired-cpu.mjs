// One run's paired in-process CPU comparison of a kind of work, its arms
// made by the bench: A, the baseline; null, a second copy of the baseline,
// the A/A reference the branch's delta is judged against; real, the branch.

import { median } from '../../../scripts/lib/statistics.mjs';

export const shuffled = (items) => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
};

/** The CPU milliseconds `work` takes. */
export async function cpuMs(work) {
  const before = process.cpuUsage();
  await work();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

/**
 * `kind` over `pairs` pairs, each running every arm in a random order:
 * `cpu(arm, kind)` is one timed sample. A1 and A2 run A's copy of the code
 * twice a pair, so null's and real's run twice too (W, untimed): a copy
 * that ran half as often would sit at a colder JIT tier, and that bias is
 * larger than many deltas.
 */
export async function pairedKind(kind, arms, cpu, { pairs, warm, iterations }) {
  for (let round = 0; round < warm; round++) for (const arm of Object.values(arms)) await cpu(arm, kind);
  const samples = [];
  for (let pair = 0; pair < pairs; pair++) {
    const sample = {};
    for (const label of shuffled(['A1', 'A2', 'null', 'Wnull', 'real', 'Wreal'])) {
      const used = await cpu(arms[label.startsWith('A') ? 'A' : label.replace(/^W/, '')], kind);
      if (!label.startsWith('W')) sample[label] = used;
    }
    const A = (sample.A1 + sample.A2) / 2;
    samples.push({ ...sample, delta: sample.real - A, nullDelta: sample.null - A });
  }
  return {
    kind, iterations, pairs,
    medianA: median(samples.map(({ A1, A2 }) => (A1 + A2) / 2)), medianB: median(samples.map(({ real }) => real)),
    medianDelta: median(samples.map((sample) => sample.delta)), medianNullDelta: median(samples.map((sample) => sample.nullDelta)), samples,
  };
}
