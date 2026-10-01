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
import { createAuthority, facetSupervisor, launchResident, runScenarios, residentDataPlan } from './lib/resident-body.mjs';

const F = '/home/user/app/f.txt';

const PROGRAM = `
const fs = require("fs");
globalThis.__probe = { fs };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

async function boot(overrides = {}) {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile('home/user/app/f.txt', 'v1');
  const handle = facetSupervisor(authority, overrides);
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
    assert.deepEqual(made, { writeFileStat: 1 }, 'the write and its stat together');
    const stat = probe.fs.statSync('/home/user/app/new.txt');
    assert.equal(stat.size, 5, 'the sync view stats the new file');
    assert.equal(stat.uid, 1000, 'owned as the authority made it');
    assert.equal(authority.read('home/user/app/new.txt'), 'fresh');
  },

  async 'a session deployed before writeFileStat is asked for the write and the stat separately'() {
    for (const refusal of [
      'The RPC receiver does not implement the method "writeFileStat".',
      "supervisor op: 'writeFileStat' is not served by this host",
      "supervisor op: 'deliverOnce' names no mutation it can deliver once",
    ]) {
      const { authority, probe, log } = await boot({ writeFileStat: async () => { throw new Error(refusal); } });
      await probe.fs.promises.writeFile(F, 'v2');
      assert.equal(authority.read('home/user/app/f.txt'), 'v2', `the write lands (${refusal})`);
      assert.equal(probe.fs.statSync(F).size, 2, 'and stats');
      const made = await callsOf(log, () => probe.fs.promises.writeFile(F, 'v3'));
      assert.equal(made.writeFileStat, undefined, 'writeFileStat is not asked again');
      assert.equal(made.writeFile, 1, 'the write is its own call');
    }
  },

  async 'a refused write is the write\'s error'() {
    const { probe } = await boot({ writeFileStat: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } });
    const outcome = await probe.fs.promises.writeFile(F, 'v2').then(() => 'written', (error) => error.code);
    assert.equal(outcome, 'EACCES');
  },
});
