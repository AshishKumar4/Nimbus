/**
 * The barrier schedules a review found an engine wrong on, each named for
 * what it shows, and what each engine is known to lack (its gaps): run per
 * engine by barrier-schedules-node.mjs and barrier-schedules-holder.mjs,
 * each schedule in its own child (runScenarios), bounded by its steps, a
 * wall budget, and the child's own timeout. barrier-schedules-seeded.mjs
 * draws schedules at random, and prints what it finds to be added here.
 *
 * Directory note: under tests/unit/lib/ so the suite does not run it as a test.
 */

import assert from 'node:assert/strict';
import { createAuthority, facetSupervisor, launchResident, sleep, until } from './resident-body.mjs';
import { APP, ENGINES, bootEngine } from './guest-engines.mjs';
import { runSchedule } from './barrier-schedule.mjs';
import { scheduleTransport, supervisedFacet } from './schedule-transport.mjs';

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
  'a file renamed in a directory then renamed with it shows at its last name while the first rename lands alone': {
    engines: ['node'],
    schedule: [['own', 'stat', 'd/f'], ['settle'], ['hold', 'wave'], ['own', 'rename', 'd/f', 'd/n'], ['settle'], ['stall'], ['own', 'rename', 'd', 'z'],
      ['input'], ['settle'], ['sync', 'stat', 'z/n'], ['sync', 'stat', 'd/n'], ['unstall'], ['release', 'wave'], ['settle'], ['sync', 'stat', 'z/n']],
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
    lacks: 'B2: a relist answers what is under its directory as unknown until it lands (the cutover\'s relist fence); '
      + 'meanwhile a call that cannot wait sees a false ENOENT for a name the session holds there',
    shows: 'answered null',
  },
};

const scenarios = {};
for (const [name, { schedule, engines = ENGINES }] of Object.entries(FOUND)) {
  for (const kind of engines) scenarios[`${name} [${kind}]`] = () => run(kind, schedule);
}

// A WASI guest makes one call at a time: a second rename before the first returned is Node's (and RF's, once Node runs on it).
for (const kind of ['node']) {
  scenarios[`a chain of renames whose first lands alone keeps the moved file at its last name [${kind}]`] = async () => {
    const transport = scheduleTransport();
    const engine = await bootEngine(kind, {
      seed: (authority) => {
        authority.kfs.mkdir('home/user/app/x', { mode: 0o755 });
        authority.kfs.writeFile('home/user/app/x/h', 'moved');
        authority.kfs.writeFile('home/user/app/top', 'replaced');
      },
      supervise: transport.supervise,
      stdin: kind === 'node',
    });
    const moved = (await engine.stat(`${APP}/x/h`)).ino;
    // The first rename reaches the session and its answer waits; the second does not reach it.
    transport.hold('wave');
    const first = engine.fs.rename(`${APP}/x/h`, `${APP}/mid`);
    await until(() => transport.parked().length > 0, 'the first rename sent');
    engine.stall();
    const second = engine.fs.rename(`${APP}/mid`, `${APP}/top`);
    await sleep(50);
    await engine.input();
    const seen = (() => { try { return engine.sync.stat(`${APP}/top`); } catch (error) { return error?.code; } })();
    assert.ok(Number(seen?.ino) === moved, `the last name, once a barrier landed the first rename alone: ${JSON.stringify(seen)}`);
    await engine.release();
    transport.drain();
    await Promise.all([first, second]);
    assert.equal((await engine.stat(`${APP}/top`)).ino, moved, 'the last name, once both landed');
    assert.equal(await engine.stat(`${APP}/mid`), null);
  };
}

