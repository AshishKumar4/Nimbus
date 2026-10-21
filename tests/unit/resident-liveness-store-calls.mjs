#!/usr/bin/env bun
// A resident program ends as Node's does, when it holds no live work, and
// work its filesystem does for it on the session is live work. Here the only
// thing a program waits on is an fs.promises.readFile in a directory that has
// just become searchable: the barrier the read issues brings the change, and
// the store lists the directory again from the session before it answers.
// The session takes its time with that listing. The program must see the
// file before it ends. Before: the store's listing was not counted, so the
// process found nothing live while it waited and ended, exit 0, its read
// never answered (pi's turn, under a store whose writes did not slow the
// loop).

import assert from 'node:assert/strict';
import { createAuthority, facetSupervisor, facetSql, launchResident, sleep, until } from './lib/resident-body.mjs';

const PROGRAM = `
const fs = require("fs");
setTimeout(() => {
  fs.promises.readFile("/home/user/app/locked/late.txt", "utf8").then(
    (text) => { process.stdout.write("READ " + text.length + "\\n"); },
    (error) => { process.stdout.write("FAILED " + error.code + "\\n"); },
  );
}, 150);
`;

const authority = createAuthority({ storageKernelReserve: 0 });
authority.kfs.mkdir('home/user/app/locked', { recursive: true, mode: 0o755 });
authority.kfs.writeFile('home/user/app/locked/late.txt', 'x'.repeat(20_000));
// Not searchable when the process starts: its names are not the process's to list.
authority.kfs.chmod('home/user/app/locked', 0o600);

// The session lists at once while the process boots, and slowly after.
let slow = false;
let lists = 0;
/** @type {(name: string, args: unknown[]) => Promise<unknown>} */
let forward = async () => { throw new Error('forward is not ready'); };
const handle = facetSupervisor(authority, {
  fsList: async (...args) => {
    if (slow) { lists++; await sleep(300); }
    return forward('fsList', args);
  },
});
forward = handle.forward;

await launchResident({
  authority, sql: facetSql(), program: PROGRAM, env: { SUPERVISOR: handle.supervisor }, cursor: authority.cursor(),
});
slow = true;
await authority.peer.chmod('home/user/app/locked', 0o755);

await until(() => handle.log.exit !== null, 'the process ends', 10_000);
assert.ok(lists > 0, 'the store listed the directory again after the process started: the case this pins');
assert.match(handle.log.stdout, /^READ 20000$/m, `the read is answered before the process ends: stdout ${JSON.stringify(handle.log.stdout)}, exit ${JSON.stringify(handle.log.exit)}`);
assert.equal(handle.log.exit.code, 0);
console.log('resident-liveness-store-calls: ok');
