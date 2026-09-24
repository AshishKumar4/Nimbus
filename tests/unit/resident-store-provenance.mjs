#!/usr/bin/env bun
// Every row the resident store serves must be one the ACQUIRE barrier can
// evict, and -1 (__RK_OWN_WRITE) is the one revision it never evicts. So -1
// has to mean exactly "this process's own bytes that the authority has not
// acknowledged yet", and every other row has to carry the revision the
// authority assigned it:
//
//   - an own write, once its flush returns the revision it produced;
//   - bytes a live read fetched, at the cursor the read was issued under;
//   - an own ranged write, once its receipt settles.
//
// A row left at -1 after any of those is never evicted again: a peer's
// rewrite of the path is invisible to every later synchronous read, for the
// life of the process. Each scenario below drives the REAL resident body
// (tests/unit/lib/resident-body.mjs) and ends on a peer's change that a
// barriered resumption must see.

import assert from 'node:assert/strict';
import { _rpcFsReadBatch } from '../../packages/worker/src/session/rpc.ts';
import {
  coherenceStats,
  createAuthority,
  facetSupervisor,
  launchResident,
  runScenarios,
} from './lib/resident-body.mjs';

const APP = '/home/user/app';

const PROGRAM = `
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "ERR:" + e.code; } };
globalThis.__probe = {
  read,
  write: (p, s) => fs.writeFileSync(p, s),
  readAsync: (p) => fs.promises.readFile(p, "utf8"),
  // A resumption the program did not ask the filesystem for: the callback runs
  // behind the shim's barrier, then reads synchronously.
  resume: (p) => new Promise((resolve) => setTimeout(() => resolve(read(p)), 0)),
  settle: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  overwriteAt: async (p, text, at) => {
    const handle = await fs.promises.open(p, "r+");
    try { await handle.write(text, at); } finally { await handle.close(); }
  },
};
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

/** A session holding `files`, and the resident process booted over it. */
async function boot(files = {}, overrides = () => ({})) {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  for (const [path, text] of Object.entries(files)) {
    authority.kfs.writeFile(`home/user/app/${path}`, text, { mode: 0o644 });
  }
  const { supervisor, log } = facetSupervisor(authority, overrides(authority));
  await launchResident({
    program: PROGRAM,
    env: { SUPERVISOR: supervisor },
    cursor: authority.cursor(),
  });
  return { authority, log, probe: globalThis.__probe };
}

await runScenarios(import.meta.path, {
  async 'own write, flushed, then rewritten by a peer'() {
    const { authority, probe } = await boot();
    probe.write(`${APP}/own.txt`, 'MINE');
    assert.equal(probe.read(`${APP}/own.txt`), 'MINE', 'read-your-writes');
    await probe.settle(50);
    assert.equal(authority.read('home/user/app/own.txt'), 'MINE', 'the write-back reached the authority');

    const fills = coherenceStats().fills;
    assert.equal(await probe.resume(`${APP}/own.txt`), 'MINE', 'its own write survives the barrier that reports it');
    assert.equal(coherenceStats().fills, fills, 'and is not refetched: the report is its own write coming back');

    authority.kfs.writeFile('home/user/app/own.txt', 'PEER');
    assert.equal(
      await probe.resume(`${APP}/own.txt`),
      'PEER',
      "a peer's rewrite of a file this process wrote must be seen at the next resumption",
    );
  },

  async 'bytes an async read filled, then changed by a peer'() {
    const { authority, probe } = await boot();
    // Created after the boot fill, so only the async read below can put it in the store.
    authority.kfs.writeFile('home/user/app/late.txt', 'L1');
    assert.equal(await probe.readAsync(`${APP}/late.txt`), 'L1');
    assert.equal(probe.read(`${APP}/late.txt`), 'L1', 'the async read wrote through to the store');

    authority.kfs.writeFile('home/user/app/late.txt', 'L2');
    assert.equal(await probe.resume(`${APP}/late.txt`), 'L2', 'the filled row is dated, so the change evicts it');
  },

  async 'a refetched row, changed again'() {
    const { authority, probe } = await boot({ 'boot.txt': 'B1' });
    assert.equal(probe.read(`${APP}/boot.txt`), 'B1');
    authority.kfs.writeFile('home/user/app/boot.txt', 'B2');
    assert.equal(await probe.resume(`${APP}/boot.txt`), 'B2', 'the boot fill dated the row, so the first change is seen');
    authority.kfs.writeFile('home/user/app/boot.txt', 'B3');
    assert.equal(
      await probe.resume(`${APP}/boot.txt`),
      'B3',
      'and so is the second: the barrier\'s refetch must date the row it installs',
    );
  },

  async 'own ranged write, then rewritten by a peer'() {
    const { authority, probe } = await boot({ 'fd.txt': 'abcdef' });
    await probe.overwriteAt(`${APP}/fd.txt`, 'XY', 0);
    assert.equal(probe.read(`${APP}/fd.txt`), 'XYcdef', 'the ranged write is overlaid on the held row');
    assert.equal(authority.read('home/user/app/fd.txt'), 'XYcdef');

    const fills = coherenceStats().fills;
    assert.equal(await probe.resume(`${APP}/fd.txt`), 'XYcdef', 'and survives the barrier that reports it');
    assert.equal(coherenceStats().fills, fills, 'without a refetch: its receipt dated the row');

    authority.kfs.writeFile('home/user/app/fd.txt', 'PEER');
    assert.equal(await probe.resume(`${APP}/fd.txt`), 'PEER');
  },

  async 'a peer write that lands while the own write is in flight'() {
    // The authority applies the write at once and the response is held, the
    // way a Durable Object's output gate holds it. A barrier inside that window
    // reports the path while the row is still this process's own, so it must
    // keep the row; the flush's revision then decides whose report it was.
    const held = heldWriteFile();
    const { authority, probe } = await boot({}, held.overrides);

    probe.write(`${APP}/race.txt`, 'MINE');
    await held.wrote;
    authority.kfs.writeFile('home/user/app/race.txt', 'PEER');
    assert.equal(
      await probe.resume(`${APP}/race.txt`),
      'MINE',
      'an unacknowledged own write still reads as the process wrote it',
    );

    held.release();
    await probe.settle(20);
    assert.equal(
      await probe.resume(`${APP}/race.txt`),
      'PEER',
      'the peer wrote after it, so the flush must not date the row it kept over that report',
    );
  },

  async 'a poison while the own write is in flight'() {
    // The same window, but the report never arrives as a delta: write churn
    // trims the invalidation log past this process's cursor, and the repair
    // moves the cursor to a listing instead. The listing still says who wrote
    // last, and the flush must hear it.
    const held = heldWriteFile();
    const { authority, probe } = await boot({}, held.overrides);

    probe.write(`${APP}/race.txt`, 'MINE');
    await held.wrote;
    authority.kfs.writeFile('home/user/app/race.txt', 'PEER');
    for (let i = 0; i < 4_000; i++) authority.kfs.writeFile('home/user/app/churn.txt', `churn-${i}`);
    assert.equal(await probe.resume(`${APP}/race.txt`), 'MINE');
    const stats = coherenceStats();
    assert.ok(stats.poisons >= 1 && stats.reconciles >= 1, 'the scenario is vacuous unless the barrier was poisoned and repaired');

    held.release();
    await probe.settle(20);
    assert.equal(
      await probe.resume(`${APP}/race.txt`),
      'PEER',
      'the repair skipped the report, so it must hand the listed revision to the write that owns the row',
    );
  },

  async 'a read in flight while a barrier reports its path'() {
    // A barrier that names a path nobody holds evicts nothing and consumes the
    // report. A live read of that path already in flight may have been served
    // before the change, and must not install its bytes behind the only report
    // that could have evicted them.
    const readGate = Promise.withResolvers();
    const readServed = Promise.withResolvers();
    const { authority, probe } = await boot({}, (auth) => ({
      async fsReadBatch(requests) {
        const entries = await _rpcFsReadBatch(auth.host, requests);
        if (requests.some((request) => request.path.endsWith('/slow.txt'))) {
          readServed.resolve();
          await readGate.promise;
        }
        return entries;
      },
    }));

    authority.kfs.writeFile('home/user/app/slow.txt', 'S1');
    const reading = probe.readAsync(`${APP}/slow.txt`);
    await readServed.promise;
    authority.kfs.writeFile('home/user/app/slow.txt', 'S2');
    assert.equal(await probe.resume(`${APP}/other.txt`), 'ERR:ENOENT', 'a barrier runs while the read is held');
    readGate.resolve();
    assert.equal(await reading, 'S1', 'the async read returns what it was served');
    assert.notEqual(probe.read(`${APP}/slow.txt`), 'S1', 'but must not leave those bytes behind for a sync read');
    assert.equal(await probe.readAsync(`${APP}/slow.txt`), 'S2');
    assert.equal(probe.read(`${APP}/slow.txt`), 'S2', 'a read issued after the change fills the store as usual');
  },
});

/** A writeFile the authority applies at once but answers only on release(). */
function heldWriteFile() {
  const gate = Promise.withResolvers();
  const landed = Promise.withResolvers();
  return {
    wrote: landed.promise,
    release: () => gate.resolve(),
    overrides: (auth) => ({
      async writeFile(path, content) {
        const revision = await auth.host.supervisorOp({ op: 'writeFile', args: [path, content] });
        landed.resolve();
        await gate.promise;
        return revision;
      },
    }),
  };
}

console.log('resident-store-provenance: ok');
