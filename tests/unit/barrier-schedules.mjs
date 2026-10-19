#!/usr/bin/env bun
/**
 * barrier-schedules — a process's filesystem engine, Node's and a WASI
 * guest's, answers as the session holds its files however the session's
 * replies are timed against a peer's changes and the process's own
 * (lib/barrier-schedule.mjs says what each answer may be).
 *
 * FOUND: each schedule a review found an engine wrong on, named for what
 * it shows. Seeds: schedules drawn from a seed, each reply parked at random;
 * NIMBUS_BARRIER_SEEDS=n runs n of them on each engine. A seed that fails is
 * shrunk (one child per try) and printed as a schedule to add to FOUND.
 *
 * Each schedule runs in its own child (runScenarios), bounded by its steps,
 * a wall budget, and the child's own timeout.
 */

import assert from 'node:assert/strict';
import { createAuthority, facetSupervisor, launchResident, runScenarios, sleep, until } from './lib/resident-body.mjs';
import { ENGINES } from './lib/guest-engines.mjs';
import { generate, runSchedule } from './lib/barrier-schedule.mjs';
import { scheduleTransport, supervisedFacet } from './lib/schedule-transport.mjs';

const realProcess = globalThis.process;
const SEEDS = Number(realProcess.env.NIMBUS_BARRIER_SEEDS ?? 6);

/** `engines`: where it applies (both, unless named). */
const FOUND = {
  'a lookup asked before a peer removed the file never brings it back': {
    engines: ['holder'],
    schedule: [['own', 'stat', 'd'], ['settle'], ['hold', 'lookup'], ['own', 'stat', 'd/f'], ['peer', 'unlink', 'd/f'], ['settle'],
      ['input'], ['settle'], ['release', 'lookup'], ['settle'], ['sync', 'stat', 'd/f'], ['own', 'stat', 'd/f']],
  },
  'a listing asked before a peer removed a file never brings it back': {
    schedule: [['own', 'stat', 'd'], ['settle'], ['hold', 'listing'], ['own', 'readdir', 'd'], ['peer', 'unlink', 'd/f'], ['settle'],
      ['input'], ['settle'], ['release', 'listing'], ['settle'], ['sync', 'stat', 'd/f'], ['sync', 'readdir', 'd'], ['own', 'stat', 'd/f']],
  },
  'a lookup never stands in for the file a peer renamed onto its name': {
    engines: ['holder'],
    schedule: [['own', 'stat', 'd'], ['settle'], ['hold', 'lookup'], ['own', 'stat', 'd/f'], ['peer', 'rename', 'x/h', 'd/f'], ['settle'],
      ['input'], ['settle'], ['release', 'lookup'], ['settle'], ['sync', 'stat', 'd/f'], ['own', 'stat', 'd/f']],
  },
  'a name learned under a directory a peer replaced is gone after the barrier': {
    schedule: [['own', 'stat', 'd/f'], ['settle'], ['peer', 'rename', 'd', 'z'], ['settle'], ['peer', 'rename', 'x', 'd'], ['settle'],
      ['input'], ['settle'], ['sync', 'stat', 'd/f'], ['sync', 'stat', 'd/h'], ['own', 'stat', 'd/f']],
  },
  'a lookup asked before a poison installs nothing': {
    engines: ['holder'],
    schedule: [['own', 'stat', 'd'], ['settle'], ['hold', 'lookup'], ['own', 'stat', 'd/f'], ['peer', 'unlink', 'd/f'], ['settle'],
      ['poison'], ['input'], ['settle'], ['release', 'lookup'], ['settle'], ['sync', 'stat', 'd/f'], ['own', 'stat', 'd/f']],
  },
  'an awaited chmod outside a grant is what the next call that cannot wait reads': {
    schedule: [['own', 'stat', 'top'], ['settle'], ['own', 'chmod', 'top', 0o600], ['settle'], ['sync', 'stat', 'top']],
  },
  'a change the process made between a delivery\'s ask and its landing stays shown': {
    schedule: [['own', 'stat', 'top'], ['settle'], ['hold', 'delivery'], ['hold', 'acquire'], ['input'], ['own', 'chmod', 'top', 0o600], ['settle'],
      ['release'], ['release'], ['settle'], ['sync', 'stat', 'top']],
  },
  'two barriers in flight while a peer rewrites a file the process read': {
    schedule: [['own', 'readFile', 'top'], ['settle'], ['hold', 'acquire'], ['input'], ['peer', 'write', 'top', 'rewritten once'], ['settle'],
      ['input'], ['peer', 'write', 'top', 'rewritten twice!'], ['settle'], ['release', 'acquire'], ['settle'], ['sync', 'readFile', 'top'], ['own', 'readFile', 'top']],
  },
  'a file a call that cannot wait missed stays a miss until an awaited read answers it': {
    engines: ['node'],
    schedule: [['peer', 'write', 'new', 'not resident'], ['settle'], ['input'], ['settle'], ['sync', 'readFile', 'new'], ['own', 'stat', 'new'], ['settle']],
  },
};

