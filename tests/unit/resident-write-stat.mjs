#!/usr/bin/env bun
// An async writeFile learns the path's stat from the write's own answer.
//
// After an async whole-file write the sync view keeps the authority's stat of
// the path (its owner and mode, which the process cannot know), and asked for
// it in a second call to the session, ~8 ms on Cloudflare after a write of
// ~32 ms (measured on a throwaway, 2026-10-01). writeFileStat answers the
// revision and the stat the write left. A session deployed before it is asked
// for the write and the stat separately.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createAuthority, facetSupervisor, launchResident, runScenarios, residentDataPlan, until } from './lib/resident-body.mjs';

const F = '/home/user/app/f.txt';

// \`resume\`: a timer, whose resumption takes a barrier before it runs.
const PROGRAM = `
const fs = require("fs");
globalThis.__probe = { fs, resume: () => new Promise((resolve) => setTimeout(resolve, 0)) };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

/** \`overrides\` may be a function of the session's own answer to an op (facetSupervisor's \`forward\`). */
async function boot(overrides = {}, seed = () => {}) {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile('home/user/app/f.txt', 'v1');
  seed(authority);
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
  return { authority, probe: globalThis.__probe, log: handle.log };
}

async function callsOf(log, run) {
  const before = { ...log.calls };
  await run();
  const made = {};
  for (const [name, n] of Object.entries(log.calls)) if (n !== (before[name] ?? 0)) made[name] = n - (before[name] ?? 0);
  return made;
}

await runScenarios(import.meta.path, {
  async 'an async writeFile is one call, and the sync view has its stat'() {
    const { authority, probe, log } = await boot();
    const made = await callsOf(log, () => probe.fs.promises.writeFile('/home/user/app/new.txt', 'fresh'));
    // The process's first write opens its writer epoch; the write is one wave, its receipt the stat.
    assert.deepEqual(made, { openWaveWriter: 1, writeBatchStream: 1 }, 'the write and its stat together');
    const again = await callsOf(log, () => probe.fs.promises.writeFile('/home/user/app/other.txt', 'again'));
    assert.deepEqual(again, { writeBatchStream: 1 }, 'and the next write is one call');
    const stat = probe.fs.statSync('/home/user/app/new.txt');
    assert.equal(stat.size, 5, 'the sync view stats the new file');
    assert.equal(stat.uid, 1000, 'owned as the authority made it');
    assert.equal(authority.read('home/user/app/new.txt'), 'fresh');
  },

  async 'a file the process overwrote without having listed it keeps its owner'() {
    // Created by root after the launch, so the process's namespace has never
    // named it, and its write took it for a new file of its own.
    const { authority, probe } = await boot();
    const root = authority.rawVfs.as(CRED_KERNEL);
    root.writeFile('home/user/app/shared.txt', 'root');
    root.chmod('home/user/app/shared.txt', 0o666);
    await probe.fs.promises.writeFile('/home/user/app/shared.txt', 'ours');
    const stat = probe.fs.statSync('/home/user/app/shared.txt');
    assert.equal(stat.uid, 0, 'the authority kept root as the owner');
    assert.equal(stat.mode & 0o777, 0o666, 'and its mode');
    assert.equal(stat.size, 4);
  },

  async 'a write answered without a stat asks for the stat separately'() {
    // A mount whose metadata read failed after the write committed.
    const { probe, log } = await boot((forward) => ({
      writeBatchStream: async (...args) => ({ ...(await forward('writeBatchStream', args)), receipts: [] }),
    }));
    const made = await callsOf(log, () => probe.fs.promises.writeFile('/home/user/app/new.txt', 'fresh'));
    assert.equal(made.writeBatchStream, 1, 'the write is answered');
    assert.equal(made.fsReadBatch, 1, 'and its stat asked for');
    assert.equal(probe.fs.statSync('/home/user/app/new.txt').size, 5);
  },

  async 'a write answered after a barrier reported its name gone does not bring the name back'() {
    // The session wrote and answered, and the answer is held while a peer
    // deletes the file and a barrier applies the deletion: the stat in the
    // answer predates it.
    const served = Promise.withResolvers();
    const release = Promise.withResolvers();
    const { authority, probe } = await boot((forward) => ({
      writeBatchStream: async (...args) => {
        const answer = await forward('writeBatchStream', args);
        served.resolve();
        await release.promise;
        return answer;
      },
    }));
    const writing = probe.fs.promises.writeFile(F, 'mine');
    await served.promise;
    authority.kfs.unlink('home/user/app/f.txt');
    const deleted = authority.rawVfs.revision();
    const resumed = probe.resume();
    await until(() => globalThis.__nimbusVfsCursor.rev >= deleted, 'the barrier applied the deletion');
    release.resolve();
    await writing;
    await resumed;
    assert.equal(probe.fs.existsSync(F), false, 'the sync view has the name gone');
    await probe.resume();
    assert.equal(probe.fs.existsSync(F), false, 'after another barrier too');
    assert.equal(authority.kfs.exists('home/user/app/f.txt'), false);
  },

  async 'a write through a symlink leaves the link resolving to the file it names'() {
    const { authority, probe } = await boot({}, (seeded) => {
      seeded.kfs.writeFile('home/user/app/target.txt', 'old');
      seeded.kfs.symlink('target.txt', 'home/user/app/link.txt');
    });
    const link = '/home/user/app/link.txt';
    await probe.fs.promises.writeFile(link, 'fresh');
    assert.equal(probe.fs.statSync(link).isFile(), true, 'the link stats as a file');
    assert.equal(probe.fs.readFileSync(link, 'utf8'), 'fresh');
    await probe.resume();
    assert.equal(probe.fs.statSync(link).isFile(), true, 'after a barrier too');
    assert.equal(authority.read('home/user/app/target.txt'), 'fresh', 'the authority wrote the file the link names');
  },

  async 'a refused write is the write\'s error'() {
    // The session's refusal of the call, as its wave answers it.
    const { probe, authority } = await boot({}, (seeded) => {
      seeded.rawVfs.as(CRED_KERNEL).chown('home/user/app/f.txt', 0, 0);
      seeded.rawVfs.as(CRED_KERNEL).chmod('home/user/app/f.txt', 0o644);
    });
    void authority;
    const outcome = await probe.fs.promises.writeFile(F, 'v2').then(() => 'written', (error) => error.code);
    assert.equal(outcome, 'EACCES');
  },
});
