#!/usr/bin/env bun
// A poison must be CHEAP and it must stay UNCONDITIONAL. Both, together —
// cost without correctness is worthless here, because the whole reason the
// resident store exists is the guarantee that a synchronous read never serves
// a byte the authority has replaced.
//
// The defect this guards: `SqliteVFS`'s invalidation log is bounded at 256 KiB
// and ordinary write churn trims it past a live cursor as a matter of course.
// `invalidatedSince` then answers `poison`, and the store used to respond by
// dropping every row and re-materialising the filesystem — ~16k files / 96 MB
// at pi scale — awaited inside the ACQUIRE barrier, on EVERY poison. Measured
// live, that took an agent turn past the DO CPU limit.
//
// Nothing here is mocked below the RPC surface: a real `SqliteVFS` with a real
// invalidation log, the real `_rpcFsList` / `_rpcFsReadBatch` / `_rpcFsAcquire`
// handlers, and the store's real shipped source over a real SQLite. A fake
// would let the reconcile pass with the revision comparison deleted.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { _rpcFsAcquire, _rpcFsList, _rpcFsReadBatch } from '../../packages/worker/src/session/rpc.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { FACET_RESIDENT_STORE_SOURCE } from '../../packages/worker/src/vfs/facet-resident-store.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { attachSupervisorOps } from './lib/session-supervisor-ops.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const dec = new TextDecoder();

/** workerd's `ctx.storage.sql`: exec(query, ...params) → synchronous cursor. */
function sqlShim() {
  const db = new Database(':memory:');
  return {
    exec(query, ...params) {
      if (/^\s*(CREATE|INSERT|UPDATE|DELETE|REPLACE)/i.test(query)) {
        db.query(query).run(...params);
        return [];
      }
      return db.query(query).all(...params);
    },
    get databaseSize() { return 0; },
  };
}

/** A fresh module scope holding the shipped store source, over its own SQLite. */
function loadStore() {
  const factory = new Function(
    FACET_RESIDENT_STORE_SOURCE
      + '\nreturn { __residentBind, __residentAdmit, __residentAdoptModuleBundle,'
      + ' __residentSynchronizeFromSupervisor, __residentCursor, __residentStats,'
      + ' __residentKeys, __residentGet, __residentSetPlan, __residentStamp, __residentSetStorage,'
      + ' bundle: __nimbusResidentBundle };',
  );
  const store = factory();
  store.__residentBind({ storage: { sql: sqlShim() } });
  // The launch's data plan names every file here: this test is about how the
  // store keeps what it holds, not about what it is asked to hold.
  store.__residentSetPlan(Array.from({ length: FILES }, (_, i) => `app/d${Math.floor(i / 100)}/f${i}.dat`));
  return store;
}

// ── the authority ───────────────────────────────────────────────────────────

const harness = createSqliteVfsTestHarness();
// No tombstones kept, so a deletion puts older cursors past the SQL answer.
const rawVfs = new SqliteVFS(harness.sql, harness.ctx, undefined, { tombstoneRows: 0 });
const kfs = rawVfs.as(CRED_KERNEL);
const host = attachSupervisorOps({ sqliteFs: rawVfs, processes: new SessionProcessSupervisor(), ensureSqliteFs() {} });

const FILES = 1_200;
const FILE_BYTES = 2 * 1024;
kfs.mkdir('app', { recursive: true, mode: 0o755 });
for (let i = 0; i < FILES; i++) {
  const dir = `app/d${Math.floor(i / 100)}`;
  if (i % 100 === 0) kfs.mkdir(dir, { recursive: true, mode: 0o755 });
  kfs.writeFile(`${dir}/f${i}.dat`, `v0-${i}-`.padEnd(FILE_BYTES, 'x'), { mode: 0o644 });
}

