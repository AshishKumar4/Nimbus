#!/usr/bin/env bun
// N18: a facet store's grant answer says what a user may still write, as df
// does (the limit, less the kernel's reserve, less what the ledger counts),
// granted or refused, so a store sizes what it only caches (its pages,
// RESIDENT_PAGE_CACHE_FREE_SHARE) by it.

import assert from 'node:assert/strict';
import { StorageLedger } from '../../packages/core/src/runtime/storage-ledger.ts';
import { _rpcFsStorageGrant } from '../../packages/worker/src/session/rpc.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const limit = 50_000_000;
const ledger = new StorageLedger(harness.sql, { limit, sessionBytes: () => 10_000_000, kernelReserve: 1_000_000 });
const self = { sqliteFs: { ledger } };
const df = () => { const view = ledger.view(); return limit - ledger.kernelReserve - view.used; };

const granted = await _rpcFsStorageGrant(self, 'wasi-git-0', 4_000_000, 2_000_000);
assert.equal(granted.granted, 4_000_000);
assert.equal(granted.available, df(), 'a grant says what is still free after it');
assert.ok(granted.available < limit - ledger.kernelReserve - 10_000_000);

const report = await _rpcFsStorageGrant(self, 'wasi-git-0', 0, 7_000_000);
assert.deepEqual(report, { granted: 0, available: df() }, 'a report of size says it too');

const refused = await _rpcFsStorageGrant(self, 'wasi-git-0', limit, 7_000_000);
assert.equal(refused.granted, 0, 'past the limit, nothing is granted');
assert.equal(refused.available, df(), 'and the store learns what is left');

console.log('n18-grant-available: ok');
