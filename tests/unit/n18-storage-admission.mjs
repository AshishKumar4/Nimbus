#!/usr/bin/env bun
// N18: one storage limit covers the session DO and every facet database under
// it, and a write that crosses it resets the object. So the engine admits a
// write before making it: past the limit it is ENOSPC and the destination is
// unchanged. Removals are never refused, a facet's recorded size counts until
// the facet is deleted (an abort keeps it), and a restart keeps the ledger.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const probe = new SqliteVFS(harness.sql, harness.ctx);
probe.as(CRED_KERNEL).mkdir('w');
// Room for about 1 MiB more than the store holds now.
const limit = probe.databaseBytes() + 1_048_576;
const vfs = new SqliteVFS(harness.sql, harness.ctx, undefined, { storageLimit: limit, storageKernelReserve: 0 });
const root = vfs.as(CRED_KERNEL);
const code = (fn) => { try { fn(); return 'ok'; } catch (error) { return error.code; } };
const bytes = (n, fill) => new Uint8Array(n).fill(fill);

// Within the limit: written.
root.writeFile('w/a', bytes(256 * 1024, 1));
assert.equal(root.readFile('w/a').length, 256 * 1024);

// Past it: refused before writing, the old bytes still there.
assert.equal(code(() => root.writeFile('w/a', bytes(2 * 1_048_576, 2))), 'ENOSPC');
assert.deepEqual(root.readFile('w/a'), bytes(256 * 1024, 1));
assert.equal(code(() => root.writeFile('w/b', bytes(2 * 1_048_576, 3))), 'ENOSPC');
assert.equal(root.exists('w/b'), false);

// A facet's recorded database counts: with it, even a small write is refused.
vfs.ledger.fill('facet-1', 900_000);
assert.equal(code(() => root.writeFile('w/c', bytes(200_000, 4))), 'ENOSPC');
assert.equal(root.exists('w/c'), false);
// A fill that would not fit is refused and records nothing.
assert.equal(code(() => vfs.ledger.fill('facet-2', 2 * 1_048_576)), 'ENOSPC');
assert.equal(vfs.ledger.view().facets['facet-2'], undefined);

// Removals are never refused, even over the limit (the facet's overshoot).
vfs.ledger.report('facet-1', 2 * 1_048_576);
assert.equal(code(() => root.unlink('w/a')), 'ok');
assert.equal(code(() => root.writeFile('w/d', bytes(10, 5))), 'ENOSPC');

// A restart re-reads the ledger: the facet still counts.
const restarted = new SqliteVFS(harness.sql, harness.ctx, undefined, { storageLimit: limit, storageKernelReserve: 0 });
assert.equal(restarted.ledger.view().facets['facet-1'], 2 * 1_048_576);
assert.equal(code(() => restarted.as(CRED_KERNEL).writeFile('w/d', bytes(10, 5))), 'ENOSPC');

// facets.delete frees it.
restarted.ledger.deleteFacet('facet-1');
assert.equal(code(() => restarted.as(CRED_KERNEL).writeFile('w/d', bytes(200_000, 6))), 'ok');

// A same-database copy costs rows, and is admitted for them.
const tree = restarted.as(CRED_KERNEL);
tree.mkdir('w/tree');
for (let i = 0; i < 50; i++) tree.writeFile(`w/tree/f${i}`, bytes(10, i));
restarted.ledger.fill('facet-3', limit - restarted.ledger.view().used - 1_000);
assert.equal(await (async () => tree.copyTreeAsync('w/tree', 'w/copy'))().then(() => 'ok', (error) => error.code), 'ENOSPC');
assert.equal(tree.exists('w/copy'), false);

console.log('n18-storage-admission: ok');