for (const kind of ['node']) {
  scenarios[`a file renamed in a directory then renamed with it is found once the first rename lands alone [${kind}]`] = async () => {
    const transport = scheduleTransport();
    const engine = await bootEngine(kind, {
      seed: (authority) => {
        authority.kfs.mkdir('home/user/app/d', { mode: 0o755 });
        authority.kfs.writeFile('home/user/app/d/f', 'moved');
      },
      supervise: transport.supervise,
      stdin: kind === 'node',
    });
    const moved = (await engine.stat(`${APP}/d/f`)).ino;
    // The file's rename reaches the session and its answer waits; its directory's does not reach it.
    transport.hold('wave');
    const first = engine.fs.rename(`${APP}/d/f`, `${APP}/d/n`);
    await until(() => transport.parked().length > 0, 'the file\'s rename sent');
    engine.stall();
    const second = engine.fs.rename(`${APP}/d`, `${APP}/x`);
    await sleep(50);
    await engine.input();
    const seen = (() => { try { return engine.sync.stat(`${APP}/x/n`); } catch (error) { return error?.code; } })();
    assert.ok(Number(seen?.ino) === moved, `the file under its directory's new name, once a barrier landed its own rename alone: ${JSON.stringify(seen)}`);
    await engine.release();
    transport.drain();
    await Promise.all([first, second]);
    assert.equal((await engine.stat(`${APP}/x/n`)).ino, moved, 'once both landed');
  };
}

for (const kind of ['node']) {
  scenarios[`a dangling link renamed in a directory then renamed with it is found once the first rename lands alone [${kind}]`] = async () => {
    const transport = scheduleTransport();
    const engine = await bootEngine(kind, {
      seed: (authority) => {
        authority.kfs.mkdir('home/user/app/d', { mode: 0o755 });
        authority.kfs.symlink('nowhere', 'home/user/app/d/l');
      },
      supervise: transport.supervise,
      stdin: kind === 'node',
    });
    const moved = (await engine.stat(`${APP}/d/l`, { followSymlinks: false })).ino;
    // The link's rename reaches the session and its answer waits; its directory's does not reach it.
    transport.hold('wave');
    const first = engine.fs.rename(`${APP}/d/l`, `${APP}/d/m`);
    await until(() => transport.parked().length > 0, 'the link\'s rename sent');
    engine.stall();
    const second = engine.fs.rename(`${APP}/d`, `${APP}/x`);
    await sleep(50);
    await engine.input();
    const seen = (() => { try { return engine.sync.stat(`${APP}/x/m`, { followSymlinks: false }); } catch (error) { return error?.code; } })();
    assert.ok(Number(seen?.ino) === moved && (seen.isSymbolicLink?.() ?? seen.type === 'symlink'), `the link under its directory's new name, once a barrier landed its own rename alone: ${JSON.stringify(seen)}`);
    await engine.release();
    transport.drain();
    await Promise.all([first, second]);
    assert.equal((await engine.stat(`${APP}/x/m`, { followSymlinks: false })).ino, moved, 'once both landed');
  };
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

/** What the process renamed itself: Node's own renames, run apart so each file stays in the fast tier. */
const OWN_RENAMES = new Set([
  'a name the process renamed into place can be renamed again at once',
  'a name the process renamed stays while a later rename of its waits on the session',
  'a name the process renamed into place stays once the session acknowledges it after a barrier reported it',
  'a file renamed in a directory then renamed with it shows at its last name while the first rename lands alone',
  'a chain of renames whose first lands alone keeps the moved file at its last name',
  'a file renamed in a directory then renamed with it is found once the first rename lands alone',
  'a dangling link renamed in a directory then renamed with it is found once the first rename lands alone',
]);

/**
 * The scenarios and gaps of engine `kind`: all, or only (`renames` true) or but (false) the process's own renames.
 * @param {string} kind
 * @param {{ renames?: boolean }} [options]
 */
export function foundScenarios(kind, { renames } = {}) {
  const suffix = ` [${kind}]`;
  const chosen = (name) => name.endsWith(suffix) && (renames === undefined || OWN_RENAMES.has(name.slice(0, -suffix.length)) === renames);
  return {
    scenarios: Object.fromEntries(Object.entries(scenarios).filter(([name]) => chosen(name))),
    gaps: Object.fromEntries(Object.entries(GAPS).filter(([name]) => chosen(name))),
  };
}
