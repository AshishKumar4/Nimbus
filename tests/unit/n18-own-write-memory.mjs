#!/usr/bin/env bun
// N18 near the limit. A node process's own write that its facet store has no
// room to hold is kept in the process's heap, within FACET_OWN_WRITE_MEMORY_BYTES
// (the store admission's pin), so write-then-read still works. Past that bound
// a write is refused with ENOSPC, and a sync read of a write it could not keep
// says so: ENOSPC, naming the async form. It is never a bare EAGAIN.

import assert from 'node:assert/strict';
import { createAuthority, facetSupervisor, launchResident, facetSql } from './lib/resident-body.mjs';
import { StorageLedger } from '../../packages/core/src/runtime/storage-ledger.ts';
import { FACET_OWN_WRITE_MEMORY_BYTES } from '../../packages/platform/src/limits.ts';

const PROGRAM = `
const fs = require("fs");
let seed = 7;
const bytes = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) >>> 0; b[i] = seed >>> 24; } return b; };
globalThis.__probe = {
  write: (p, n) => { try { const b = bytes(n); fs.writeFileSync(p, b); return b.subarray(0, 8).toString("hex"); } catch (e) { return e.code; } },
  read: (p) => { try { return fs.readFileSync(p).subarray(0, 8).toString("hex"); } catch (e) { return e.code; } },
  settle: () => new Promise((r) => setTimeout(r, 20)),
};
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

const authority = createAuthority({ storageKernelReserve: 0 });
authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
const raw = authority.rawVfs;
raw.ledger = new StorageLedger(raw.sql, { limit: raw.databaseBytes() + 4 * FACET_OWN_WRITE_MEMORY_BYTES, kernelReserve: 0 });
// The facet's store is at its allowance: every grant it asks for is refused,
// while the session itself still has room for the writes.
const handle = facetSupervisor(authority, { fsStorageGrant: async () => ({ granted: 0 }) });
const FACET = 'proc-slot-0';
raw.ledger.fill(FACET, 64 * 1024);
await launchResident({
  authority, sql: facetSql(), program: PROGRAM, env: { SUPERVISOR: handle.supervisor }, cursor: authority.cursor(),
  startArgs: { storage: { facet: FACET, grant: 64 * 1024 } },
});
const probe = globalThis.__probe;
const MB = 1024 * 1024;

// Within the heap budget: each write reads back.
const first = probe.write('/home/user/app/a', MB);
assert.equal(probe.read('/home/user/app/a'), first);
const second = probe.write('/home/user/app/b', 2 * MB);
assert.equal(probe.read('/home/user/app/b'), second);
await probe.settle();
assert.ok(authority.kfs.exists('home/user/app/a'), 'the session holds it');
assert.equal(probe.read('/home/user/app/a'), first, 'still readable after the write-back');

// Past the budget: a write the process can no longer keep is refused as no space, and says so.
const big = FACET_OWN_WRITE_MEMORY_BYTES - MB;
probe.write('/home/user/app/c', big);
assert.equal(probe.read('/home/user/app/a'), first, 'the write within the budget stays readable');
assert.equal(probe.read('/home/user/app/b'), 'ENOSPC');
// Larger than the whole budget: never held, and said so.
probe.write('/home/user/app/huge', FACET_OWN_WRITE_MEMORY_BYTES + MB);
// (Until its write-back lands, the decided bytes serve it.)
await probe.settle();
assert.equal(probe.read('/home/user/app/huge'), 'ENOSPC');

await Bun.write(Bun.stdout, 'n18-own-write-memory: ok\n');