/** Every supervisor call the store may make, counted and byte-metered. */
function meteredSupervisor() {
  const cost = { listCalls: 0, readCalls: 0, readPaths: 0, readBytes: 0 };
  return {
    cost,
    async fsList(after, limit) {
      cost.listCalls++;
      return _rpcFsList(host, after ?? null, limit ?? null);
    },
    async fsReadBatch(requests) {
      cost.readCalls++;
      cost.readPaths += requests.length;
      for (const r of requests) cost.readBytes += r.length;
      return _rpcFsReadBatch(host, requests);
    },
    async fsAcquire(epoch, cursor) {
      return _rpcFsAcquire(host, epoch, cursor);
    },
  };
}

/** Boot a store the way `__nimbusEnsureStarted` does: adopt, then synchronize. */
async function bootedStore() {
  const store = loadStore();
  const supervisor = meteredSupervisor();
  store.__residentAdoptModuleBundle({}, { epoch: rawVfs.epoch, rev: rawVfs.revision() });
  const result = await store.__residentSynchronizeFromSupervisor(supervisor);
  return { store, supervisor, result };
}

/** A held cell as text — the store returns strings or bytes by cell kind. */
function asText(cell) {
  assert.ok(
    typeof cell === 'string' || cell instanceof Uint8Array,
    'a held cell is neither text nor bytes',
  );
  return typeof cell === 'string' ? cell : dec.decode(cell);
}

/**
 * Every row the store holds must equal the authority's CURRENT bytes.
 *
 * `ownWrites` names the paths this facet has written and not flushed — newer
 * than anything the authority holds, and the only rows exempt. Naming them
 * rather than skipping whatever the authority happens not to have is what
 * keeps a retained row for a DELETED path a failure rather than a pass.
 */
function assertNoStaleByte(store, label, ownWrites = new Set()) {
  let checked = 0;
  for (const path of store.__residentKeys()) {
    if (ownWrites.has(path)) continue;
    assert.equal(
      asText(store.__residentGet(path)),
      dec.decode(kfs.readFile(path)),
      `${label}: ${path} is stale — the store served bytes the authority has replaced`,
    );
    checked++;
  }
  return checked;
}

// ── boot fills the whole filesystem ─────────────────────────────────────────

const cold = await bootedStore();
assert.equal(cold.result.complete, true, 'the enumeration finished');
assert.equal(cold.result.filled, FILES, 'boot holds every regular file');
assert.equal(assertNoStaleByte(cold.store, 'boot'), FILES);
const FULL_FILL_BYTES = cold.supervisor.cost.readBytes;
const FULL_FILL_CALLS = cold.supervisor.cost.readCalls;
assert.ok(FULL_FILL_BYTES >= FILES * FILE_BYTES, 'a full fill really moves the whole tree');

// ── force a REAL poison ─────────────────────────────────────────────────────
//
// Rewriting one file repeatedly overflows the 256 KiB log — two entries per
// write, path and parent — while moving exactly one path. That separates the
// two quantities the old code conflated: the log's capacity, and the amount of
// the filesystem that actually changed.

const MOVED = 'app/d0/f7.dat';
const PEER_BYTES = 'PEER-WROTE-THIS'.padEnd(FILE_BYTES, 'z');
const CHURN = 'app/d0/f0.dat';
for (let i = 0; i < 4_000; i++) kfs.writeFile(CHURN, `churn-${i}-`.padEnd(64, 'x'));
kfs.writeFile(MOVED, PEER_BYTES);
// Older than the log, a cursor is answered from rows and tombstones; one
// deletion past the (empty) tombstone retention makes it unanswerable.
kfs.writeFile('app/scratch', 'x');
kfs.unlink('app/scratch');

const heldCursor = cold.store.__residentCursor();
const poisoned = await _rpcFsAcquire(host, heldCursor.epoch, heldCursor.rev);
assert.equal(
  poisoned.poison,
  true,
  'the scenario is vacuous unless the log really did trim past the cursor',
);

// ── the reconcile: correct, and proportional to what moved ──────────────────

const warm = { store: cold.store, supervisor: meteredSupervisor() };
const reconciled = await warm.store.__residentSynchronizeFromSupervisor(warm.supervisor);

