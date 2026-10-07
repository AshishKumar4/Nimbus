#!/usr/bin/env bun
// A realm's transport (packages/core/src/runtime/realm.ts, realm-guest.ts)
// against guests that misbehave, through startRealm, as a thread and as a
// process, under Bun (source) and Node (dist: rebuild first). The guests are
// in lib/realm-guests/.
//
//   frames    a guest that announces a 4 GiB frame and trickles bytes is
//             ended at once, and the host keeps none of them; a frame split
//             into pieces of 1 to 7 bytes arrives whole, in order;
//   env       a guest sees none of the host's environment, and a process
//             guest loads no .env and no bunfig preload from where it runs;
//   spawn     a realm whose process cannot be started ends, with the reason;
//   orphan    a process guest whose host is killed before the guest has
//             started ends by itself;
//   group     ending a process realm ends every process it started, and its
//             end does not wait for one that left its group;
//   async     a call whose answer waits for a later call of the guest's own
//             is answered (the guest does not block on the first);
//   signal    a process guest a signal ends ends with 128 + the signal's
//             number, as a shell reports it (signals.ts, every signal).
//
// Each case runs in a process of its own (CASE=<name>), so one that hangs or
// leaves processes behind fails alone.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const underBun = typeof process.versions.bun === 'string';
const CASES = ['frames', 'env', 'spawn', 'orphan', 'group', 'async', 'signal'];

if (process.env.CASE === undefined) {
  const failed = [];
  for (const [engine, args] of [['bun', []], ['node', ['--no-warnings']]]) {
    for (const name of CASES) {
      const child = spawnSync(engine, [...args, fileURLToPath(import.meta.url)], { env: { ...process.env, CASE: name }, encoding: 'utf8', timeout: 60_000 });
      const passed = child.status === 0 && child.stdout.includes(`case ${name} ok`);
      console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${engine} ${name}${passed ? '' : `: status ${child.status} ${child.signal ?? ''}\n${(child.stdout + child.stderr).slice(-1500)}`}`);
      if (!passed) failed.push(`${engine} ${name}`);
    }
  }
  assert.deepEqual(failed, [], 'every case passed');
  console.log('ok - realm-transport (bounded frames, no host env, failed spawn, orphans, process groups, async calls; under Bun and Node)');
  process.exit(0);
}

const { startRealm } = await import(underBun ? '../../packages/core/src/runtime/realm.ts' : '../../packages/core/dist/runtime/realm.js');
const guest = (name) => new URL(`./lib/realm-guests/${name}.mjs`, import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** `promise`, or a rejection after `ms`; the timer goes with it. */
const within = (promise, ms, what) => {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not settled after ${ms} ms`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};
/** Starts `entry` as a realm; its events gathered, `serve` answering its calls. */
async function start(entry, isolation, { payload = null, serve = () => null } = {}) {
  const events = [];
  const realm = await startRealm({ entry, isolation, payload, serve, onEvent: (event) => events.push(event) });
  assert.ok(!('unavailable' in realm), `a ${isolation} realm starts`);
  return { realm, events };
}
const nextEvent = async (events, what) => {
  for (let i = 0; i < 200 && events.length === 0; i++) await sleep(25);
  assert.ok(events.length > 0, `${what}: an event arrived`);
  return events[0];
};
/** The live processes whose cmdline names `fragment`, with their process group. */
function processesNaming(fragment) {
  const out = [];
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
      if (!cmdline.includes(fragment)) continue;
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      out.push({ pid: Number(pid), pgid: Number(stat[2]), state: stat[0] });
    } catch { /* it ended */ }
  }
  return out.filter((entry) => entry.state !== 'Z');
}
const alive = (pid) => {
  try {
    const state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[0];
    return state !== 'Z';
  } catch {
    return false;
  }
};

