// Seeded paired-probe samples for the grader's tests: four arms per round,
// log-normal around 600 ms, half the spread shared by a round's arms (one
// moment's conditions), the candidate's arms scaled by a code shift and each
// arm by its Preview's placement.

/** A seeded uniform and normal source (mulberry32, Box-Muller), so every run draws the same samples. */
export function seeded(seed) {
  let state = seed;
  const uniform = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297;
  };
  return { uniform, normal: () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform()) };
}

/**
 * `count` rounds with spread `sigma`; the candidate's arms (b1, b2) scaled by
 * `factor`, and each arm by its Preview's `offset` (1: none), drawn from `normal`.
 */
export function pairedRounds({ count, factor, sigma, normal, offset = {} }) {
  return Array.from({ length: count }, () => {
    const moment = normal();
    const draw = (arm) => 600 * Math.exp(sigma * (Math.SQRT1_2 * moment + Math.SQRT1_2 * normal())) * (offset[arm] ?? 1);
    return { a1: draw('a1'), a2: draw('a2'), b1: draw('b1') * factor, b2: draw('b2') * factor };
  });
}
