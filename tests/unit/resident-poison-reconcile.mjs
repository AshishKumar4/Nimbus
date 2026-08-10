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

import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { _rpcFsAcquire, _rpcFsList, _rpcFsReadBatch } from '../../packages/worker/src/session/rpc.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import { FACET_RESIDENT_STORE_SOURCE } from '../../packages/worker/src/vfs/facet-resident-store.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

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
      + ' __residentKeys, __residentGet, bundle: __nimbusResidentBundle };',
  );
  const store = factory();
  store.__residentBind({ storage: { sql: sqlShim() } });
  return store;
}

// ── the authority ───────────────────────────────────────────────────────────

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kfs = rawVfs.as(CRED_KERNEL);
const host = { sqliteFs: rawVfs, processes: new SessionProcessSupervisor(), ensureSqliteFs() {} };

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

// ── a cross-epoch poison still takes the cold cache ─────────────────────────
//
// Revisions from two incarnations are unrelated clocks, and after a restart an
// untouched path lists at rev 0 — which would vouch for any stale row. The
// comparison is refused there rather than trusted.

{
  // A fully populated store, so the sweep has real rows to reject — and one
  // unflushed own write, which is newer than anything any authority can report
  // and survives an incarnation change like it survives a delta.
  const { store } = await bootedStore();
  store.bundle['app/d0/unflushed.txt'] = 'MY-OWN-UNFLUSHED-BYTES';
  assert.equal(store.__residentStats().files, FILES + 1);

  const restarted = new SqliteVFS(harness.sql, harness.ctx);
  const restartedHost = {
    sqliteFs: restarted,
    processes: new SessionProcessSupervisor(),
    ensureSqliteFs() {},
  };
  assert.notEqual(restarted.epoch, rawVfs.epoch, 'the restart really is a new incarnation');
  const supervisor = {
    fsList: (after, limit) => _rpcFsList(restartedHost, after ?? null, limit ?? null),
    fsReadBatch: (requests) => _rpcFsReadBatch(restartedHost, requests),
  };
  const result = await store.__residentSynchronizeFromSupervisor(supervisor);
  assert.equal(result.reconciled, false, 'revisions across epochs are not comparable');
  assert.equal(result.dropped, FILES, 'so every row the authority vouches for is rebuilt');
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

console.log(
  `resident-poison-reconcile: ok — poison cost ${keepBytes} B / `
  + `${warm.supervisor.cost.readCalls} read calls, against ${dropBytes} B / `
  + `${FULL_FILL_CALLS} for the drop-and-refill it replaces `
  + `(${FILES} files, ${(FULL_FILL_BYTES / 1024 / 1024).toFixed(1)} MiB tree)`,
);
