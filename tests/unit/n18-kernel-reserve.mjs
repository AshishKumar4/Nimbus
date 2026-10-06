#!/usr/bin/env bun
// N18's kernel reserve: as ext4 keeps blocks for root, the ledger keeps the
// last part of the storage limit (1% of it, at least 16 MiB) for uid 0. A user
// who fills the store is refused at the reserve, and the kernel's own writes
// (seeding, session state, receipts, leases) still land inside it.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { StorageLedger } from '../../packages/core/src/runtime/storage-ledger.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

// The default reserve: 1% of the limit, and never under 16 MiB.
assert.equal(new StorageLedger(createSqliteVfsTestHarness().sql).kernelReserve, 100_000_000);
assert.equal(new StorageLedger(createSqliteVfsTestHarness().sql, { limit: 200_000_000 }).kernelReserve, 16 * 1024 * 1024);

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const harness = createSqliteVfsTestHarness();
const setup = new SqliteVFS(harness.sql, harness.ctx);
setup.as(CRED_KERNEL).mkdir('home');
setup.as(CRED_KERNEL).chown('home', 1000, 1000);
const RESERVE = 2_000_000;
const limit = setup.databaseBytes() + 3_000_000 + RESERVE;
const vfs = new SqliteVFS(harness.sql, harness.ctx, undefined, { storageLimit: limit, storageKernelReserve: RESERVE });
const user = vfs.as(USER);
const kernel = vfs.as(CRED_KERNEL);
const distinct = (n) => {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i += 65_536) crypto.getRandomValues(bytes.subarray(i, Math.min(n, i + 65_536)));
  return bytes;
};
const code = (fn) => { try { fn(); return 'ok'; } catch (error) { return error.code; } };

// The user fills what is theirs; the next 1.5 MB would reach into the reserve.
assert.equal(code(() => user.writeFile('home/a', distinct(2_500_000))), 'ok');
assert.equal(code(() => user.writeFile('home/b', distinct(1_500_000))), 'ENOSPC');
// The kernel still writes there.
assert.equal(code(() => kernel.writeFile('home/k', distinct(1_500_000))), 'ok');
// Even the kernel stops at the limit itself.
assert.equal(code(() => kernel.writeFile('home/k2', distinct(RESERVE))), 'ENOSPC');
// A facet fill is never the kernel's.
assert.equal(code(() => vfs.ledger.fill('proc-slot-0', 100_000)), 'ENOSPC');

// A streamed write awaits its source, and still runs its transactions with
// uid 0's privilege after it: the same fill, then the kernel's 1.5 MB
// streamed into the reserve.
{
  const fresh = createSqliteVfsTestHarness();
  const base = new SqliteVFS(fresh.sql, fresh.ctx);
  base.as(CRED_KERNEL).mkdir('home');
  base.as(CRED_KERNEL).chown('home', 1000, 1000);
  const bounded = new SqliteVFS(fresh.sql, fresh.ctx, undefined, {
    storageLimit: base.databaseBytes() + 3_000_000 + RESERVE,
    storageKernelReserve: RESERVE,
  });
  assert.equal(code(() => bounded.as(USER).writeFile('home/a', distinct(2_500_000))), 'ok');
  const stream = (cred) => bounded.as(cred).writeFileFrom('home/s', 1_500_000, (async function* () { yield distinct(1_500_000); })())
    .then(() => 'ok', (error) => error.code);
  assert.equal(await stream(USER), 'ENOSPC', 'a user streaming into the reserve is refused');
  assert.equal(await stream(CRED_KERNEL), 'ok', 'the kernel streams into it');
}

console.log('n18-kernel-reserve: ok');
