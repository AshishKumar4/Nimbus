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
import { APP, SCHEDULE_ENGINES as ENGINES, bootEngine } from './guest-engines.mjs';
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
  'a relist overtaken by a later barrier restores nothing it saw': {
    // A store listed on demand relists nothing.
    engines: ['node', 'eager'],
    schedule: [['own', 'stat', 'd/e/g'], ['settle'], ['root', 'chown', 'd', 0], ['root', 'chmod', 'd', 0o700], ['settle'], ['input'], ['settle'],
      ['root', 'chmod', 'd', 0o755], ['settle'], ['hold', 'listing'], ['input'], ['settle'],
      ['peer', 'unlink', 'd/e/g'], ['peer', 'write', 'd/f', 'f rewritten'], ['settle'], ['input'], ['settle'], ['release', 'listing'], ['settle'],
      ['sync', 'stat', 'd/e/g'], ['sync', 'stat', 'd/f'], ['sync', 'readdir', 'd/e'], ['own', 'stat', 'd/e/g']],
  },
  'a refetch a later rewrite overtook is replaced before the barriers land': {
    schedule: [['own', 'readFile', 'top'], ['settle'], ['peer', 'write', 'top', 'second!'], ['settle'], ['hold', 'lookup'], ['input'], ['settle'],
      ['peer', 'write', 'top', 'third!!!'], ['settle'], ['input'], ['settle'], ['release', 'lookup'], ['settle'], ['sync', 'readFile', 'top']],
  },
  // The 320-seed sweep's findings (seeds 1000-1319), shrunk.
  'a write beside a directory read through its descriptor is not refused while the batch is out': {
    engines: ['holder'], park: 1008,
    schedule: [['own', 'mkdir', 'x/e'], ['hold', 'listing'], ['own', 'opendir', 'x/e'], ['root', 'chown', 'd', 0], ['own', 'write', 'x/f', 'c1008.1']],
  },
  'a write in a directory read through its descriptor reaches the session': {
    engines: ['holder'], park: 1298,
    schedule: [['own', 'stat', 'x/h'], ['own', 'readFile', 'top'], ['own', 'opendir', 'd'], ['root', 'chown', 'x', 1000], ['sync', 'write', 'd/n', 'c1298.2']],
  },
  'a peer\'s change beside the process\'s own, after its read lease, is not refused (1230)': {
    engines: ['eager'], park: 1230,
    schedule: [['input'], ['own', 'write', 'new', 'c1230.1'], ['release'], ['input'], ['release'], ['peer', 'write', 'top', 'c1230.2'], ['sync', 'chmod', 'd/e', 448]],
  },
  'a peer\'s change beside the process\'s own, after its read lease, is not refused (1237)': {
    engines: ['eager'], park: 1237,
    schedule: [['input'], ['own', 'write', 'top', 'c1237.2'], ['own', 'write', 'd/n', 'c1237.3'], ['release'], ['sync', 'chmod', 'd/e/g', 420],
      ['own', 'write', 'd/f', 'c1237.5'], ['root', 'chown', 'x', 0], ['release']],
  },
  'a file the process renamed is not shown at its name once a peer moved it away': {
    engines: ['node'], park: 1006,
    schedule: [['own', 'write', 'd/f', 'c1006.5'], ['own', 'rename', 'd/f', 'new'], ['peer', 'rename', 'new', 'x/f']],
  },
  'a file the process removed stays removed across a poison (1198)': {
    engines: ['node'], park: 1198,
    schedule: [['own', 'chmod', 'd/e/g', 420], ['poison'], ['own', 'write', 'd/f', 'c1198.6'], ['own', 'readdir', 'd/f'], ['own', 'unlink', 'top']],
  },
  'a file the process removed stays removed across a poison (1294)': {
    engines: ['node'], park: 1294,
    schedule: [['own', 'rename', 'd/e', 'x/e'], ['own', 'unlink', 'd/f'], ['poison'], ['own', 'opendir', 'new']],
  },
  // The client sends one wave at a time: a refused one goes again, first, before what was written after it.
  'two writes of one file, the first refused while a peer recalls the read lease, land in order': {
    engines: ['holder'], park: 1298,
    schedule: [['own', 'stat', 'x/h'], ['own', 'readFile', 'top'], ['own', 'opendir', 'd'], ['root', 'chown', 'x', 1000],
      ['sync', 'write', 'd/n', 'first'], ['sync', 'write', 'd/n', 'second!']],
  },
  // The session's database started a new incarnation (rotateIncarnation): every cursor poisons; its files stay.
  'what a process held is held across a new incarnation of the session\'s database': {
    engines: ['holder', 'eager'],
    schedule: [['own', 'readFile', 'top'], ['own', 'readFile', 'd/f'], ['settle'], ['restart'], ['input'], ['settle'],
      ['sync', 'readFile', 'top'], ['sync', 'stat', 'd/f'], ['own', 'readFile', 'd/f']],
  },
  // The sweep of seeds 2000-2319 (with restarts), shrunk.
  'an awaited read of a file a relist is on its way to is answered, not refused': {
    engines: ['node'], park: 2209,
    schedule: [['release'], ['root', 'chmod', 'd', 493], ['own', 'readFile', 'mid'], ['sync', 'stat', 'd'], ['input'], ['input'], ['root', 'chmod', 'd/e', 448],
      ['hold', 'listing'], ['root', 'chmod', 'd', 488], ['own', 'pread', 'mid', 0], ['settle'], ['peer', 'rename', 'd/e', 'x/e'], ['sync', 'write', 'x/e/g', 'c2209.1'],
      ['root', 'chmod', 'x/e', 457], ['sync', 'chmod', 'x/h', 420], ['sync', 'stat', 'z/k'], ['own', 'readFile', 'd/e/g'], ['settle']],
  },
  'a barrier asked in the last epoch, answered after the store started again in the next, installs nothing (2154)': {
    engines: ['holder', 'eager'], park: 2154,
    schedule: [['own', 'write', 'top', 'c2154.1'], ['input'], ['input'], ['own', 'write', 'new', 'c2154.2'], ['release'], ['release', 'lookup'],
      ['hold', 'listing'], ['release'], ['own', 'stat', 'z'], ['release'], ['release'], ['input'], ['restart'], ['input'], ['input'], ['own', 'stat', 'z/k']],
  },
  'a directory read through its descriptor after an own rename into it, its wave not yet sent, lists the name the rename made (2896)': {
    schedule: [['stall'], ['sync', 'rename', 'd/e/g', 'x/f'], ['own', 'opendir', 'x']],
  },
  'a file the process wrote and then removed, both answered in one wave behind an input, is gone from its listing (2700)': {
    engines: ['node'], park: 2700,
    schedule: [
      ['release', 'wave'], ['release', 'acquire'], ['release'], ['own', 'stat', 'z'], ['sync', 'mkdir', 'x/e'], ['sync', 'rmdir', 'x/e'], ['release'],
      ['hold', 'listing'], ['own', 'stat', 'x/h'], ['own', 'stat', 'x'], ['release'], ['hold', 'lookup'], ['sync', 'readdir', 'new'],
      ['own', 'write', 'd/e/g', 'c2700.3'], ['input'], ['input'], ['sync', 'chmod', 'd', 448], ['own', 'pread', 'mid', 70000], ['settle'],
      ['hold', 'wave'], ['own', 'readFile', 'x'], ['sync', 'readFile', 'd/e/g'], ['sync', 'readdir', 'x/f'], ['own', 'opendir', 'd/e'],
      ['own', 'opendir', 'd/n'], ['release', 'listing'], ['release', 'acquire'], ['sync', 'stat', 'x/f'], ['root', 'chmod', 'd', 457],
      ['sync', 'stat', 'd/e'], ['own', 'pread', 'mid', 8400000], ['input'], ['settle'], ['release'], ['own', 'write', 'top', 'c2700.4'], ['release'],
      ['input'], ['sync', 'stat', 'z/k'], ['sync', 'unlink', 'top'], ['peer', 'chmod', 'd', 488]
    ],
  },
  'a miss of a file the process may no longer reach is not owed (6404)': {
    engines: ['node'], park: 6404,
    schedule: [['hold', 'wave'], ['sync', 'stat', 'z/k'], ['own', 'readFile', 'd/e'], ['own', 'readFile', 'mid'], ['own', 'readFile', 'x/h'], ['own', 'unlink', 'd/e/g'],
      ['hold', 'delivery'], ['restart'], ['own', 'rename', 'x/h', 'd/e/g'], ['sync', 'readdir', 'x/h'], ['stall'], ['root', 'chmod', 'd/e', 488], ['release', 'lookup'],
      ['release'], ['peer', 'chmod', 'd/e/g', 416], ['own', 'opendir', 'z'], ['sync', 'readFile', 'd/e/g'], ['root', 'chown', 'd/e', 0], ['sync', 'readFile', 'd/e/g'],
      ['release'], ['hold', 'lookup']],
  },
  'a directory the process renamed away and a peer made again holds none of what it held (3378)': {
    engines: ['node'], park: 3378,
    schedule: [['own', 'readFile', 'z/g'], ['own', 'opendir', 'd/e/g'], ['input'], ['own', 'readdir', 'z/k'], ['own', 'rename', 'd', 'z'], ['own', 'opendir', 'd/e/g'],
      ['input'], ['peer', 'mkdir', 'd'], ['own', 'chmod', 'x/h', 420], ['own', 'pread', 'mid', 8400000], ['release', 'wave'], ['peer', 'unlink', 'top'],
      ['own', 'stat', 'new'], ['sync', 'readdir', 'z/k'], ['own', 'stat', 'z/g'], ['hold', 'acquire'], ['settle'], ['sync', 'stat', 'd/e/g']],
  },
  'a file renamed over another, its rename on its way, reads as the renamed file (3104)': {
    schedule: [['own', 'rename', 'd/e/g', 'top'], ['sync', 'readFile', 'top']],
  },
  'a file the process renamed into place reads as a peer later wrote it (3219)': {
    schedule: [['own', 'write', 'new', 'c3219.3'], ['own', 'rename', 'new', 'top'], ['peer', 'write', 'top', 'c3219.5']],
  },
  'a file renamed over another, its rename answered, reads as the renamed file (3104, awaited)': {
    // A WASI guest's awaited rename outside a grant shows to its next call that cannot wait only after a barrier (O9).
    engines: ['node'],
    schedule: [['own', 'rename', 'd/e/g', 'top'], ['settle'], ['sync', 'readFile', 'top'], ['sync', 'stat', 'top']],
  },
  'a file renamed over another in a subtree the process holds, its rename answered, reads as the renamed file (3104, held)': {
    engines: ['node'],
    schedule: [['own', 'write', 'x/f', 'a1'], ['settle'], ['own', 'write', 'x/f', 'a2'], ['settle'], ['own', 'write', 'x/f', 'a3'], ['settle'],
      ['own', 'write', 'x/f', 'a4'], ['settle'], ['own', 'write', 'x/f', 'a5'], ['settle'], ['own', 'write', 'x/f', 'a6'], ['settle'],
      ['own', 'write', 'x/f', 'saved'], ['settle'], ['own', 'rename', 'x/f', 'x/h'], ['settle'], ['sync', 'readFile', 'x/h'], ['sync', 'stat', 'x/h']],
  },
  'a file the process read whole stays resident across an input after a read of a file fetched in batches (4225)': {
    park: 4225,
    schedule: [['input'], ['own', 'mkdir', 'x/e'], ['release', 'listing'], ['own', 'readFile', 'd/e/g'], ['own', 'readFile', 'mid'], ['sync', 'stat', 'x'],
      ['own', 'unlink', 'top'], ['input'], ['sync', 'readFile', 'z'], ['release'], ['unstall'], ['sync', 'readFile', 'd/e/g'], ['peer', 'write', 'top', 'c4225.6']],
  },
  'a file fetched in batches that the process read stays resident past a repair (4033)': {
    park: 4033,
    schedule: [['poison'], ['own', 'stat', 'x'], ['sync', 'readdir', 'd/e'], ['own', 'readFile', 'mid'], ['sync', 'readFile', 'x/e/g'], ['release', 'listing'],
      ['peer', 'write', 'top', 'c4033.2'], ['release', 'wave'], ['input'], ['release'], ['sync', 'readFile', 'z'], ['sync', 'write', 'x/f', 'c4033.3'],
      ['sync', 'readFile', 'mid'], ['sync', 'rename', 'd/f', 'x/e/g'], ['release', 'acquire'], ['sync', 'readdir', 'd/e']],
  },
  'a file a call that cannot wait missed stays a miss until an awaited read answers it': {
    engines: ['node'],
    schedule: [['peer', 'write', 'new', 'not resident'], ['settle'], ['input'], ['settle'], ['sync', 'readFile', 'new'], ['own', 'stat', 'new'], ['settle']],
  },
};