switch (process.env.CASE) {
case 'frames': {
  // A 4 GiB announcement, then bytes trickling: ended at once, nothing kept.
  const rss = () => process.memoryUsage().rss;
  const before = rss();
  const { realm } = await start(guest('hostile'), 'process');
  const end = await within(realm.ended, 3_000, 'a guest announcing a 4 GiB frame');
  assert.match(String(end.failure?.message), /frame of 4294967295 bytes/, `it ended for its frame: ${end.failure?.message}`);
  assert.ok(rss() - before < 64 * 1024 * 1024, `the host kept none of it (${Math.round((rss() - before) / 1048576)} MiB)`);

  // A frame in pieces of 1 to 7 bytes, then another: both, whole, in order.
  const { realm: split, events } = await start(guest('partial'), 'process');
  await within(split.ended, 10_000, 'the guest sending pieces');
  assert.deepEqual(events.map((event) => (event.length > 10 ? `${event[0]} x${event.length}` : event)), ['x x100000', 'second']);
  break;
}

case 'env': {
  process.env.NIMBUS_REALM_SENTINEL = 'host-secret';
  for (const isolation of ['thread', 'process']) {
    const { realm, events } = await start(guest('echo'), isolation, { payload: 'hello' });
    const seen = await nextEvent(events, `the ${isolation} guest`);
    assert.deepEqual(seen, { env: null, dotenv: null, preloaded: false, payload: 'hello' }, `a ${isolation} guest sees nothing of the host's environment`);
    realm.terminate();
    await within(realm.ended, 5_000, `the ${isolation} guest's end`);
  }
  // Where a process guest runs, a .env and a bunfig preload are not loaded.
  const dir = mkdtempSync(join(tmpdir(), 'nimbus-realm-env-'));
  try {
    const realmGuest = pathToFileURL(fileURLToPath(new URL(underBun ? '../../packages/core/src/runtime/realm-guest.ts' : '../../packages/core/dist/runtime/realm-guest.js', import.meta.url))).href;
    writeFileSync(join(dir, 'join.mjs'), `export { joinRealm } from ${JSON.stringify(realmGuest)};\n`);
    cpSync(fileURLToPath(guest('echo')), join(dir, 'echo.mjs'));
    writeFileSync(join(dir, '.env'), 'NIMBUS_DOTENV_SENTINEL=from-dotenv\n');
    writeFileSync(join(dir, 'pre.mjs'), 'globalThis.__nimbusPreloaded = true;\n');
    writeFileSync(join(dir, 'bunfig.toml'), 'preload = ["./pre.mjs"]\n');
    const { realm, events } = await start(pathToFileURL(join(dir, 'echo.mjs')), 'process', { payload: 'hello' });
    assert.deepEqual(await nextEvent(events, 'the guest beside a .env'), { env: null, dotenv: null, preloaded: false, payload: 'hello' },
      'a process guest loads no .env and no bunfig preload');
    realm.terminate();
    await within(realm.ended, 5_000, 'its end');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  break;
}

case 'signal': {
  for (const [signal, code] of [['SIGTERM', 143], ['SIGQUIT', 131], ['SIGUSR1', 138], ['SIGALRM', 142]]) {
    const { realm } = await start(guest('signal'), 'process', { payload: signal });
    const end = await within(realm.ended, 5_000, `a guest ending by ${signal}`);
    assert.equal(end.code, code, `${signal}: 128 + its number`);
  }
  break;
}

case 'spawn': {
  // The engine is gone (it was upgraded or removed under a running host).
  process.execPath = '/nonexistent-nimbus-engine/engine';
  const { realm } = await start(guest('echo'), 'process');
  const end = await within(realm.ended, 5_000, 'a realm whose process cannot start');
  assert.match(String(end.failure?.message), /ENOENT/, `it ended with the reason: ${end.failure?.message}`);
  assert.equal(realm.post({ late: true }), false, 'nothing is posted to it after');
  break;
}

case 'orphan': {
  if (process.env.ORPHAN_HOST) {
    // The host: start the guest, then die at once, before the guest has started.
    await startRealm({ entry: guest('orphan'), isolation: 'process', payload: null, serve: () => null, onEvent: () => {} });
    process.kill(process.pid, 'SIGKILL');
  }
  // Its stdio is not this process's: an orphan holding it would hold this case too.
  const host = spawnSync(process.execPath, [...(underBun ? [] : ['--no-warnings']), fileURLToPath(import.meta.url)], {
    env: { ...process.env, CASE: 'orphan', ORPHAN_HOST: '1' },
    stdio: 'ignore',
  });
  assert.equal(host.signal, 'SIGKILL', 'the host was killed');
  const fragment = fileURLToPath(guest('orphan'));
  let left = [];
  for (let i = 0; i < 60; i++) {
    await sleep(50);
    left = processesNaming(fragment);
    if (left.length === 0 && i >= 10) break;
  }
  for (const { pid } of left) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  assert.deepEqual(left, [], 'a guest whose host died before it started ends by itself');
  break;
}

case 'group': {
  for (const payload of ['stay', 'escape']) {
    const { realm, events } = await start(guest('descendant'), 'process', { payload });
    const { child } = await nextEvent(events, `the ${payload} guest`);
    assert.ok(alive(child), 'its process started');
    await sleep(200);
    realm.terminate();
    const end = await within(realm.ended, 3_000, `ending the realm whose process ${payload === 'stay' ? 'stays in its group' : 'left its group'}`);
    assert.equal(end.terminated, true);
    if (payload === 'stay') {
      await sleep(200);
      assert.equal(alive(child), false, 'the process it started ended with it');
    } else {
      // Beyond the group, only an OS sandbox reaches it; the realm's end does not wait for it.
      try { process.kill(child, 'SIGKILL'); } catch { /* gone */ }
    }
  }
  break;
}

case 'async': {
  for (const isolation of ['thread', 'process']) {
    let release = () => {};
    const released = new Promise((resolve) => { release = resolve; });
    const serve = async (request) => {
      if (request === 'release') { release(); return 'released'; }
      if (request === 'pending') { await released; return 'answered'; }
      return null;
    };
    const { realm, events } = await start(guest('pending'), isolation, { serve });
    const seen = await within(nextEvent(events, `the ${isolation} guest`), 10_000, `the ${isolation} guest's two calls`);
    assert.deepEqual(seen, { released: 'released', pending: 'answered' }, `a ${isolation} guest's call answered after its next`);
    realm.terminate();
    await within(realm.ended, 5_000, `the ${isolation} guest's end`);
  }
  break;
}
}
console.log(`case ${process.env.CASE} ok`);
