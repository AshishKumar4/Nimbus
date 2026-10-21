#!/usr/bin/env bun
// A resident program ends as Node's does, when it holds no live work, and
// work its filesystem does for it on the session is live work. Here the only
// thing a program waits on is an fs.promises.readFile of a file another
// process just wrote: the barrier the read issues brings the file's bytes
// with it, the store has no room for them until the session grants more, and
// the session takes its time granting. The program must see the file before
// it ends. Before: the store's grant request was not counted, so the process
// found nothing live while it waited and ended, exit 0, its read never
// answered (pi's turn: _acquiredRead, _acquireBarrier, roomForPushed,
// askGrant, fsStorageGrant in flight at its natural exit).

import assert from 'node:assert/strict';
import { createAuthority, facetSupervisor, facetSql, launchResident, sleep, until } from './lib/resident-body.mjs';
import { StorageLedger } from '../../packages/core/src/runtime/storage-ledger.ts';

const SIZE = 1_000_000;
const PROGRAM = `
const fs = require("fs");
setTimeout(() => {
  fs.promises.readFile("/home/user/app/late.txt", "utf8").then(
    (text) => { process.stdout.write("READ " + text.length + "\\n"); },
    (error) => { process.stdout.write("FAILED " + error.code + "\\n"); },
  );
}, 1500);
`;

const authority = createAuthority({ storageKernelReserve: 0 });
authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
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
// Another process writes it: what the program held of the tree is recalled, and its next read asks the session.
await authority.peer.writeFile('home/user/app/late.txt', 'x'.repeat(SIZE));

await until(() => handle.log.exit !== null, 'the process ends', 10_000);
const after = Object.fromEntries(Object.entries(handle.log.calls).map(([name, n]) => [name, n - (bootCalls[name] ?? 0)]).filter(([, n]) => n > 0));
const seen = `calls after boot ${JSON.stringify(after)}, stdout ${JSON.stringify(handle.log.stdout)}, exit ${JSON.stringify(handle.log.exit)}`;
assert.ok(grants > 0, `the barrier's bytes needed a grant, the case this pins: ${seen}`);
assert.match(handle.log.stdout, new RegExp(`^READ ${SIZE}$`, 'm'), `the read is answered before the process ends: ${seen}`);
assert.equal(handle.log.exit.code, 0);
console.log('resident-liveness-store-calls: ok');