/** Known gaps, by scenario: what the engine lacks, and what its failure shows. */
const GAPS = {
  'a file the process renamed into place reads as a peer later wrote it (3219) [node]': {
    lacks: 'S dates a moved file\'s bytes only by a write parked under its old name: bytes held otherwise (read, or written and already sent) stay its own at the new name past every barrier, as no rename has a receipt to date them by (closed by the cutover: RF retires own state by identity); '
      + 'meanwhile, in a program that renames a file it had read (or written and already sent), then another process overwrites it, readFileSync keeps serving the program\'s own bytes',
    shows: 'at rest, sync readFile top answered "c3219.3"',
  },
  'an awaited read of a file a relist is on its way to is answered, not refused [node]': {
    lacks: 'B2: node-shims refuses an awaited read under a directory its relist is on its way to (EAGAIN), where it should wait (the cutover\'s relist fence); '
      + 'meanwhile fs.promises.readFile of such a file can reject EAGAIN',
    shows: 'own readFile d/e/g answered EAGAIN',
  },
  'a file the process wrote and then removed, both answered in one wave behind an input, is gone from its listing (2700) [node]': {
    lacks: 'S: what a write\'s answer installs outlives the removal the same wave carried, past every barrier since (closed by the cutover: one own state, RF\'s); '
      + 'meanwhile a Node program\'s readdirSync can list a file it deleted with unlinkSync, which the session no longer holds',
    shows: 'at rest, sync readdir . answered',
  },
  'a directory the process renamed away and a peer made again holds none of what it held (3378) [node]': {
    lacks: 'S keeps a rename of a directory as its own effect over the rows the launch listed under the old name, and leaves those rows; once a peer makes the name again they show under it (closed by the cutover: RF decides own renames in the store); '
      + 'meanwhile, in a program that renames a directory away and another process then creates one of that name, statSync and readFileSync can answer files the old directory held',
    shows: 'sync stat d/e/g answered file 644 size 5',
  },
  'a directory the process may search again shows nothing stale while it is relisted [node]': {
    lacks: 'B2: a relist answers what is under its directory as unknown until it lands (the cutover\'s relist fence); '
      + 'meanwhile a call that cannot wait sees a false ENOENT for a name the session holds there',
    shows: 'answered null',
  },
};

