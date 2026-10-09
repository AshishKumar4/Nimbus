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

  async 'after its own write, the next timer asks'() {
    const { probe, log } = await boot();
    await probe.resume();
    await probe.resume();
    assert.ok(globalThis.__nimbusProcessFs.readTrusted(), 'the barrier took no lease');
    probe.fs.writeFileSync(F, 'mine');
    assert.equal(globalThis.__nimbusProcessFs.readTrusted(), false, 'its own write left the lease trusted');
    const before = asked(log);
    await probe.resume();
    assert.equal(asked(log), before + 1, 'the timer after its own write asked nothing');
  },

  async 'async stats and listings are the view\'s under a trusted lease, and the session\'s after a change'() {
    const { authority, probe, log } = await boot();
    await authority.peer.mkdir('home/user/app/sub', { mode: 0o755 });
    await authority.peer.writeFile('home/user/app/sub/a.txt', 'aa');
    await probe.resume();
    await probe.resume();
    assert.ok(globalThis.__nimbusProcessFs.readTrusted(), 'the barrier took no lease');
    const calls = () => Object.values(log.calls).reduce((sum, n) => sum + n, 0);
    const before = calls();
    const names = await probe.fs.promises.readdir('/home/user/app');
    const typed = await probe.fs.promises.readdir('/home/user/app/sub', { withFileTypes: true });
    const stat = await probe.fs.promises.stat('/home/user/app/sub/a.txt');
    const lstat = await probe.fs.promises.lstat('/home/user/app/sub');
    await assert.rejects(probe.fs.promises.stat('/home/user/app/missing'), { code: 'ENOENT', syscall: 'stat' });
    await assert.rejects(probe.fs.promises.readdir('/home/user/app/f.txt'), { code: 'ENOTDIR', syscall: 'scandir' });
    assert.equal(calls() - before, 0, `the session was asked ${JSON.stringify(log.calls)}`);
    assert.ok(globalThis.__nimbusVfsCoherence.leasedReads >= 6);
    // As the session lists and stats them.
    const session = authority.rawVfs.as({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 });
    assert.deepEqual(names, session.readdir('home/user/app').map((entry) => entry.name).sort());
    assert.deepEqual(typed.map((entry) => [entry.name, entry.isFile()]), [['a.txt', true]]);
    const want = session.stat('home/user/app/sub/a.txt');
    assert.deepEqual([stat.size, stat.mode, stat.ino, stat.uid, stat.mtimeMs], [want.size, want.mode, want.ino, want.uid, want.mtime]);
    assert.equal(lstat.isDirectory(), true);
    // Another's change recalls the lease: the listing after it has the new name.
    await authority.peer.writeFile('home/user/app/sub/b.txt', 'b');
    assert.deepEqual((await probe.fs.promises.readdir('/home/user/app/sub')).sort(), ['a.txt', 'b.txt']);
    assert.equal((await probe.fs.promises.stat('/home/user/app/sub/b.txt')).size, 1);
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
