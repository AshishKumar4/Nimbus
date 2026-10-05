#!/usr/bin/env bun
// A child the session refused to start (EAGAIN: no Dynamic Worker for it,
// and none would come) never ran. Its ChildProcess reports that as Node
// reports a failed spawn, whichever of the parent's waits hears of it: an
// 'error', then 'close' with the negative errno; no 'spawn', no 'exit', no
// pid. A child that starts publishes its pid and emits 'spawn' only once the
// broker says it started, never before, and always before its first byte of
// output, whichever reply brings that first.
//
// A child whose output its parent never reads still closes after it exits,
// as Node's does (flushStdio resumes untouched streams): red on 84f4aba2f,
// where the unread stderr held 'close' back for good. A stream an async
// iterator owns is left to it: red on f5faea96e, where the drain resumed it
// and its second chunk went to no one. One whose 'readable' listener was
// removed is not owned any more: red on 857347754, where it stayed owned and
// 'close' never came.
//
// Two races, red on 34f5b1e0e: the wait loop and the exit-time drain both
// hearing the same refusal emitted 'error' twice; output that arrived before
// the wait loop heard of the start was forwarded before 'spawn', with
// child.pid still undefined.
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

// ── the same refusal heard by both waits: 'error' once ─────────────────────
{
  // Both the wait loop's poll and the drain's are in flight when the refusal comes.
  let refuse;
  const refused = new Promise((resolve) => { refuse = resolve; });
  const supervisor = supervisorFor(() => ({ done: false }));
  supervisor.cpWait = async () => { await refused; return REFUSED; };
  const { cp } = make(supervisor);
  const child = cp.spawn('node', ['-e', 'console.log(1)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const events = watch(child);
  for (let i = 0; i < 20; i++) await tick();
  const drained = cp.__cpDrainAllChildren();
  await tick();
  refuse();
  await drained;
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(events.map((e) => e[0]), ['error', 'close'], "one 'error' and one 'close', though both waits heard the refusal");
}

// ── output before the start is heard: 'spawn' and the pid first ─────────────
{
  let read = 0;
  const supervisor = supervisorFor((_waitMs, knownStarted) => (knownStarted === false ? { done: false } : { done: false }));
  // The wait loop has not heard of the start (its poll waits); the output poll answers first.
  supervisor.cpWait = async () => new Promise(() => {});
  supervisor.cpReadOutput = async (_pid, fd) => {
    await tick();
    if (fd === 1 && ++read === 1) return { chunks: [{ seq: 1, data: new TextEncoder().encode('hi\n') }], closed: false, maxSeq: 1 };
    return new Promise(() => {});
  };
  const { cp } = make(supervisor);
  const child = cp.spawn('node', ['-e', 'console.log("hi")'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const events = watch(child);
  child.stdout.on('data', (d) => events.push(['data', String(d), child.pid]));
  for (let i = 0; i < 200 && !events.some((e) => e[0] === 'data'); i++) await tick();
  assert.deepEqual(events, [['spawn', 77], ['data', 'hi\n', 77]], "'spawn', with the pid, before the first byte");
}

// ── output nobody reads: still 'close' after 'exit', as Node's flushStdio ──
{
  let polls = 0;
  const supervisor = supervisorFor(() => (++polls < 3 ? { done: false, started: true } : { done: true, exitCode: 1, signal: null }));
  let served = { 1: false, 2: false };
  supervisor.cpReadOutput = async (_pid, fd) => {
    await tick();
    if (!served[fd]) { served[fd] = true; return { chunks: [{ seq: 1, data: new TextEncoder().encode(fd === 2 ? 'boom\n' : 'out\n') }], closed: true, maxSeq: 1 }; }
    return { chunks: [], closed: true, maxSeq: 1 };
  };
  const { cp } = make(supervisor);
  const child = cp.spawn('node', ['-e', 'throw 1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const events = [];
  // The parent listens for the end, but never reads stdout or stderr.
  child.on('exit', (code) => events.push(['exit', code]));
  child.on('close', (code) => events.push(['close', code]));
  for (let i = 0; i < 200 && !events.some((e) => e[0] === 'close'); i++) await tick();
  assert.deepEqual(events, [['exit', 1], ['close', 1]], "unread output is drained after 'exit', and 'close' follows");
}

// ── an async iterator owns its stream: the drain after 'exit' leaves it ────
{
  // Two chunks, A and B, then the end; the child exits while the iterator,
  // having taken A, is busy with it (paused, between next() calls).
  let polls = 0;
  const supervisor = supervisorFor(() => (++polls < 2 ? { done: false, started: true } : { done: true, exitCode: 0, signal: null }));
  supervisor.cpReadOutput = async (_pid, fd, since) => {
    await tick();
    if (fd === 1 && since === 0) {
      return { chunks: [{ seq: 1, data: new TextEncoder().encode('A') }, { seq: 2, data: new TextEncoder().encode('B') }], closed: true, maxSeq: 2 };
    }
    return { chunks: [], closed: true, maxSeq: since };
  };
  const { cp } = make(supervisor);
  const child = cp.spawn('node', ['-e', 'process.stdout.write("AB")'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const read = [];
  for await (const chunk of child.stdout) {
    read.push(String(chunk));
    if (read.length === 1) { await exited; for (let i = 0; i < 10; i++) await tick(); }
  }
  assert.deepEqual(read, ['A', 'B'], "the iterator reads every chunk: the drain after 'exit' does not resume a stream it owns");
}

// ── a 'readable' listener attached, then removed: the drain resumes it ─────
{
  for (const remove of ['off', 'removeListener', 'removeAllListeners']) {
    let polls = 0;
    const supervisor = supervisorFor(() => (++polls < 3 ? { done: false, started: true } : { done: true, exitCode: 1, signal: null }));
    const served = { 1: false, 2: false };
    supervisor.cpReadOutput = async (_pid, fd) => {
      await tick();
      if (!served[fd]) { served[fd] = true; return { chunks: [{ seq: 1, data: new TextEncoder().encode(fd === 2 ? 'boom\n' : 'out\n') }], closed: true, maxSeq: 1 }; }
      return { chunks: [], closed: true, maxSeq: 1 };
    };
    const { cp } = make(supervisor);
    const child = cp.spawn('node', ['-e', 'throw 1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const events = [];
    const onReadable = () => {};
    child.stderr.on('readable', onReadable);
    if (remove === 'removeAllListeners') child.stderr.removeAllListeners('readable');
    else child.stderr[remove]('readable', onReadable);
    child.on('exit', (code) => events.push(['exit', code]));
    child.on('close', (code) => events.push(['close', code]));
    for (let i = 0; i < 200 && !events.some((e) => e[0] === 'close'); i++) await tick();
    assert.deepEqual(events, [['exit', 1], ['close', 1]], `a 'readable' listener ${remove}'d no longer owns the stream: 'close' follows 'exit'`);
  }
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
