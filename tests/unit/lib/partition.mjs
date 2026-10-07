// How the unit suite is cut into parts that finish together: the CI plan
// (scripts/ci/unit.mjs) prints them, and run-all orders each part's pool by
// the same expected costs.

/**
 * A file's cost from its timings `{ wallMs, cpuMs }`. A job slot is taken to
 * be one CPU, so a pooled file costs the larger of its wall and CPU time (one
 * running four threads holds four slots' worth); a file in the serial phase
 * has every CPU and costs its wall time.
 */
export function costMs(timing, alone) {
  return alone ? timing?.wallMs || 0 : Math.max(timing?.wallMs || 0, timing?.cpuMs || 0);
}

/**
 * Each of `names`' expected cost from `known`
 * (`{ "<name>.mjs": { wallMs, cpuMs } }`); a file it lacks costs the median
 * of those it has.
 */
export function expectedCosts(names, known, runsAlone) {
  const cost = (name) => costMs(known[name], runsAlone(name));
  const measured = names.map(cost).filter((ms) => Number.isFinite(ms) && ms > 0).sort((a, b) => a - b);
  const median = measured.length > 0 ? measured[Math.floor(measured.length / 2)] : 1000;
  return (name) => (Number.isFinite(cost(name)) && cost(name) > 0 ? cost(name) : median);
}

/**
 * `names` in `count` parts, longest first: each file joins the part whose
 * expected finish it moves least. A part's expected time is its pool (the
 * larger of total/jobs and its longest file) plus its serial files one after
 * another. Ties go to the lower part and names break ties in order, so the
 * same inputs always give the same parts.
 */
export function partition(names, count, { expectedMs, runsAlone, jobs }) {
  const parts = Array.from({ length: count }, () => ({ pool: 0, longest: 0, serial: 0, names: [] }));
  const finish = (p) => Math.max(p.pool / jobs, p.longest) + p.serial;
  const order = [...names].sort((a, b) => expectedMs(b) - expectedMs(a) || a.localeCompare(b));
  for (const name of order) {
    const ms = expectedMs(name);
    const alone = runsAlone(name);
    let best = 0;
    let bestFinish = Infinity;
    for (let i = 0; i < count; i++) {
      const p = parts[i];
      const after = alone ? finish(p) + ms : Math.max((p.pool + ms) / jobs, p.longest, ms) + p.serial;
      if (after < bestFinish) { best = i; bestFinish = after; }
    }
    const p = parts[best];
    if (alone) p.serial += ms; else { p.pool += ms; p.longest = Math.max(p.longest, ms); }
    p.names.push(name);
  }
  return parts.map((p) => ({ names: p.names, expectedMs: Math.round(finish(p)) }));
}
