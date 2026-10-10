#!/usr/bin/env bun
// A resident node process's resumption barriers under its read lease: a
// timer asks the session nothing while the lease is trusted, and still sees
// every change another made before it (the change waited for the lease's
// recall, which the process answered first). Red before: every timer's
// callback waited on an fsAcquire round trip (astro: ~2,460 per edit).

import assert from 'node:assert/strict';
import { READ_LEASE_MARGIN_MS, READ_LEASE_TRUST_MS } from '../../packages/core/src/runtime/delegations.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { withRecall } from '../../packages/core/src/vfs/recall.ts';
import { asyncMemoryVfs } from './lib/async-memory-vfs.mjs';
import {
  CRED,
  createAuthority,
  facetSupervisor,
  launchResident,
  runScenarios,
  residentDataPlan,
  sleep as rawSleep,
} from './lib/resident-body.mjs';

const F = '/home/user/app/f.txt';

const PROGRAM = `
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "ERR:" + e.code; } };
const resume = () => new Promise((resolve) => setTimeout(resolve, 0));
globalThis.__probe = { fs, read, resume };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

/** Booted (`program`); `prepare` runs before the launch, with the process's pid; `overrides`, the supervisor calls a test answers itself. */
async function boot(prepare, overrides, program = PROGRAM) {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile('home/user/app/f.txt', 'v1');
  const handle = facetSupervisor(authority, overrides);
  await prepare?.(authority, handle.log.pid);
  await launchResident({
    authority,
    program,
    env: { SUPERVISOR: handle.supervisor },
    dataPlan: await residentDataPlan(authority, '/home/user/app'),
    cursor: authority.cursor(),
  });
  const probe = globalThis.__probe;
  assert.equal(probe.read(F), 'v1');
  return { authority, probe, log: handle.log };
}

/** Booted (`prepare`), `seed` made, then holding a trusted read lease (past the hold-off a recall leaves). */
async function bootTrusted(seed, prepare) {
  const booted = await boot(prepare);
  await seed?.(booted.authority);
  await rawSleep(READ_LEASE_TRUST_MS + 20);
  await booted.probe.resume();
  await booted.probe.resume();
  assert.ok(globalThis.__nimbusProcessFs.readTrusted(), 'the barrier took no lease');
  return booted;
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
    // Past the hold-off a recall leaves (the process is leased nothing for a trust's length).
    await rawSleep(READ_LEASE_TRUST_MS + 20);
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
    assert.deepEqual([stat.size, stat.mode & 0o7777, stat.ino, stat.uid, stat.mtimeMs], [want.size, want.mode & 0o7777, want.ino, want.uid, want.mtime]);
    assert.equal(lstat.isDirectory(), true);
    // Another's change recalls the lease: the listing after it has the new name.
    await authority.peer.writeFile('home/user/app/sub/b.txt', 'b');
    assert.deepEqual((await probe.fs.promises.readdir('/home/user/app/sub')).sort(), ['a.txt', 'b.txt']);
    assert.equal((await probe.fs.promises.stat('/home/user/app/sub/b.txt')).size, 1);
  },

  async 'the kernel\'s mounts and the root\'s names are the session\'s under a trusted lease, through a link too'() {
    const { probe } = await bootTrusted((authority) => authority.peer.symlink('/dev/null', 'home/user/app/null'));
    // A character device, as the session's /dev says (the view lists no /dev).
    const device = (stat) => stat.mode & 0o170000;
    assert.equal(device(await probe.fs.promises.stat('/dev/null')), 0o020000);
    assert.equal(device(await probe.fs.promises.stat('/home/user/app/null')), 0o020000);
    assert.ok((await probe.fs.promises.readdir('/')).includes('dev'));
  },

  async 'a mount the launch listed is the session\'s under a trusted lease: the lease vouches for SQLite alone'() {
    const drive = asyncMemoryVfs();
    const bytes = (text) => new TextEncoder().encode(text);
    await drive.writeFile('/f', bytes('one'));
    const { probe } = await bootTrusted(undefined, (authority, pid) => {
      authority.files.vfs.mount('/m', drive);
      authority.files.nameLaunch({ pid, cred: CRED }, () => ['/m/f']);
    });
    assert.equal(probe.fs.statSync('/m/f').size, 3, 'the launch did not list the mount');
    await drive.writeFile('/f', bytes('three'));
    await drive.writeFile('/g', bytes('g'));
    assert.equal((await probe.fs.promises.stat('/m/f')).size, 5, 'the view answered for the mount');
    assert.deepEqual((await probe.fs.promises.readdir('/m')).sort(), ['f', 'g'], 'the view listed the mount');
  },

  async 'a gated process\'s request out waits for what it wrote to be published; an answer that upgrades ends its gate'() {
    const out = [];
    const { authority, probe } = await boot((authority, pid) => {
      authority.files.holdOutput(authority.host.processes);
      authority.files.continueAtCommit(pid);
    }, {
      routeLoopback: async (port, request) => {
        out.push(new URL(request.url).pathname);
        // An upgrade hands the process a socket no gate of the session's sees.
        return out.at(-1) === '/upgrade' ? Object.defineProperty(new Response(null), 'webSocket', { value: {} }) : new Response('ok');
      },
    });
    // Another process reads under its lease, which the process's write meets.
    const reader = authority.files.bind({ pid: 99, cred: CRED });
    const leased = () => reader.acquire(authority.rawVfs.epoch, authority.rawVfs.revision(), { lease: true }).readLease;
    // Raw timers: a program's timer takes a barrier first, which waits for the process's own writes in flight.
    const flushed = () => Promise.race([globalThis.__nimbusProcessFs.flush().then(() => 'answered'), rawSleep(200).then(() => 'waiting')]);
    let lease = leased();
    probe.fs.writeFileSync(F, 'v2');
    assert.equal(await flushed(), 'answered', 'a gated write was not answered at its commit');
    const sent = fetch('http://localhost:4321/');
    await rawSleep(50);
    assert.deepEqual(out, [], 'its request left before what it wrote was published');
    reader.recalled(lease.owner, 'revoke');
    assert.equal(await (await sent).text(), 'ok');
    assert.equal(new TextDecoder().decode(reader.readFile(F)), 'v2');
    await fetch('http://localhost:4321/upgrade');
    await rawSleep(READ_LEASE_TRUST_MS + 20);
    lease = leased();
    assert.ok(lease, 'no lease to meet');
    probe.fs.writeFileSync(F, 'v3');
    assert.equal(await flushed(), 'waiting', 'a process handed a raw socket was answered before its publication');
    reader.recalled(lease.owner, 'revoke');
    await globalThis.__nimbusProcessFs.flush();
  },

  async 'a gated process\'s first raw socket, opened before it wrote anything, ends its gate'() {
    const { authority, probe } = await boot((authority, pid) => {
      authority.files.holdOutput(authority.host.processes);
      authority.files.continueAtCommit(pid);
    }, undefined, `require("tls").connect({ host: "127.0.0.1", port: 9 }).on("error", () => {});\n${PROGRAM}`);
    const reader = authority.files.bind({ pid: 99, cred: CRED });
    const { readLease } = reader.acquire(authority.rawVfs.epoch, authority.rawVfs.revision(), { lease: true });
    assert.ok(readLease, 'no lease to meet');
    probe.fs.writeFileSync(F, 'v2');
    const flushed = await Promise.race([globalThis.__nimbusProcessFs.flush().then(() => 'answered'), rawSleep(200).then(() => 'waiting')]);
    assert.equal(flushed, 'waiting', 'a process with a raw socket opened before it wrote was answered before its publication');
    reader.recalled(readLease.owner, 'revoke');
    await globalThis.__nimbusProcessFs.flush();
  },

  async 'a look at the kernel\'s mounts, which no barrier reports, leaves timers to the lease'() {
    const { probe, log } = await bootTrusted();
    probe.fs.existsSync('/dev/null');
    probe.fs.existsSync('/proc/self');
    const before = asked(log);
    for (let i = 0; i < 10; i++) await probe.resume();
    assert.ok(asked(log) - before <= 1, `10 timers asked ${asked(log) - before} times after a look at /dev and /proc`);
  },

  async 'a synchronous write to the session\'s stores after skipped barriers is in the next timer\'s reads, of / and under /.nimbus'() {
    const { authority, probe, log } = await bootTrusted();
    const before = asked(log);
    for (let i = 0; i < 3; i++) await probe.resume();
    assert.equal(asked(log), before, 'a barrier under the trusted lease asked');
    // As a launch writes the session's stores: synchronously, never refused.
    const kernel = authority.rawVfs.as(CRED_KERNEL);
    kernel.mkdir('.nimbus/images', { recursive: true, mode: 0o755 });
    kernel.writeFile('.nimbus/images/x', 'x');
    // Published once the process answered the recall: another's read waits for it.
    await authority.peer.readFile('.nimbus/images/x');
    await probe.resume();
    assert.ok(probe.fs.readdirSync('/').includes('.nimbus'), 'the root listing missed a store made since');
    assert.deepEqual(probe.fs.readdirSync('/.nimbus/images'), ['x'], 'the store\'s listing missed a file written since');
    assert.deepEqual(await probe.fs.promises.readdir('/.nimbus/images'), ['x']);
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
