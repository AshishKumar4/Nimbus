// The statistics the paired benches and the paired perf probes grade by: a
// median, and a seeded percentile-bootstrap interval of it, so a verdict is
// a function of its samples alone.

/** The median of `values`. */
export const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};

/** mulberry32: a small seeded generator. */
function generator(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The 95% percentile-bootstrap interval of `values`' median, over `resamples` seeded draws. */
export function medianInterval(values, { resamples = 4000, seed = 0x6e696d62 } = {}) {
  const random = generator(seed);
  const medians = Array.from({ length: resamples }, () => median(values.map(() => values[Math.floor(random() * values.length)])));
  medians.sort((x, y) => x - y);
  return [medians[Math.floor(0.025 * resamples)], medians[Math.ceil(0.975 * resamples) - 1]];
}