const scenarios = {};
for (const [name, { schedule, engines = ENGINES, park }] of Object.entries(FOUND)) {
  for (const kind of engines) scenarios[`${name} [${kind}]`] = () => run(kind, schedule, park);
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

/** `park`: the seed a drawn schedule parked its replies by (its other replies at random, as drawn). */
async function run(kind, schedule, park) {
  try {
    await runSchedule(kind, schedule, { parkSeed: park });
  } catch (error) {
    throw new Error(`${error.message} (${kind}${park === undefined ? '' : `, parked by seed ${park}`}; its steps are above)`);
  }
}

/** What the process renamed itself: Node's own renames, run apart so each file stays in the fast tier. */
const OWN_RENAMES = new Set([
  'a file renamed over another, its rename answered, reads as the renamed file (3104, awaited)',
  'a file renamed over another in a subtree the process holds, its rename answered, reads as the renamed file (3104, held)',
  'a file renamed over another, its rename on its way, reads as the renamed file (3104)',
  'a directory the process renamed away and a peer made again holds none of what it held (3378)',
  'a file the process renamed into place reads as a peer later wrote it (3219)',
  'a miss of a file the process may no longer reach is not owed (6404)',
  'a file the process wrote and then removed, both answered in one wave behind an input, is gone from its listing (2700)',
  'a directory read through its descriptor after an own rename into it, its wave not yet sent, lists the name the rename made (2896)',
  'an awaited read of a file a relist is on its way to is answered, not refused',
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
