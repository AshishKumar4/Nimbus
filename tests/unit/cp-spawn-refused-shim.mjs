#!/usr/bin/env bun
// A child the session refused to start (EAGAIN: no Dynamic Worker for it,
// and none would come) never ran. Its ChildProcess reports that as Node
// reports a failed spawn, whichever of the parent's waits hears of it: an
// 'error', then 'close' with the negative errno; no 'spawn', no 'exit', no
// pid. A child that starts publishes its pid and emits 'spawn' only once the
// broker says it started, never before.
//
// Before, the shim published the broker's pid and emitted 'spawn' as soon
// as the broker took the request, and the parent's exit-time drain turned a
// refusal into an 'exit' with -11.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const make = (supervisor) => new Function('__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname', '__nimbusProcessId',
  'const __pendingIO = [];' + generateShimsCode() + '\nreturn { proc: __processMod, cp: builtins.child_process };')({}, {}, {}, supervisor, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/main.js', '/home/user', 4321);
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const REFUSED = { done: true, exitCode: -11, signal: null, spawnError: 'EAGAIN' };

/** A child's events, in order, and its pid as each one saw it. */
function watch(child) {
  const events = [];
  child.on('spawn', () => events.push(['spawn', child.pid]));
  child.on('error', (e) => events.push(['error', e.code, e.errno, e.syscall, e.path, e.message, child.pid]));
  child.on('exit', (code, signal) => events.push(['exit', code, signal]));
  child.on('close', (code, signal) => events.push(['close', code, signal, child.pid]));
  return events;
}

const supervisorFor = (answer) => ({
  cpSpawn: async () => ({ childPid: 77 }),
  cpStdinEnd: async () => {},
  cpReadOutput: async () => { await tick(); return { chunks: [], closed: true, maxSeq: 0 }; },
  cpDrainOutput: async () => ({ stdout: new Uint8Array(0), stderr: new Uint8Array(0), stdoutClosed: true, stderrClosed: true }),
  cpWait: async (_pid, waitMs, _acquire, knownStarted) => { await tick(); return answer(waitMs, knownStarted); },
});

// ── refused, heard by the wait loop ────────────────────────────────────────
{
  let polls = 0;
  const { cp } = make(supervisorFor(() => (++polls < 3 ? { done: false } : REFUSED)));
  const child = cp.spawn('node', ['-e', 'console.log(1)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const events = watch(child);
  for (let i = 0; i < 200 && !events.some((e) => e[0] === 'close'); i++) await tick();
  assert.deepEqual(events, [
    ['error', 'EAGAIN', -11, 'spawn node', 'node', 'spawn node EAGAIN', undefined],
    ['close', -11, null, undefined],
  ], "a refused spawn is 'error' then 'close', with no 'spawn', no 'exit' and no pid");
  assert.equal(child.pid, undefined);
  assert.equal(child.exitCode, -11);
}

// ── refused, heard first by the parent's exit-time drain ────────────────────
{
  // The wait loop is still waiting (1000 ms polls) when the parent exits.
  const { cp } = make(supervisorFor((waitMs) => (waitMs === 500 ? REFUSED : { done: false })));
  const child = cp.spawn('node', ['-e', 'console.log(1)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const events = watch(child);
  for (let i = 0; i < 20; i++) await tick();
  await cp.__cpDrainAllChildren();
  await tick();
  assert.deepEqual(events.map((e) => e[0]), ['error', 'close'], "the drain reports a refusal as the wait loop does, never as an 'exit'");
  assert.equal(child.pid, undefined);
}

// ── refused by the broker itself (the depth cap): the same ─────────────────
{
  const supervisor = supervisorFor(() => ({ done: false }));
  supervisor.cpSpawn = async () => { throw Object.assign(new Error('EAGAIN: child_process spawn depth 8 exceeds CHILD_PROCESS_MAX_DEPTH=8'), { code: 'EAGAIN', errno: -11 }); };
  const { cp } = make(supervisor);
  const child = cp.spawn('node', ['-e', 'console.log(1)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const events = watch(child);
  for (let i = 0; i < 200 && !events.some((e) => e[0] === 'close'); i++) await tick();
  assert.deepEqual(events.map((e) => e.slice(0, 3)), [['error', 'EAGAIN', -11], ['close', -11, null]],
    "a spawn the broker refused is 'error' then 'close' -11, as Node's at a process limit");
}

// ── started: the pid and 'spawn' come with the start, not before ───────────
{
  let started = false;
  let ended = false;
  const { cp } = make(supervisorFor((_waitMs, knownStarted) => {
    if (ended) return { done: true, exitCode: 0, signal: null };
    if (started && knownStarted === false) return { done: false, started: true };
    return { done: false };
  }));
  const child = cp.spawn('node', ['-e', 'console.log(1)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const events = watch(child);
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(events, [], 'pending admission: no spawn yet');
  assert.equal(child.pid, undefined, 'and no pid');
  started = true;
  for (let i = 0; i < 200 && events.length === 0; i++) await tick();
  assert.deepEqual(events, [['spawn', 77]], "once started: the pid, and 'spawn'");
  ended = true;
  for (let i = 0; i < 200 && !events.some((e) => e[0] === 'close'); i++) await tick();
  assert.deepEqual(events.map((e) => e[0]), ['spawn', 'exit', 'close']);
}

console.log('ok - cp-spawn-refused-shim (a refused spawn is error and close with no pid, from either wait; spawn and pid come with the start)');
