#!/usr/bin/env bun
// A path whose revision the supervisor dropped never vouches for a stale
// resident row.
//
// SqliteVFS holds per-path revisions under a byte budget, and a path it
// dropped reports the floor: the newest revision dropped. The resident
// store's reconcile keeps a row dated at or above the revision fsList reports
// for its path, so a dropped path reporting 0, or anything below its last
// write, would keep the bytes that write replaced. Nothing is mocked below
// the RPC surface, as in resident-poison-reconcile: a real SqliteVFS with a
// small budget, the real fsList / fsReadBatch handlers, and the store's
// shipped source over a real SQLite.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';

import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { _rpcFsList, _rpcFsReadBatch } from '../../packages/worker/src/session/rpc.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { FACET_RESIDENT_STORE_SOURCE } from '../../packages/worker/src/vfs/facet-resident-store.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { attachSupervisorOps } from './session-supervisor-ops.mjs';

const dec = new TextDecoder();

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

function loadStore() {
  const factory = new Function(
    FACET_RESIDENT_STORE_SOURCE
      + '\nreturn { __residentBind, __residentAdoptModuleBundle, __residentSynchronizeFromSupervisor,'
      + ' __residentKeys, __residentGet, __residentProvenance };',
  );
  const store = factory();
  store.__residentBind({ storage: { sql: sqlShim() } });
  return store;
}

const asText = (cell) => (typeof cell === 'string' ? cell : dec.decode(cell));

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx, undefined, { pathRevisionBytes: 4096 });
const kfs = rawVfs.as(CRED_KERNEL);
const host = attachSupervisorOps({ sqliteFs: rawVfs, processes: new SessionProcessSupervisor(), ensureSqliteFs() {} });
const supervisor = {
  fsList: (after, limit) => _rpcFsList(host, after ?? null, limit ?? null),
  fsReadBatch: (requests) => _rpcFsReadBatch(host, requests),
};

async function listedRevision(path) {
  let after = null;
  do {
    const page = await supervisor.fsList(after, 256);
    for (const entry of page.entries) if (String(entry.path).replace(/^\/+/, '') === path) return entry.rev;
    after = page.next;
  } while (after !== null);
  return undefined;
}

function assertNoStaleByte(store, label) {
  for (const path of store.__residentKeys()) {
    assert.equal(
      asText(store.__residentGet(path)),
      dec.decode(kfs.readFile(path)),
      `${label}: ${path} is stale — the store served bytes the authority has replaced`,
    );
  }
}

kfs.mkdir('app', { recursive: true, mode: 0o755 });
for (let i = 0; i < 8; i++) kfs.writeFile(`app/f${i}.txt`, `v1-${i}`, { mode: 0o644 });
const TARGET = 'app/f3.txt';

// ── Boot: the store holds every file, dated at its listed revision ────────
const store = loadStore();
store.__residentAdoptModuleBundle({}, { epoch: rawVfs.epoch, rev: rawVfs.revision() });
const booted = await store.__residentSynchronizeFromSupervisor(supervisor);
assert.equal(booted.filled, 8);
const heldAt = store.__residentProvenance(TARGET);
assert.equal(asText(store.__residentGet(TARGET)), 'v1-3');

// ── A peer rewrites the target; churn then drops its revision ─────────────
kfs.writeFile(TARGET, 'v2-peer');
const writtenAt = kfs.revision(TARGET);
assert.ok(writtenAt > heldAt);
kfs.mkdir('churn', { mode: 0o755 });
let churn = 0;
while (rawVfs.getStats().pathRevisions.floor < writtenAt) kfs.writeFile(`churn/c${churn++}`, 'x');
assert.equal(kfs.revision(TARGET), rawVfs.getStats().pathRevisions.floor, 'the target reports the floor');

// The listing reports the dropped path at the floor: at or above its write,
// so above the row's date. Reporting 0 there is what would keep the row.
const listedAt = await listedRevision(TARGET);
assert.ok(listedAt >= writtenAt, `a dropped path listed at ${listedAt}, below its write at ${writtenAt}`);

// ── The reconcile: the stale row goes, the peer's bytes come back ─────────
const repaired = await store.__residentSynchronizeFromSupervisor(supervisor);
assert.equal(repaired.reconciled, true, 'a same-epoch reconcile compares revisions');
assert.equal(asText(store.__residentGet(TARGET)), 'v2-peer', 'a floor-reported revision vouched for a stale row');
assertNoStaleByte(store, 'after the floor rose');
assert.ok(store.__residentProvenance(TARGET) >= writtenAt);

// Untouched rows of dropped paths are refetched too: the floor rose past the
// revision they were dated at. That is the cost, and all of it.
assert.equal(repaired.dropped, 8, 'every row dated below the floor was dropped');
assert.equal(repaired.filled, 8 + churn, 'and refetched with the churn it had not seen');

// A second reconcile with nothing changed keeps every row: the floor did not
// move, and each row is dated at the revision it was listed at.
const settled = await store.__residentSynchronizeFromSupervisor(supervisor);
assert.equal(settled.dropped, 0);
assert.equal(settled.filled, 0);
assertNoStaleByte(store, 'at rest');

console.log(`resident-revision-floor: ok (${churn} churn writes raised the floor past the target)`);
