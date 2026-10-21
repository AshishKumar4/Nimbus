#!/usr/bin/env bun
// A resident program ends as Node's does, when it holds no live work, and
// work its filesystem does for it on the session is live work. Here the only
// thing a program waits on is an fs.promises.readFile of a file its store
// does not hold: the session's answer carries the file's bytes, the store
// has no room for them until the session grants more, and the session takes
// its time granting. The program must see the file before it ends. Before:
// the read's own session call was counted, and the store's grant request
// that followed was not, so the process found nothing live while it waited
// and ended, exit 0, its read never answered (pi's turn: _acquiredRead,
// _acquireBarrier, roomForPushed, askGrant, fsStorageGrant in flight at its
// natural exit).

import assert from 'node:assert/strict';
import { createAuthority, facetSupervisor, facetSql, launchResident, sleep, until } from './lib/resident-body.mjs';
import { StorageLedger } from '../../packages/core/src/runtime/storage-ledger.ts';

const SIZE = 1_000_000;
const PROGRAM = `
const fs = require("fs");
setTimeout(() => {
  fs.promises.readFile("/home/user/data/late.txt", "utf8").then(
    (text) => { process.stdout.write("READ " + text.length + "\\n"); },
    (error) => { process.stdout.write("FAILED " + error.code + "\\n"); },
  );
}, 300);
`;

const authority = createAuthority({ storageKernelReserve: 0 });
authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
// Outside the cwd, so the boot does not fill it: the read is the first to ask for it.
authority.kfs.mkdir('home/user/data', { recursive: true, mode: 0o755 });
authority.kfs.writeFile('home/user/data/late.txt', 'x'.repeat(SIZE));
const raw = authority.rawVfs;
raw.ledger = new StorageLedger(raw.sql, { limit: raw.databaseBytes() + 64_000_000, kernelReserve: 0 });
const FACET = 'proc-slot-0';
raw.ledger.fill(FACET, 0);

// The session grants at once while the process boots, and slowly after.
let slow = false;
let grants = 0;
/** @type {(name: string, args: unknown[]) => Promise<unknown>} */
let forward = async () => { throw new Error('forward is not ready'); };
const handle = facetSupervisor(authority, {
  fsStorageGrant: async (...args) => {
    if (slow) { grants++; await sleep(300); }
    return forward('fsStorageGrant', args);
  },
});
forward = handle.forward;

await launchResident({
  authority, sql: facetSql(), program: PROGRAM, env: { SUPERVISOR: handle.supervisor }, cursor: authority.cursor(),
  startArgs: { storage: { facet: FACET, grant: 0 } },
});
slow = true;
const bootCalls = { ...handle.log.calls };

await until(() => handle.log.exit !== null, 'the process ends', 10_000);
const after = Object.fromEntries(Object.entries(handle.log.calls).map(([name, n]) => [name, n - (bootCalls[name] ?? 0)]).filter(([, n]) => n > 0));
const seen = `calls after boot ${JSON.stringify(after)}, stdout ${JSON.stringify(handle.log.stdout)}, exit ${JSON.stringify(handle.log.exit)}`;
assert.ok(grants > 0, `the read's bytes needed a grant, the case this pins: ${seen}`);
assert.match(handle.log.stdout, new RegExp(`^READ ${SIZE}$`, 'm'), `the read is answered before the process ends: ${seen}`);
assert.equal(handle.log.exit.code, 0);
console.log('resident-liveness-store-calls: ok');
