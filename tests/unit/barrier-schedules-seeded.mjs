#!/usr/bin/env bun
// @tier slow — 24 seeded schedules on each engine, each in its own child: 102 s on armada when green, a failing seed then shrunk within 120 s
/**
 * barrier-schedules-seeded — the barrier schedules (lib/barrier-schedule.mjs)
 * drawn from seeds, each reply parked at random once the process is up, on
 * each engine: NIMBUS_BARRIER_SEEDS=n runs n seeds (default 24), from
 * NIMBUS_BARRIER_SEED_FROM. The unit gate runs a fixed window (FIXED_FROM),
 * so a train's verdict is its commit's, whatever the day; the seeds a run
 * ever found failing stay in lib/barrier-found.mjs, which the gate runs too.
 * NIMBUS_BARRIER_SEED_WINDOW=daily advances the window each UTC day instead,
 * drawing seeds no run drew before: the daily job
 * (.github/workflows/barrier-seeds.yml) runs it, and reports what it finds
 * rather than reddening a train. The window is printed, and a failing seed's
 * name says how to run it again. A seed that fails is shrunk, one child per
 * try within a budget (none with NIMBUS_BARRIER_SHRINK=0), and printed as a
 * schedule to add to lib/barrier-found.mjs; a seed that hangs is reported as
 * it is.
 */

import { runScenarios } from './lib/resident-body.mjs';
import { SCHEDULE_ENGINES as ENGINES } from './lib/guest-engines.mjs';
import { generate, KNOWN_GAPS, runSchedule } from './lib/barrier-schedule.mjs';

const realProcess = globalThis.process;
const SEEDS = Number(realProcess.env.NIMBUS_BARRIER_SEEDS ?? 24);
/** The gate's window: the one that found seed 6489, every other seed of it green. */
const FIXED_FROM = 6481;
/** The daily window: the day's, after every earlier day's (4096 days before it starts over). */
const DAY = Math.floor(Date.now() / 86_400_000) % 4096;
const FROM = Number(realProcess.env.NIMBUS_BARRIER_SEED_FROM ?? (realProcess.env.NIMBUS_BARRIER_SEED_WINDOW === 'daily' ? 1 + DAY * SEEDS : FIXED_FROM));
// Each scenario's child draws the same window, whatever the day is when it starts.
realProcess.env.NIMBUS_BARRIER_SEED_FROM = String(FROM);

const scenarios = {};
for (let seed = FROM; seed < FROM + SEEDS; seed++) {
  for (const kind of ENGINES) scenarios[`seed ${seed} [${kind}]`] = () => run(kind, generate(seed), seed);
}
// A schedule given whole, as the shrinker tries one.
scenarios.explicit = () => run(realProcess.env.NIMBUS_BARRIER_KIND, JSON.parse(realProcess.env.NIMBUS_BARRIER_SCHEDULE), Number(realProcess.env.NIMBUS_BARRIER_PARK) || undefined);

async function run(kind, schedule, parkSeed) {
  try {
    await runSchedule(kind, schedule, { parkSeed, knownGaps: KNOWN_GAPS[kind] });
  } catch (error) {
    throw new Error(`${error.message} (${kind}${parkSeed === undefined ? '' : `, parked by seed ${parkSeed}`}; its steps are above)`);
  }
}

/** Whether `schedule` fails on `kind`, in a child of its own; null when it ran out of time (a hang is not shrunk). */
function fails(kind, schedule, parkSeed) {
  const child = Bun.spawnSync({
    cmd: [realProcess.execPath, import.meta.path],
    env: {
      ...realProcess.env,
      NIMBUS_RESIDENT_BODY_SCENARIO: 'explicit',
      NIMBUS_BARRIER_KIND: kind,
      NIMBUS_BARRIER_SCHEDULE: JSON.stringify(schedule),
      NIMBUS_BARRIER_PARK: String(parkSeed ?? ''),
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  return child.exitCode === null ? null : child.exitCode !== 0;
}

/** The shortest schedule found, by dropping steps while it still fails, within `budgetMs`. */
function shrink(kind, schedule, parkSeed, budgetMs = 120_000) {
  const until = Date.now() + budgetMs;
  let best = schedule;
  for (let size = Math.ceil(best.length / 2); size >= 1 && Date.now() < until; size = Math.floor(size / 2)) {
    for (let at = 0; at + size <= best.length && Date.now() < until;) {
      const candidate = [...best.slice(0, at), ...best.slice(at + size)];
      if (fails(kind, candidate, parkSeed) === true) best = candidate;
      else at += size;
    }
  }
  return best;
}

if (realProcess.env.NIMBUS_RESIDENT_BODY_SCENARIO) {
  await runScenarios(import.meta.path, scenarios);
} else {
  realProcess.stdout.write(`seeds ${FROM}..${FROM + SEEDS - 1} (NIMBUS_BARRIER_SEED_FROM=${FROM} NIMBUS_BARRIER_SEEDS=${SEEDS} runs them again)\n`);
  const { explicit: _explicit, ...named } = scenarios;
  try {
    await runScenarios(import.meta.path, named);
  } catch (error) {
    for (const [, seed, kind] of String(error.message).matchAll(/seed (\d+) \[(\w+)\]/g)) {
      if (realProcess.env.NIMBUS_BARRIER_SHRINK === '0' || fails(kind, generate(Number(seed)), Number(seed)) !== true) continue;
      const minimal = shrink(kind, generate(Number(seed)), Number(seed));
      realProcess.stdout.write(`  seed ${seed} [${kind}] shrinks to (parked by seed ${seed}):\n    ${JSON.stringify(minimal)}\n`);
    }
    throw error;
  }
}