/** Known gaps, by scenario: what the engine lacks, and what its failure shows. */
const GAPS = {
  'an awaited chmod outside a grant is what the next call that cannot wait reads [holder]': {
    lacks: 'O9: an awaited mutation outside a grant is decided by the provisional decisions (the cutover)',
    shows: 'sync stat top answered file 644',
  },
};

const scenarios = {};
for (const [name, { schedule, engines = ENGINES }] of Object.entries(FOUND)) {
  for (const kind of engines) scenarios[`${name} [${kind}]`] = () => run(kind, schedule);
}
for (let seed = 1; seed <= SEEDS; seed++) {
  for (const kind of ENGINES) scenarios[`seed ${seed} [${kind}]`] = () => run(kind, generate(seed), seed);
}
// A schedule given whole, as the shrinker tries one.
scenarios.explicit = () => run(realProcess.env.NIMBUS_BARRIER_KIND, JSON.parse(realProcess.env.NIMBUS_BARRIER_SCHEDULE), Number(realProcess.env.NIMBUS_BARRIER_PARK) || undefined);

scenarios['a floating awaited read finishes before a one-shot exits [node]'] = async () => {
  const authority = createAuthority(undefined, { sequenced: true });
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile('home/user/app/cold.txt', 'cold bytes');
  // The read's own barrier and read, one call, parked: nothing else keeps the process up.
  const transport = scheduleTransport({ park: (_kind, name) => name === 'fsAcquired' });
  const handle = supervisedFacet(facetSupervisor, authority, transport);
  await launchResident({
    authority,
    program: '(async () => { console.log(await require("fs").promises.readFile("/home/user/app/cold.txt", "utf8")); })();',
    env: { SUPERVISOR: handle.supervisor },
    cursor: authority.cursor(),
  });
  await until(() => transport.parked().length > 0, 'the read asked');
  await sleep(300);
  assert.equal(handle.log.exit, null, 'the process waits for its read');
  transport.drain();
  await until(() => handle.log.exit !== null, 'the process exits', 10_000);
  assert.equal(handle.log.stdout, 'cold bytes\n');
  assert.equal(handle.log.exit.code, 0);
};

async function run(kind, schedule, parkSeed) {
  const trace = [];
  try {
    await runSchedule(kind, schedule, { parkSeed, trace });
  } catch (error) {
    throw new Error(`${error.message}\n  schedule (${kind}${parkSeed === undefined ? '' : `, parked by seed ${parkSeed}`}):\n${trace.map((line) => `    ${line}`).join('\n')}`);
  }
}

/** Whether `schedule` fails on `kind`, in a child of its own. */
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
    timeout: 60_000,
  });
  return child.exitCode !== 0;
}

/** The shortest schedule found, by dropping steps while it still fails (at most `tries` children). */
function shrink(kind, schedule, parkSeed, tries = 40) {
  let best = schedule;
  for (let size = Math.ceil(best.length / 2); size >= 1 && tries > 0; size = Math.floor(size / 2)) {
    for (let at = 0; at + size <= best.length && tries > 0;) {
      const candidate = [...best.slice(0, at), ...best.slice(at + size)];
      tries--;
      if (fails(kind, candidate, parkSeed)) best = candidate;
      else at += size;
    }
  }
  return best;
}

if (realProcess.env.NIMBUS_RESIDENT_BODY_SCENARIO) {
  await runScenarios(import.meta.path, scenarios);
} else {
  const { explicit: _explicit, ...named } = scenarios;
  try {
    await runScenarios(import.meta.path, named, { gaps: GAPS });
  } catch (error) {
    for (const [, seed, kind] of String(error.message).matchAll(/seed (\d+) \[(\w+)\]/g)) {
      const minimal = shrink(kind, generate(Number(seed)), Number(seed));
      realProcess.stdout.write(`  seed ${seed} [${kind}] shrinks to (parked by seed ${seed}):\n    ${JSON.stringify(minimal)}\n`);
    }
    throw error;
  }
}