assert.equal(reconciled.reconciled, true, 'a same-epoch poison is repaired by revision');
assert.equal(reconciled.cursor.epoch, rawVfs.epoch);
assert.ok(reconciled.cursor.rev > 0, 'the cursor advanced past the poison');

// Correctness first. This is the assertion the cost is only allowed to buy
// against: the peer's write must be visible, and nothing else may have drifted.
assert.equal(
  asText(warm.store.__residentGet(MOVED)),
  PEER_BYTES,
  "a peer's write during the churn must be visible after the reconcile",
);
assert.equal(
  assertNoStaleByte(warm.store, 'reconcile'),
  FILES,
  'the reconcile keeps the whole filesystem resident, not a subset',
);

// Then cost. Two paths moved — the churned one and the peer-written one — so
// two are what may be refetched.
assert.equal(reconciled.dropped, 2, 'exactly the two moved paths were dropped');
assert.equal(reconciled.filled, 2, 'and exactly those two were refetched');
assert.equal(reconciled.kept, FILES - 2, 'every other row was proven current by revision');
assert.ok(
  warm.supervisor.cost.readBytes <= 4 * FILE_BYTES,
  `a poison must not re-buy the tree: ${warm.supervisor.cost.readBytes} B refetched`,
);

// ── the counterfactual, measured rather than asserted about ─────────────────
//
// The same poison, handled the way it was before: drop every row, then refill.
// Run on an identical store so the two numbers are comparable.

const dropped = await bootedStore();
dropped.supervisor.cost.readBytes = 0;
dropped.supervisor.cost.readCalls = 0;
dropped.store.__residentAdmit(poisoned);
await dropped.store.__residentSynchronizeFromSupervisor(dropped.supervisor);
assert.equal(assertNoStaleByte(dropped.store, 'drop-and-refill'), FILES);

const dropBytes = dropped.supervisor.cost.readBytes;
const keepBytes = warm.supervisor.cost.readBytes;
assert.ok(
  keepBytes * 100 < dropBytes,
  `the reconcile must be more than 100x cheaper: ${keepBytes} B vs ${dropBytes} B`,
);

// ── a cross-epoch poison vouches by content, not by revision ────────────────
//
// Revisions from two incarnations are unrelated clocks. A restart keeps the
// database's incarnation (sqlite-vfs-durable-clock); a new one comes with a
// new database or rotateIncarnation(), and the comparison is refused there
// rather than trusted. Content keys are not a clock: equal keys are equal
// bytes in any epoch, so a row whose key the new listing repeats is kept and
// re-dated; a row whose content changed is rebuilt (resident-content-key).

{
  // A fully populated store, so the sweep has real rows to reject — and one
  // unflushed own write, which is newer than anything any authority can report
  // and survives an incarnation change like it survives a delta.
  const { store } = await bootedStore();
  store.bundle['app/d0/unflushed.txt'] = 'MY-OWN-UNFLUSHED-BYTES';
  assert.equal(store.__residentStats().files, FILES + 1);

  const restarted = new SqliteVFS(harness.sql, harness.ctx);
  restarted.rotateIncarnation();
  const restartedHost = attachSupervisorOps({
    sqliteFs: restarted,
    processes: new SessionProcessSupervisor(),
    ensureSqliteFs() {},
  });
  assert.notEqual(restarted.epoch, rawVfs.epoch, 'the restart really is a new incarnation');
  const supervisor = {
    fsList: (after, limit) => _rpcFsList(restartedHost, after ?? null, limit ?? null),
    fsReadBatch: (requests) => _rpcFsReadBatch(restartedHost, requests),
  };
  const result = await store.__residentSynchronizeFromSupervisor(supervisor);
  assert.equal(result.reconciled, false, 'revisions across epochs are not comparable');
  assert.equal(result.rekeyed, FILES, 'a row whose content key is listed again is kept');
  assert.equal(result.dropped, 0, 'so nothing is rebuilt');
  assert.equal(result.filled, 0, 'and nothing is fetched');
  assert.equal(result.cursor.epoch, restarted.epoch, 'and the store re-dates to the new epoch');
  assert.equal(
    asText(store.__residentGet('app/d0/unflushed.txt')),
    'MY-OWN-UNFLUSHED-BYTES',
    'an unflushed own write is newer than any authority revision and is kept',
  );
  assert.equal(
    assertNoStaleByte(store, 'cross-epoch', new Set(['app/d0/unflushed.txt'])),
    FILES,
  );
}

