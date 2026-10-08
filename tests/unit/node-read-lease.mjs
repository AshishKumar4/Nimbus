#!/usr/bin/env bun
// A resident node process's resumption barriers under its read lease: a
// timer asks the session nothing while the lease is trusted, and still sees
// every change another made before it (the change waited for the lease's
// recall, which the process answered first). Red before: every timer's
// callback waited on an fsAcquire round trip (astro: ~2,460 per edit).

import assert from 'node:assert/strict';
import { READ_LEASE_MARGIN_MS, READ_LEASE_TRUST_MS } from '../../packages/core/src/runtime/delegations.ts';
import { withRecall } from '../../packages/core/src/vfs/recall.ts';
import {
  createAuthority,
  facetSupervisor,
  launchResident,
  runScenarios,
  residentDataPlan,
} from './lib/resident-body.mjs';

const F = '/home/user/app/f.txt';

const PROGRAM = `
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "ERR:" + e.code; } };
const resume = () => new Promise((resolve) => setTimeout(resolve, 0));
globalThis.__probe = { fs, read, resume };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

async function boot() {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile('home/user/app/f.txt', 'v1');
  const handle = facetSupervisor(authority);
  await launchResident({
    authority,
    program: PROGRAM,
    env: { SUPERVISOR: handle.supervisor },
    dataPlan: await residentDataPlan(authority, '/home/user/app'),
    cursor: authority.cursor(),
  });
  const probe = globalThis.__probe;
  assert.equal(probe.read(F), 'v1');
  return { authority, probe, log: handle.log };
}

const asked = (log) => log.calls.fsAcquire ?? 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await runScenarios(import.meta.path, {
  async 'timers ask nothing while the read lease is trusted'() {
    const { probe, log } = await boot();
    await probe.resume();
    const before = asked(log);
    for (let i = 0; i < 50; i++) await probe.resume();
    assert.ok(asked(log) - before <= 2, `50 timers asked ${asked(log) - before} times under a trusted lease`);
    assert.ok(globalThis.__nimbusVfsCoherence.leasedBarriers >= 45, `${globalThis.__nimbusVfsCoherence.leasedBarriers} barriers answered by the lease`);
  },

  async "another's change is seen by the next timer, and waited for the process's answer"() {
    const { authority, probe, log } = await boot();
    await probe.resume();
    assert.ok(globalThis.__nimbusProcessFs.readTrusted(), 'the barrier took no lease');
    const recallsBefore = globalThis.__nimbusProcessFs.stats().readRecalls;
    // A writer that is not the process: its write recalls the lease and waits for the answer.
    await withRecall(() => authority.kfs.writeFile('home/user/app/f.txt', 'v2'));
    assert.equal(globalThis.__nimbusProcessFs.stats().readRecalls, recallsBefore + 1, 'the write did not recall the lease');
    assert.equal(globalThis.__nimbusProcessFs.readTrusted(), false);
    const before = asked(log);
    await probe.resume();
    assert.equal(asked(log), before + 1, 'the timer after a recall did not ask');
    assert.equal(probe.read(F), 'v2', 'the timer after another\'s change read the old bytes');
  },

  async 'past its trust, the next timer asks again'() {
    const { probe, log } = await boot();
    await probe.resume();
    const before = asked(log);
    // Its own timer, past the trust (this realm's timers are the process's: barriered too).
    await sleep(READ_LEASE_TRUST_MS + READ_LEASE_MARGIN_MS);
    assert.equal(asked(log), before + 1, 'a timer past the lease\'s trust asked nothing');
    assert.ok(globalThis.__nimbusProcessFs.stats().readConfirms >= 1, 'the barrier did not confirm the lease');
  },
});
