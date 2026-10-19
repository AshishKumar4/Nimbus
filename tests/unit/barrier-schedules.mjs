#!/usr/bin/env bun
/**
 * barrier-schedules — a process's filesystem engine, Node's and a WASI
 * guest's, answers as the session holds its files however the session's
 * replies are timed against a peer's changes and the process's own
 * (lib/barrier-schedule.mjs says what each answer may be).
 *
 * Each schedule here is one a review found an engine wrong on, named for
 * what it shows (barrier-schedules-seeded.mjs draws them at random, and
 * prints what it finds to be added here).
 *
 * Each schedule runs in its own child (runScenarios), bounded by its steps,
 * a wall budget, and the child's own timeout.
 */

import assert from 'node:assert/strict';
import { createAuthority, facetSupervisor, launchResident, runScenarios, sleep, until } from './lib/resident-body.mjs';
import { ENGINES } from './lib/guest-engines.mjs';
import { runSchedule } from './lib/barrier-schedule.mjs';
import { scheduleTransport, supervisedFacet } from './lib/schedule-transport.mjs';

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
  'a listing whose names and stats straddle a peer\'s rename is not served': {
    engines: ['holder'],
    schedule: [['own', 'stat', 'd/e'], ['settle'], ['hold', 'listing'], ['own', 'stat', 'd/e/q'], ['settle'], ['peer', 'rename', 'd/e/g', 'd/e/g2'], ['settle'],
      ['release', 'listing'], ['settle'], ['own', 'readdir', 'd/e'], ['own', 'stat', 'd/e/g2']],
  },
  'a tree listing of a directory a peer moved away is not an empty directory': {
    engines: ['holder'],
    schedule: [['own', 'stat', 'd/e'], ['settle'], ['peer', 'rename', 'd/e', 'z'], ['settle'], ['own', 'readdir', 'd/e'], ['own', 'stat', 'd/e']],
  },
  'a directory a call that cannot wait has not listed is not refused as a directory': {
    schedule: [['own', 'stat', 'd'], ['settle'], ['sync', 'readdir', 'd'], ['sync', 'readdir', 'x']],
  },
  'a directory the process may search again shows nothing stale while it is relisted': {
    schedule: [['own', 'readdir', 'd/e'], ['own', 'stat', 'd/e/g'], ['settle'], ['root', 'chown', 'd', 0], ['root', 'chmod', 'd', 0o700], ['settle'],
      ['input'], ['settle'], ['sync', 'stat', 'd/e/g'], ['peer', 'write', 'x/h', 'while closed'], ['root', 'chmod', 'd', 0o755], ['settle'],
      ['hold', 'listing'], ['input'], ['settle'], ['sync', 'stat', 'd/e/g'], ['sync', 'readdir', 'd/e'], ['sync', 'stat', 'd/f'],
      ['release', 'listing'], ['settle'], ['sync', 'stat', 'd/e/g'], ['sync', 'readdir', 'd/e']],
  },
  'a name the process renamed into place can be renamed again at once': {
    schedule: [['own', 'rename', 'x/h', 'd/f'], ['settle'], ['sync', 'rename', 'd/f', 'd/e/g'], ['settle'], ['sync', 'stat', 'd/e/g'], ['own', 'readFile', 'd/e/g']],
  },
  'a name the process renamed stays while a later rename of its waits on the session': {
    schedule: [['sync', 'rename', 'd/e', 'x/e'], ['settle'], ['hold', 'wave'], ['sync', 'rename', 'x/h', 'd/n'], ['input'], ['settle'],
      ['sync', 'stat', 'x/e'], ['sync', 'stat', 'x/e/g'], ['sync', 'stat', 'd/n'], ['release', 'wave'], ['settle'],
      ['sync', 'stat', 'x/e'], ['sync', 'stat', 'x/e/g'], ['sync', 'stat', 'd/n'], ['input'], ['settle'], ['sync', 'stat', 'x/e/g'], ['sync', 'readdir', 'x/e']],
  },
  'a name the process renamed into place stays once the session acknowledges it after a barrier reported it': {
    schedule: [['hold', 'wave'], ['own', 'rename', 'x/h', 'd/f'], ['own', 'readFile', 'top'], ['settle'], ['release', 'wave'], ['settle'],
      ['sync', 'stat', 'd/f'], ['sync', 'rename', 'd/f', 'd/e/g'], ['settle'], ['sync', 'stat', 'd/e/g']],
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
  'a directory a call that cannot wait has not listed is not refused as a directory [holder]': {
    lacks: 'its synchronous refusal names the call: a directory is EISDIR only to a call for bytes (notResident, the cutover)',
    shows: 'answered EISDIR',
  },
  'a directory the process may search again shows nothing stale while it is relisted [node]': {
    lacks: 'B2: a relist answers what is under its directory as unknown until it lands (the cutover\'s relist fence)',
    shows: 'answered null',
  },
};

const scenarios = {};
for (const [name, { schedule, engines = ENGINES }] of Object.entries(FOUND)) {
  for (const kind of engines) scenarios[`${name} [${kind}]`] = () => run(kind, schedule);
}

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

async function run(kind, schedule) {
  try {
    await runSchedule(kind, schedule);
  } catch (error) {
    throw new Error(`${error.message} (${kind}; its steps are above)`);
  }
}

await runScenarios(import.meta.path, scenarios, { gaps: GAPS });