// ── a truncated enumeration vouches for nothing and publishes nothing ───────
//
// A short listing cannot tell a path that was REMOVED from one that was never
// walked. Dropping rows against it would delete a live cache; advancing the
// cursor against it would silently forgive every mutation in an unwalked page.

{
  const { store } = await bootedStore();
  const before = store.__residentCursor();
  kfs.writeFile('app/d1/f101.dat', 'moved-under-a-short-listing'.padEnd(FILE_BYTES, 'q'));
  const truncated = {
    fsList: async () => {
      const page = await _rpcFsList(host, null, 4);
      // `next` non-null on every page, so the walk exhausts its page bound
      // instead of ever reporting completion.
      return { ...page, next: page.entries[page.entries.length - 1].path };
    },
    fsReadBatch: (requests) => _rpcFsReadBatch(host, requests),
  };
  const result = await store.__residentSynchronizeFromSupervisor(truncated);
  assert.equal(result.complete, false, 'the listing never finished');
  assert.equal(result.cursor, null, 'so no cursor may be published');
  assert.equal(result.dropped, 0, 'and no row may be dropped against it');
  assert.deepEqual(store.__residentCursor(), before, 'the held cursor is untouched');
}

// A held own write (N18: the store had no room, so the cell sits in the heap)
// is part of the store for the repair too. Once its write-back has dated it,
// a peer's newer write makes it stale: the repair forgets it, so a sync read
// never serves it again (the store has no room to refetch, so the read is a
// miss, not the old bytes). Where revisions are not comparable, every dated
// held cell goes. An undated cell, whose write-back is still in flight, is
// newer than anything the authority holds, and stays.
for (const comparable of [true, false]) {
  const store = loadStore();
  const supervisor = meteredSupervisor();
  const full = { ...supervisor, fsStorageGrant: async () => ({ granted: 0 }) };
  // Comparable: the store is at the authority's epoch. Not comparable: it was
  // adopted at another epoch's cursor, so none of its revisions can be
  // compared with the listing's.
  if (comparable) {
    store.__residentAdoptModuleBundle({}, { epoch: rawVfs.epoch, rev: rawVfs.revision() });
    await store.__residentSynchronizeFromSupervisor(full);
  } else {
    store.__residentAdoptModuleBundle({}, { epoch: 'another-epoch', rev: 0 });
  }
  // No room at all: every own write is held in the heap.
  store.__residentSetStorage({ facet: 'held-facet', grant: 0 }, full);
  const dated = comparable ? 'app/held-dated.txt' : 'app/held-dated-other-epoch.txt';
  const undated = comparable ? 'app/held-undated.txt' : 'app/held-undated-other-epoch.txt';
  store.bundle[dated] = 'OWN-V1';
  store.bundle[undated] = 'OWN-IN-FLIGHT';
  assert.equal(store.__residentGet(dated), 'OWN-V1', 'a held own write reads back');
  kfs.writeFile(dated, 'OWN-V1');
  store.__residentStamp(dated, rawVfs.revision());
  kfs.writeFile(dated, 'PEER-V2');
  const repaired = await store.__residentSynchronizeFromSupervisor(full);
  assert.equal(repaired.reconciled, comparable, `the repair ${comparable ? 'compared' : 'could not compare'} revisions`);
  assert.notEqual(store.__residentGet(dated), 'OWN-V1',
    `${comparable ? 'a peer overwrote' : 'across epochs'}: the repair forgets the dated held cell, never serves it`);
  assert.equal(store.__residentGet(undated), 'OWN-IN-FLIGHT', 'an undated held cell (write-back in flight) stays');
  assert.ok(repaired.own.some((entry) => entry.path === undated), 'and is reported as own, like an own file row');
}

