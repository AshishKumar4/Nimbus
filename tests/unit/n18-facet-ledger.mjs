#!/usr/bin/env bun
// N18 for facets. A resident process's store is filled under its facet's name,
// and that fill is admitted by the hosting actor's storage ledger before the
// facet exists: past the limit the spawn is ENOSPC and there is no facet. What
// the facet measures once it is up (databaseSize) settles its row, or records
// the overshoot. Releasing an ephemeral process deletes its database and its
// row together; a durable application's abort keeps both, and only
// deleteFacetStorage drops them.

import assert from 'node:assert/strict';
import { processes, deleteFacetStorage, residentFacetOf } from '../../packages/fabric/src/workerd-facet-host.ts';
import { StorageLedger } from '../../packages/core/src/runtime/storage-ledger.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const LIMIT = 10_000_000_000;

function makeCtx(databaseSize) {
  const { sql } = createSqliteVfsTestHarness();
  const stored = new Set();
  const session = { databaseSize: 1_000_000 };
  // The session DO's SQL, as workerd reports its size.
  const sessionSql = { exec: (...args) => sql.exec(...args), get databaseSize() { return session.databaseSize; } };
  return {
    id: { toString: () => 'session' },
    stored,
    session,
    storage: { async get() { return undefined; }, async put() {}, sql: sessionSql },
    facets: {
      get(name) {
        stored.add(name);
        return {
          async startProcess() { return { ok: true, databaseSize }; },
          async handleHttpRequest() { return new Response('ok'); },
        };
      },
      abort() {},
      delete(name) { stored.delete(name); },
    },
  };
}

const env = { LOADER: { get: () => ({ getDurableObjectClass: () => class {} }) } };
const spawn = (ctx, pid, extra = {}) => processes(ctx, env).spawn(
  () => ({}),
  { doId: 'session', pid, writerId: `w${pid}` },
  { pid, writerId: `w${pid}`, startArgs: {}, boot: { kind: 'code', code: {} }, ...extra },
);
const ledgerOf = (ctx) => new StorageLedger(ctx.storage.sql).view();

// Admitted under the facet's name, then settled to what the facet measures.
{
  const ctx = makeCtx(3_000_000);
  const facet = spawn(ctx, 1, { storageBytes: 5_000_000 });
  assert.equal(ledgerOf(ctx).facets[facet.name], 5_000_000, 'recorded before the facet starts');
  assert.equal(residentFacetOf(ctx, 1), facet.name);
  await facet.started;
  assert.equal(ledgerOf(ctx).facets[facet.name], 3_000_000, 'settled to the measured size');
  // An ephemeral release deletes the database and the row together.
  await facet.release();
  assert.equal(ctx.stored.has(facet.name), false);
  assert.equal(ledgerOf(ctx).facets[facet.name], undefined);
  assert.equal(residentFacetOf(ctx, 1), undefined);
}

// A facet that measures more than it was admitted: the overshoot is recorded.
{
  const ctx = makeCtx(8_000_000);
  const facet = spawn(ctx, 2, { storageBytes: 5_000_000 });
  await facet.started;
  const view = ledgerOf(ctx);
  assert.equal(view.facets[facet.name], 8_000_000);
  assert.equal(view.overshoot, 3_000_000);
  await facet.release();
}

// Past the limit: ENOSPC, and no facet is created.
{
  const ctx = makeCtx(0);
  ctx.session.databaseSize = LIMIT - 1_000;
  assert.throws(() => spawn(ctx, 3, { storageBytes: 5_000 }), { code: 'ENOSPC' });
  assert.equal(ctx.stored.size, 0, 'no facet was created');
  assert.deepEqual(ledgerOf(ctx).facets, {});
  assert.equal(residentFacetOf(ctx, 3), undefined);
}

// A durable application's facet: release keeps its database and its row;
// deleteFacetStorage drops both.
{
  const ctx = makeCtx(2_000_000);
  const facet = spawn(ctx, 4, { storageBytes: 2_000_000, facet: { name: 'app-slot-1', durable: true } });
  await facet.started;
  await facet.release();
  assert.equal(ctx.stored.has('app-slot-1'), true);
  assert.equal(ledgerOf(ctx).facets['app-slot-1'], 2_000_000, 'a dead facet still counts');
  deleteFacetStorage(ctx, 'app-slot-1');
  assert.equal(ctx.stored.has('app-slot-1'), false);
  assert.equal(ledgerOf(ctx).facets['app-slot-1'], undefined);
}

// The facet is told its allowance, and once up its row is the cap its store
// keeps under (or what it measures, if more).
{
  const ctx = makeCtx(1_500_000);
  let args = null;
  ctx.facets.get = (name) => {
    ctx.stored.add(name);
    return {
      async startProcess(startArgs) { args = startArgs; return { ok: true, databaseSize: 1_500_000, storageCap: 4_000_000 }; },
      async handleHttpRequest() { return new Response('ok'); },
    };
  };
  const facet = processes(ctx, env).spawn(
    () => ({}),
    { doId: 'session', pid: 6, writerId: 'w6' },
    { pid: 6, writerId: 'w6', startArgs: { vfsCursor: null }, boot: { kind: 'code', code: {} }, storageBytes: 3_000_000 },
  );
  await facet.started;
  assert.deepEqual(args.storage, { facet: facet.name, grant: 3_000_000 });
  assert.equal(ledgerOf(ctx).facets[facet.name], 4_000_000);
  await facet.release();
}

console.log('n18-facet-ledger: ok');
