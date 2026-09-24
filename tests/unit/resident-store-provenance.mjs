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
  sleep,
  until,
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
  // One resumption, then synchronous reads of every path named.
  resumeAll: (paths) => {
    const done = Promise.withResolvers();
    setTimeout(() => done.resolve(paths.map(read)), 0);
    return done.promise;
  },
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
    // The model's trace (lean/Nimbus/Coherence/StoreBugs.lean,
    // own_committed_write_is_served_past_a_peer). The authority commits this
    // process's write of p at r1 and holds the response, the way a Durable
    // Object's output gate holds it. A peer then commits p at r2, and q after
    // it, and a resumption's barrier reports both. Until the response says r1,
    // the process cannot tell whether r2 was its own write or a later one, so
    // it may not resume on its own bytes of p: that would read q after the
    // peer's write and p before it.
    const held = heldWriteFile();
    const { authority, probe } = await boot({ 'q.txt': 'q0' }, held.overrides);

    probe.write(`${APP}/race.txt`, 'MINE');
    await held.wrote;
    authority.kfs.writeFile('home/user/app/race.txt', 'PEER');
    authority.kfs.writeFile('home/user/app/q.txt', 'q1');
    const resumed = probe.resumeAll([`${APP}/race.txt`, `${APP}/q.txt`]);
    assert.equal(
      await Promise.race([resumed, sleep(100).then(() => 'still waiting')]),
      'still waiting',
      'a resumption may not run on an own row whose acknowledgement could date it below the report',
    );

    held.release();
    assert.deepEqual(await resumed, ['PEER', 'q1'], 'the acknowledgement says r1, below the report: the peer wrote last');
    assert.deepEqual(await probe.resumeAll([`${APP}/race.txt`, `${APP}/q.txt`]), ['PEER', 'q1']);
  },

  async 'a later barrier while an earlier one waits on the acknowledgement'() {
    // The same window, and a second resumption inside it. The first barrier's
    // answer reported p and moved the cursor past it, so the second asks from
    // there and hears nothing: p is not news any more. Its row is no fresher
    // for that (lean/Nimbus/Coherence/StoreBugs.lean,
    // a_per_answer_wait_misses_an_earlier_report).
    const held = heldWriteFile();
    const { authority, log, probe } = await boot({ 'q.txt': 'q0' }, held.overrides);

    probe.write(`${APP}/race.txt`, 'MINE');
    await held.wrote;
    authority.kfs.writeFile('home/user/app/race.txt', 'PEER');
    authority.kfs.writeFile('home/user/app/q.txt', 'q1');
    const acquired = log.calls.fsAcquire ?? 0;
    const first = probe.resumeAll([`${APP}/race.txt`, `${APP}/q.txt`]);
    await until(() => (log.calls.fsAcquire ?? 0) > acquired, "the first resumption's barrier");
    await sleep(20);
    const second = probe.resumeAll([`${APP}/race.txt`, `${APP}/q.txt`]);
    assert.equal(
      await Promise.race([second, sleep(100).then(() => 'still waiting')]),
      'still waiting',
      'a barrier whose answer names nothing still may not resume on the reported own row',
    );

    held.release();
    assert.deepEqual(await first, ['PEER', 'q1']);
    assert.deepEqual(await second, ['PEER', 'q1']);
  },

  async 'a newer write parked over one being acknowledged'() {
    // A program that writes and yields in a loop: its last write-back is still
    // being acknowledged when the next write is parked over it, and a barrier
    // reports the last one coming back. The facet serves the newer cell, which
    // is only parked and will be applied above every report, so nothing it
    // reads depends on the older acknowledgement and the resumption does not
    // wait for it.
    const held = heldWriteFile();
    const { authority, probe } = await boot({ 'q.txt': 'q0' }, held.overrides);

    probe.write(`${APP}/race.txt`, 'FIRST');
    await held.wrote;
    probe.write(`${APP}/race.txt`, 'SECOND');
    authority.kfs.writeFile('home/user/app/q.txt', 'q1');
    const resumed = probe.resumeAll([`${APP}/race.txt`, `${APP}/q.txt`]);
    assert.deepEqual(
      await Promise.race([resumed, sleep(100).then(() => 'still waiting')]),
      ['SECOND', 'q1'],
      'the resumption reads its newest write at once, with the older one still unacknowledged',
    );

    held.release();
    await probe.settle(50);
    assert.equal(authority.read('home/user/app/race.txt'), 'SECOND');
    assert.deepEqual(await probe.resumeAll([`${APP}/race.txt`, `${APP}/q.txt`]), ['SECOND', 'q1']);
  },

  async 'an own write that lands after a peer write'() {
    // The other order. The peer commits p first and this process's write
    // after it: the report is below the acknowledgement, and the process's
    // own bytes are the newest.
    const held = heldWriteFile();
    const { authority, probe } = await boot({}, held.overrides);
    authority.kfs.writeFile('home/user/app/race.txt', 'PEER');
    probe.write(`${APP}/race.txt`, 'MINE');
    await held.wrote;
    const resumed = probe.resume(`${APP}/race.txt`);
    held.release();
    assert.equal(await resumed, 'MINE');
    assert.equal(authority.read('home/user/app/race.txt'), 'MINE');
  },

  async 'a poison while the own write is in flight'() {
    // The same window, but the report never arrives as a delta: write churn
    // trims the invalidation log past this process's cursor, and the repair
    // moves the cursor to a listing instead. A barrier that cannot name what
    // changed waits for every own acknowledgement in flight, and the listing
    // it repaired from says who wrote last.
    const held = heldWriteFile();
    const { authority, probe } = await boot({}, held.overrides);

    probe.write(`${APP}/race.txt`, 'MINE');
    await held.wrote;
    authority.kfs.writeFile('home/user/app/race.txt', 'PEER');
    for (let i = 0; i < 4_000; i++) authority.kfs.writeFile('home/user/app/churn.txt', `churn-${i}`);
    const resumed = probe.resume(`${APP}/race.txt`);
    assert.equal(await Promise.race([resumed, sleep(100).then(() => 'still waiting')]), 'still waiting');
    const stats = coherenceStats();
    assert.ok(stats.poisons >= 1 && stats.reconciles >= 1, 'the scenario is vacuous unless the barrier was poisoned and repaired');

    held.release();
    assert.equal(
      await resumed,
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

  async 'resumptions during a refetch wait on it rather than read again'() {
    // A peer rewrites 50 held files. The first resumption after that drops
    // them and refetches them in one batch, answered late. Nine more
    // resumptions land while that batch is in flight. Nothing changed since
    // the first one's ACQUIRE, so each must wait on the refetch already
    // running rather than read all 50 files again.
    const N = 50;
    const files = {};
    for (let i = 0; i < N; i++) files[`many-${i}.txt`] = `old-${i}`;
    const paths = Object.keys(files).map((name) => `${APP}/${name}`);
    const hold = { armed: false, held: false, gate: Promise.withResolvers(), served: Promise.withResolvers(), reads: 0 };
    const { authority, log, probe } = await boot(files, (auth) => ({
      async fsReadBatch(requests) {
        const entries = await _rpcFsReadBatch(auth.host, requests);
        if (hold.armed) {
          hold.reads += requests.filter((request) => request.path.includes('/many-')).length;
          if (!hold.held) {
            hold.held = true;
            hold.served.resolve();
            await hold.gate.promise;
          }
        }
        return entries;
      },
    }));
    hold.armed = true;
    for (let i = 0; i < N; i++) authority.kfs.writeFile(`home/user/app/many-${i}.txt`, `new-${i}`);
    const first = probe.resumeAll(paths);
    await hold.served.promise;
    const acquired = log.calls.fsAcquire ?? 0;
    const later = [];
    for (let i = 0; i < 9; i++) later.push(probe.resumeAll(paths));
    await until(() => (log.calls.fsAcquire ?? 0) >= acquired + 9, 'the nine later ACQUIREs');
    await sleep(20);
    hold.gate.resolve();

    const expected = paths.map((_, i) => `new-${i}`);
    for (const seen of [await first, ...(await Promise.all(later))]) {
      assert.deepEqual(seen, expected, 'every resumption reads the peer bytes');
    }
    assert.equal(hold.reads, N, `one read per changed file, not one per resumption (was ${hold.reads})`);
  },

  async 'a refetch in flight that a later write outdates'() {
    // The other side of waiting: a resumption whose own delta reports the
    // path above the cursor the in-flight refetch was issued under cannot
    // use that refetch — its install will be declined — and reads the path
    // itself.
    const hold = { armed: false, held: false, gate: Promise.withResolvers(), served: Promise.withResolvers() };
    const { authority, log, probe } = await boot({ 'p.txt': 'v1' }, (auth) => ({
      async fsReadBatch(requests) {
        const entries = await _rpcFsReadBatch(auth.host, requests);
        if (hold.armed && !hold.held) {
          hold.held = true;
          hold.served.resolve();
          await hold.gate.promise;
        }
        return entries;
      },
    }));

    hold.armed = true;
    authority.kfs.writeFile('home/user/app/p.txt', 'v2');
    const first = probe.resume(`${APP}/p.txt`);
    await hold.served.promise;
    authority.kfs.writeFile('home/user/app/p.txt', 'v3');
    const acquired = log.calls.fsAcquire ?? 0;
    const second = probe.resume(`${APP}/p.txt`);
    await until(() => (log.calls.fsAcquire ?? 0) > acquired, "the second resumption's ACQUIRE");
    await sleep(20);
    hold.gate.resolve();

    assert.equal(await second, 'v3', 'the second resumption reads what its own delta reported');
    assert.match(await first, /^v[23]$/, 'the first reads its own refetch or a newer one');
  },

  async 'a peer that keeps rewriting a held file'() {
    // A log or a database another shell rewrites in a loop, faster than one
    // read round trip. Every resumption's delta reports it, and each report
    // outdates the refetch the resumption before it issued. A resumption
    // waits on what is in flight while it waits, not on every refetch issued
    // after it began, so one that never reads the file is not held until the
    // writer stops.
    const K = 'home/user/app/k.log';
    const slow = { armed: false };
    const { authority, probe } = await boot({ 'k.log': 'w0', 'other.txt': 'o1' }, (auth) => ({
      async fsReadBatch(requests) {
        const entries = await _rpcFsReadBatch(auth.host, requests);
        if (slow.armed && requests.some((request) => request.path.endsWith('/k.log'))) await sleep(30);
        return entries;
      },
    }));

    slow.armed = true;
    const stop = Date.now() + 3_000;
    let writes = 0;
    let writing = true;
    const writer = (async () => {
      while (writing && Date.now() < stop) {
        authority.kfs.writeFile(K, `w${++writes}`);
        await sleep(10);
      }
      writing = false;
    })();
    const started = Date.now();
    const first = probe.resume(`${APP}/other.txt`);
    const later = [];
    const arrivals = (async () => {
      while (writing) {
        await sleep(10);
        later.push(probe.resume(`${APP}/other.txt`));
      }
    })();

    const seen = await first;
    const elapsed = Date.now() - started;
    const peerStillWriting = writing;
    writing = false;
    await writer;
    await arrivals;
    assert.ok(
      peerStillWriting,
      `a resumption that does not read k.log was held until the peer stopped writing it (${elapsed} ms, ${writes} writes)`,
    );
    assert.equal(seen, 'o1');
    for (const other of await Promise.all(later)) assert.equal(other, 'o1');
    assert.equal(await probe.resume(`${APP}/k.log`), `w${writes}`, 'once the peer stops, a resumption reads its last write');
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