// ── the refinement bridge: FormalModelsLane's store coherence model ──────────
//
// lean/fixtures/resident-poison-reconcile.json (Nimbus.Coherence.Store.exec,
// COH-012): each case is one store over one fresh authority, a sequence of
// peer writes, own writes, write-backs (flush: committed and acknowledged),
// barriers and repairs (a churn write standing in for the poison it causes),
// and after every event what __residentGet serves per path (null: a miss).
// `full` is a store with no room: every own write is held in the heap and
// nothing fetched is admitted.
const FIXTURE = 'lean/fixtures/resident-poison-reconcile.json';
const fixturePath = [join(ROOT, FIXTURE), join(process.env.HOME ?? '', '.cache/nimbus-verify/formal/resident-poison-reconcile.json')].find((p) => existsSync(p));
let bridged = 0;
if (fixturePath) {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const c of fixture.cases) {
    const h = createSqliteVfsTestHarness();
    const vfs = new SqliteVFS(h.sql, h.ctx, undefined, { tombstoneRows: 0 });
    const k = vfs.as(CRED_KERNEL);
    const caseHost = attachSupervisorOps({ sqliteFs: vfs, processes: new SessionProcessSupervisor(), ensureSqliteFs() {} });
    k.mkdir('app', { recursive: true, mode: 0o755 });
    const supervisor = {
      fsList: (after, limit) => _rpcFsList(caseHost, after ?? null, limit ?? null),
      fsReadBatch: (requests) => _rpcFsReadBatch(caseHost, requests),
      fsAcquire: (epoch, cursor) => _rpcFsAcquire(caseHost, epoch, cursor),
      fsStorageGrant: async () => ({ granted: 0 }),
    };
    const store = new Function(FACET_RESIDENT_STORE_SOURCE + '\nreturn { __residentBind, __residentAdmit, __residentAdoptModuleBundle,'
      + ' __residentSynchronizeFromSupervisor, __residentCursor, __residentGet, __residentSetPlan, __residentStamp,'
      + ' __residentSetStorage, bundle: __nimbusResidentBundle };')();
    store.__residentBind({ storage: { sql: sqlShim() } });
    // No plan and no push roots: a repair refetches only what it dropped.
    store.__residentSetPlan([]);
    store.__residentAdoptModuleBundle({}, { epoch: vfs.epoch, rev: vfs.revision() });
    await store.__residentSynchronizeFromSupervisor(supervisor);
    store.__residentSetStorage({ facet: 'bridge', grant: c.full ? 0 : 64 * 1024 * 1024 }, supervisor);
    for (const [i, e] of c.events.entries()) {
      const where = `${FIXTURE} case ${fixture.cases.indexOf(c)} event ${i} (${e.event}${e.path ? ' ' + e.path : ''})`;
      if (e.event === 'peer') k.writeFile(e.path, e.bytes);
      else if (e.event === 'own') store.bundle[e.path] = e.bytes;
      else if (e.event === 'flush') { k.writeFile(e.path, e.bytes); store.__residentStamp(e.path, vfs.revision()); }
      else if (e.event === 'barrier') {
        const at = store.__residentCursor();
        store.__residentAdmit(await supervisor.fsAcquire(at.epoch, at.rev));
      } else if (e.event === 'repair') {
        k.writeFile(c.churn, e.bytes);
        await store.__residentSynchronizeFromSupervisor(supervisor);
      } else throw new Error(`${where}: unknown event`);
      for (const [path, want] of Object.entries(e.expect)) {
        const got = store.__residentGet(path);
        assert.deepEqual(got === undefined ? null : asText(got), want, `${where}: ${path}`);
      }
    }
    bridged++;
  }
}

console.log(
  `resident-poison-reconcile: ${bridged} model cases bridged; ok — poison cost ${keepBytes} B / `
  + `${warm.supervisor.cost.readCalls} read calls, against ${dropBytes} B / `
  + `${FULL_FILL_CALLS} for the drop-and-refill it replaces `
  + `(${FILES} files, ${(FULL_FILL_BYTES / 1024 / 1024).toFixed(1)} MiB tree)`,
);
