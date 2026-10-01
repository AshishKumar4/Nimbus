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
  until,
} from './lib/resident-body.mjs';

const F = '/home/user/app/f.txt';
const G = '/home/user/app/g.txt';

// \`resume\`: a timer, whose resumption takes a barrier before it runs.
const PROGRAM = `
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "ERR:" + e.code; } };
const settle = (promise) => promise.then((value) => value, (error) => "ERR:" + error.code);
const resume = () => new Promise((resolve) => setTimeout(resolve, 0));
globalThis.__probe = { fs, read, settle, resume };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

/** \`overrides\` may be a function of the session's own answer to an op (facetSupervisor's \`forward\`). */
async function boot(overrides = {}, seed = () => {}) {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  seed(authority);
  authority.kfs.writeFile('home/user/app/f.txt', 'v1');
  authority.kfs.writeFile('home/user/app/g.txt', 'g1');
  let forward;
  const handle = facetSupervisor(authority, typeof overrides === 'function' ? overrides((name, args) => forward(name, args)) : overrides);
  forward = handle.forward;
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
    // Each refusal an older deployment gives: its SupervisorRPC lacks the
    // method, its host lacks the op, or its host refuses the op's read id.
    for (const refusal of [
      'The RPC receiver does not implement the method "fsAcquired".',
      "supervisor op: 'fsAcquired' is not served by this host",
      "supervisor op: 'fsAcquired' is not a read, so it cannot carry a read id",
    ]) {
      const { authority, probe, log } = await boot({ fsAcquired: async () => { throw new Error(refusal); } });
      authority.kfs.writeFile('home/user/app/f.txt', 'v2');
      assert.equal(await probe.fs.promises.readFile(F, 'utf8'), 'v2', `readFile still reads (${refusal})`);
      assert.equal((await probe.fs.promises.stat(F)).size, 2, 'stat still stats');
      const later = await callsOf(log, () => probe.fs.promises.stat(F));
      assert.equal(later.made.fsAcquired, undefined, 'and fsAcquired is not asked again');
      assert.equal(later.made.fsAcquire, 1, 'the barrier is asked on its own');
    }
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

  async 'a read answered after a barrier reported its file gone does not bring the name back'() {
    // The session read the file and its stat, and the answer is held while a
    // peer deletes the file and a barrier applies the deletion.
    const served = Promise.withResolvers();
    const release = Promise.withResolvers();
    let armed = false;
    const { authority, probe } = await boot((forward) => ({
      fsReadBatch: async (...args) => {
        const answer = await forward('fsReadBatch', args);
        if (!armed) return answer;
        armed = false;
        served.resolve();
        await release.promise;
        return answer;
      },
    }));
    armed = true;
    const reading = probe.fs.promises.readFile(G, 'utf8');
    await served.promise;
    authority.kfs.unlink('home/user/app/g.txt');
    const deleted = authority.rawVfs.revision();
    const resumed = probe.resume();
    await until(() => globalThis.__nimbusVfsCursor.rev >= deleted, 'the barrier applied the deletion');
    release.resolve();
    assert.equal(await reading, 'g1', 'the read is what was there when it was served');
    await resumed;
    assert.equal(probe.fs.existsSync(G), false, 'the sync view has the name gone');
    await probe.resume();
    assert.equal(probe.fs.existsSync(G), false, 'after another barrier too');
  },

  async 'an async read through a symlink leaves the link resolving to the file it names'() {
    // f.txt and g.txt are written after the link, so its row is older than
    // the cursor the process starts at.
    const { probe } = await boot({}, (seeded) => {
      seeded.kfs.writeFile('home/user/app/target.txt', 'old');
      seeded.kfs.symlink('target.txt', 'home/user/app/link.txt');
    });
    const link = '/home/user/app/link.txt';
    assert.equal(await probe.fs.promises.readFile(link, 'utf8'), 'old');
    assert.equal(probe.fs.lstatSync(link).isSymbolicLink(), true, 'the link is still a link');
    assert.equal(probe.fs.statSync(link).isFile(), true, 'and stats as the file it names');
    assert.equal(probe.read(link), 'old');
  },
});
