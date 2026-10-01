#!/usr/bin/env bun
// An async read takes its barrier with it: one call to the session where it
// was two (a stat) or three (a readFile, with its stat for the sync view).
//
// Every async fs read applies an ACQUIRE first, so what the sync view shows
// afterwards is at least as new as what the read returned. Each was its own
// round trip, measured at 7-8 ms on a throwaway (2026-10-01) while the
// session's own work took under a millisecond. fsAcquired answers the barrier
// and the read together; the process applies the barrier before it uses the
// value, and before it throws when the read was refused.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import {
  createAuthority,
  facetSupervisor,
  launchResident,
  runScenarios,
  residentDataPlan,
} from './lib/resident-body.mjs';

const F = '/home/user/app/f.txt';
const G = '/home/user/app/g.txt';

const PROGRAM = `
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "ERR:" + e.code; } };
const settle = (promise) => promise.then((value) => value, (error) => "ERR:" + error.code);
globalThis.__probe = { fs, read, settle };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

async function boot(overrides = {}) {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile('home/user/app/f.txt', 'v1');
  authority.kfs.writeFile('home/user/app/g.txt', 'g1');
  const handle = facetSupervisor(authority, overrides);
  await launchResident({
    authority,
    program: PROGRAM,
    env: { SUPERVISOR: handle.supervisor },
    dataPlan: await residentDataPlan(authority, '/home/user/app'),
    cursor: authority.cursor(),
  });
  const probe = globalThis.__probe;
  assert.equal(probe.read(F), 'v1', 'the boot fill holds the file');
  return { authority, probe, log: handle.log, forward: handle.forward };
}

/** The supervisor calls `run` made, by name. */
async function callsOf(log, run) {
  const before = { ...log.calls };
  const value = await run();
  const made = {};
  for (const [name, n] of Object.entries(log.calls)) if (n !== (before[name] ?? 0)) made[name] = n - (before[name] ?? 0);
  return { value, made };
}

await runScenarios(import.meta.path, {
  async 'a readFile, a stat and an lstat each make one call'() {
    const { probe, log } = await boot();
    const read = await callsOf(log, () => probe.fs.promises.readFile(F, 'utf8'));
    assert.equal(read.value, 'v1');
    assert.deepEqual(read.made, { fsAcquired: 1 }, 'readFile: the barrier, the bytes and the stat together');
    const stat = await callsOf(log, () => probe.fs.promises.stat(F));
    assert.equal(stat.value.size, 2);
    assert.deepEqual(stat.made, { fsAcquired: 1 }, 'stat');
    const lstat = await callsOf(log, () => probe.fs.promises.lstat(F));
    assert.equal(lstat.value.isFile(), true);
    assert.deepEqual(lstat.made, { fsAcquired: 1 }, 'lstat');
  },

  async 'what an async read returned, the sync view shows after it'() {
    const { authority, probe } = await boot();
    authority.kfs.writeFile('home/user/app/f.txt', 'v2');
    authority.kfs.writeFile('home/user/app/g.txt', 'g2');
    assert.equal(await probe.fs.promises.readFile(F, 'utf8'), 'v2', 'the read is the authority\'s');
    assert.equal(probe.read(F), 'v2', 'and the sync view holds it');
    assert.notEqual(probe.read(G), 'g1', 'the barrier that came with it dropped the other stale row');
  },

  async 'a refused read still applies its barrier'() {
    const { authority, probe } = await boot();
    const root = authority.rawVfs.as(CRED_KERNEL);
    root.mkdir('home/user/app/private', { mode: 0o700 });
    authority.kfs.writeFile('home/user/app/g.txt', 'g2');
    assert.equal(await probe.settle(probe.fs.promises.stat('/home/user/app/private/x')), 'ERR:EACCES', 'the refusal is the read\'s');
    assert.notEqual(probe.read(G), 'g1', 'and the barrier that came with it was applied');
    assert.equal(await probe.settle(probe.fs.promises.readFile('/home/user/app/missing.txt', 'utf8')), 'ERR:ENOENT');
  },

  async 'a session deployed before fsAcquired is asked for the barrier and the read separately'() {
    const { authority, probe, log } = await boot({
      fsAcquired: async () => { throw new Error('The RPC receiver does not implement the method "fsAcquired".'); },
    });
    authority.kfs.writeFile('home/user/app/f.txt', 'v2');
    assert.equal(await probe.fs.promises.readFile(F, 'utf8'), 'v2', 'readFile still reads');
    assert.equal((await probe.fs.promises.stat(F)).size, 2, 'stat still stats');
    const later = await callsOf(log, () => probe.fs.promises.stat(F));
    assert.equal(later.made.fsAcquired, undefined, 'and fsAcquired is not asked again');
    assert.equal(later.made.fsAcquire, 1, 'the barrier is asked on its own');
  },

  async 'a session that answers no barrier with the read is asked for one'() {
    let forward;
    const { authority, probe, log, forward: f } = await boot({
      fsAcquired: async (...args) => ({ ...(await forward('fsAcquired', args)), acquired: undefined }),
    });
    forward = f;
    authority.kfs.writeFile('home/user/app/g.txt', 'g2');
    const stat = await callsOf(log, () => probe.fs.promises.stat(F));
    assert.equal(stat.made.fsAcquire, 1, 'the barrier is asked on its own');
    assert.notEqual(probe.read(G), 'g1', 'and applied');
  },
});
