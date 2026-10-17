#!/usr/bin/env bun
// An open that creates or truncates is the session's to answer, so it answers
// while the process's namespace cannot (a relist failed, until the next
// boundary repairs it): fs.promises.open(existing, 'w') empties the file and
// writes through it, where a synchronous stat is refused (EAGAIN).
//
// Red before: the open asked the namespace whether the file was there, to
// decide what to keep meanwhile, and that question threw the namespace's
// EAGAIN out of the open.
import assert from 'node:assert/strict';
import { createAuthority, facetSupervisor, launchResident, residentDataPlan } from './lib/resident-body.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';

const PROGRAM = `
const fs = require("fs");
globalThis.__probe = { fs };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

const authority = createAuthority();
authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
authority.kfs.writeFile('home/user/app/existing.txt', 'old content');
authority.kfs.writeFile('home/user/app/other.txt', 'x');
authority.rawVfs.as(CRED_KERNEL).mkdir('home/user/app/locked', { mode: 0o700 });
let listingFails = false;
let forward;
const handle = facetSupervisor(authority, {
  fsList: async (...args) => {
    if (listingFails) throw new Error('Network connection lost.');
    return forward('fsList', args);
  },
});
forward = handle.forward;
await launchResident({
  authority,
  program: PROGRAM,
  env: { SUPERVISOR: handle.supervisor },
  dataPlan: await residentDataPlan(authority, '/home/user'),
  cursor: authority.cursor(),
});
const { fs } = globalThis.__probe;

// The directory becomes searchable; the barrier that reports it relists it, and that relist fails.
await authority.peerAs(CRED_KERNEL).chmod('home/user/app/locked', 0o755);
listingFails = true;
await fs.promises.stat('/home/user/app/other.txt');
assert.throws(() => fs.statSync('/home/user/app/existing.txt'), (e) => e.code === 'EAGAIN', 'premise: the namespace is not answering');

const h = await fs.promises.open('/home/user/app/existing.txt', 'w');
await h.write('new');
await h.close();
listingFails = false;
assert.equal(await fs.promises.readFile('/home/user/app/existing.txt', 'utf8'), 'new', 'the open emptied the file, the write landed');
assert.equal(new TextDecoder().decode(authority.kfs.readFile('home/user/app/existing.txt')), 'new');
console.log('node-open-namespace-relisting: an open that truncates answers while the namespace relists');
