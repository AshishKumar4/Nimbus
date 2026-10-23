#!/usr/bin/env bun
// An async read takes its barrier before it answers: what the sync view shows
// after it is at least as new as what the read returned, and a read the session
// answers after a barrier reported its file gone does not bring the name back.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import {
  appliedCursor,
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
  const given = typeof overrides === 'function' ? overrides((name, args) => forward(name, args)) : overrides;
  // Every call here is the session's: it grants no read lease (whose async
  // stats are the process's own view; node-read-lease).
  const asked = Object.hasOwn(given, 'fsAcquire') ? {} : {
    fsAcquire: (position, options) => {
      if (options?.lease !== true) return forward('fsAcquire', options === undefined ? [position] : [position, options]);
      const { lease: _lease, ...rest } = options;
      return forward('fsAcquire', [position, rest]);
    },
  };
  const handle = facetSupervisor(authority, { ...asked, ...given });
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
const total = (made) => Object.values(made).reduce((sum, n) => sum + n, 0);

await runScenarios(import.meta.path, {
  async 'a readFile, a stat and an lstat each make one call'() {
    const { probe, log } = await boot();
    const read = await callsOf(log, () => probe.fs.promises.readFile(F, 'utf8'));
    assert.equal(read.value, 'v1');
    assert.equal(total(read.made), 1, `readFile: the barrier, the bytes and the stat together (${JSON.stringify(read.made)})`);
    const stat = await callsOf(log, () => probe.fs.promises.stat(F));
    assert.equal(stat.value.size, 2);
    assert.equal(total(stat.made), 1, `stat (${JSON.stringify(stat.made)})`);
    const lstat = await callsOf(log, () => probe.fs.promises.lstat(F));
    assert.equal(lstat.value.isFile(), true);
    assert.equal(total(lstat.made), 1, `lstat (${JSON.stringify(lstat.made)})`);
  },

  async 'what an async read returned, the sync view shows after it'() {
    const { authority, probe } = await boot();
    await authority.peer.writeFile('home/user/app/f.txt', 'v2');
    await authority.peer.writeFile('home/user/app/g.txt', 'g2');
    assert.equal(await probe.fs.promises.readFile(F, 'utf8'), 'v2', 'the read is the authority\'s');
    assert.equal(probe.read(F), 'v2', 'and the sync view holds it');
    assert.notEqual(probe.read(G), 'g1', 'the barrier that came with it dropped the other stale row');
  },

  async 'a refused read still applies its barrier'() {
    const { authority, probe } = await boot();
    const root = authority.peerAs(CRED_KERNEL);
    await root.mkdir('home/user/app/private', { mode: 0o700 });
    await authority.peer.writeFile('home/user/app/g.txt', 'g2');
    assert.equal(await probe.settle(probe.fs.promises.stat('/home/user/app/private/x')), 'ERR:EACCES', 'the refusal is the read\'s');
    assert.notEqual(probe.read(G), 'g1', 'and the barrier that came with it was applied');
    assert.equal(await probe.settle(probe.fs.promises.readFile('/home/user/app/missing.txt', 'utf8')), 'ERR:ENOENT');
  },

  async 'a read answered after a barrier reported its file gone does not bring the name back'() {
    // The session answers the read's content, which is held while a peer
    // deletes the file and a barrier applies the deletion.
    const h = '/home/user/elsewhere/h.txt';
    const served = Promise.withResolvers();
    const release = Promise.withResolvers();
    let armed = false;
    const { authority, probe } = await boot((forward) => ({
      fsReadBatch: async (...args) => {
        const answer = await forward('fsReadBatch', args);
        if (!armed || !args[0].some((request) => request.path.endsWith('/h.txt') && request.lstat !== true)) return answer;
        armed = false;
        served.resolve();
        await release.promise;
        return answer;
      },
    }));
    // Made after the launch, so the store holds none of its bytes.
    await authority.peer.mkdir('home/user/elsewhere', { mode: 0o755 });
    await authority.peer.writeFile('home/user/elsewhere/h.txt', 'h1');
    armed = true;
    const reading = probe.fs.promises.readFile(h, 'utf8');
    await served.promise;
    await authority.peer.unlink('home/user/elsewhere/h.txt');
    const deleted = authority.rawVfs.revision();
    const resumed = probe.resume();
    await until(() => appliedCursor() >= deleted, 'the barrier applied the deletion');
    release.resolve();
    assert.equal(await reading, 'h1', 'the read is what was there when it was served');
    await resumed;
    assert.equal(probe.fs.existsSync(h), false, 'the sync view has the name gone');
    await probe.resume();
    assert.equal(probe.fs.existsSync(h), false, 'after another barrier too');
  },

  async 'a read whose barrier the cursor passed still teaches the sync view its file'() {
    // The file is made after the launch and before the read, so the read's
    // bytes are the session's to fetch. Its barrier is answered, then an
    // unrelated write moves the cursor past it, and only then do the bytes
    // come back: the sync view has the file the read found.
    const acquired = Promise.withResolvers();
    const release = Promise.withResolvers();
    let armed = false;
    const late = '/home/user/elsewhere/late.txt';
    const { authority, probe } = await boot((forward) => ({
      fsReadBatch: async (...args) => {
        if (armed && args[0].some((request) => request.path.endsWith('/late.txt') && request.lstat !== true)) {
          armed = false;
          acquired.resolve();
          await release.promise;
        }
        return forward('fsReadBatch', args);
      },
    }));
    await authority.peer.mkdir('home/user/elsewhere', { mode: 0o755 });
    await authority.peer.writeFile('home/user/elsewhere/late.txt', 'late');
    armed = true;
    const reading = probe.fs.promises.readFile(late, 'utf8');
    await acquired.promise;
    await authority.peer.writeFile('home/user/app/g.txt', 'g2');
    const unrelated = authority.rawVfs.revision();
    const resumed = probe.resume();
    await until(() => appliedCursor() >= unrelated, 'the barrier applied the unrelated write');
    release.resolve();
    assert.equal(await reading, 'late');
    await resumed;
    assert.equal(probe.fs.existsSync(late), true, 'the sync view has the file the read found');
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
