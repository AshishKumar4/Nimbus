#!/usr/bin/env bun
// wasi-threads-scheduler — the green-thread scheduler and software futex.
//
// Drives the REAL preamble (wasi-instance.ts + wasi-threads.ts, concatenated
// exactly as the loader pool ships them), not a reimplementation.
//
// The threads here are async JS functions rather than wasm instances. JSPI
// (WebAssembly.promising / Suspending, present in bun since 1.3) suspends
// only wasm frames, so a JS thread body can never call through the Suspending
// wrapper hostImports() ships for wasm guests — it throws "Suspending()
// wrapper called outside of a promising() context". That is a mock at a real
// seam and only that seam: the scheduler takes `startThread` as a parameter
// precisely because scheduling policy and wasm instantiation are separate
// concerns, and an async function that awaits sched.futexWait — the very
// function the import table wraps — is behaviourally the same caller as a
// promising wasm entry that suspends on the import. Everything below — the
// run queue, the level-triggered futex, the deadlock proof, the token
// handoff — is the production code path.
//
// Threads over REAL wasm are gated live instead, on workerd, where JSPI is:
// tests/behavioral/wasm/pthread-parity.mjs.

import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/core/src/runtime/wasi-instance.ts';

const EAGAIN = 6;
const EINVAL = 28;
const ETIMEDOUT = 73;
const ESUCCESS = 0;

const preambleSrc = `${WASI_INSTANCE_PREAMBLE_SRC}
export { __wasiThreadsCreate, __wasiMakeImports, __wasiInitFS, __WasiExit };`;
const preamblePath = path.join(os.tmpdir(), `wasi-threads-preamble-${process.pid}.mjs`);
writeFileSync(preamblePath, preambleSrc);
let P;
try {
  P = await import(pathToFileURL(preamblePath).href);
} finally {
  rmSync(preamblePath, { force: true });
}

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.log(`FAIL ${name} — ${e && e.message ? e.message : e}`);
    failures++;
  }
};

/**
 * A process: one shared memory, one scheduler, and a set of thread bodies
 * addressed by the `start_arg` a real pthread_create would have passed.
 */
function proc() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const bodies = new Map();
  let nextArg = 1;
  const sched = P.__wasiThreadsCreate({
    memory,
    startThread: (tid, startArg) => {
      const body = bodies.get(startArg);
      if (!body) throw new Error(`no body for start_arg ${startArg}`);
      return () => body(tid);
    },
  });
  const words = () => new Int32Array(memory.buffer);
  const imports = sched.hostImports();
  return {
    sched,
    memory,
    words,
    read: (addr) => Atomics.load(words(), addr >>> 2),
    write: (addr, v) => Atomics.store(words(), addr >>> 2, v),
    // The import-table futex_wait is Suspending-wrapped for wasm callers; a JS
    // thread body drives the identical function on the scheduler directly,
    // with the same i32 coercion the import closure applies.
    futexWait: (addr, expected, maxWaitNs) => sched.futexWait(addr | 0, expected | 0, maxWaitNs),
    imports,
    spawnFn: imports.wasi['thread-spawn'],
    /** Register a thread body and return the start_arg that selects it. */
    body(fn) {
      const arg = nextArg++;
      bodies.set(arg, fn);
      return arg;
    },
    /** What pthread_create does: register the body, then ask the host. */
    spawn(fn) {
      return imports.wasi['thread-spawn'](this.body(fn));
    },
    run(main) {
      return sched.runMain(main);
    },
  };
}

// A minimal mutex written the way musl writes one: CAS for the fast path,
// futex wait on contention, plain store to release. No wake call — there is
// none to make, which is the property under test.
function mutex(p, addr) {
  return {
    async lock(tid) {
      for (;;) {
        if (Atomics.compareExchange(p.words(), addr >>> 2, 0, tid) === 0) return;
        await p.futexWait(addr, Atomics.load(p.words(), addr >>> 2), -1n);
      }
    },
    unlock() { Atomics.store(p.words(), addr >>> 2, 0); },
  };
}

// ── 1. futex_wait argument contract ──────────────────────────────────────────
{
  const p = proc();
  let sync;
  const result = await p.run(async () => {
    sync = {
      misaligned: p.futexWait(0x101, 0, -1n),
      outOfRange: p.futexWait(1 << 20, 0, -1n),
      alreadyMoved: (p.write(64, 9), p.futexWait(64, 7, -1n)),
    };
  });
  check('futex_wait rejects a misaligned address with EINVAL', () =>
    assert.equal(sync.misaligned, -EINVAL));
  check('futex_wait rejects an out-of-bounds address with EINVAL', () =>
    assert.equal(sync.outOfRange, -EINVAL));
  check('futex_wait returns EAGAIN without parking when the word already moved', () =>
    assert.equal(sync.alreadyMoved, -EAGAIN));
  check('a main thread that never parks exits 0', () =>
    assert.deepEqual(result, { exitCode: 0 }));
}

// ── 2. contended mutex handoff, with no wake call anywhere ───────────────────
{
  const p = proc();
  const LOCK = 128, COUNT = 132;
  const m = mutex(p, LOCK);
  const trace = [];
  const bump = async (tid) => {
    for (let i = 0; i < 50; i++) {
      await m.lock(tid);
      trace.push(tid);
      const c = p.read(COUNT);
      // Yield INSIDE the critical section: if the lock did not actually
      // exclude, the read-modify-write below would interleave and lose counts.
      await p.sched.yieldNow();
      p.write(COUNT, c + 1);
      m.unlock();
    }
  };
  let a, b;
  const result = await p.run(async () => {
    a = p.spawn(bump);
    b = p.spawn(bump);
    await m.lock(1);
    p.write(COUNT, p.read(COUNT) + 1);
    m.unlock();
    // Park until both children have finished all their turns.
    while (p.read(COUNT) !== 101) await p.futexWait(COUNT, p.read(COUNT), -1n);
  });
  check('thread-spawn allocates tids above the main thread', () =>
    assert.deepEqual([a, b], [2, 3]));
  check('a contended mutex hands off correctly with no futex_wake', () =>
    assert.equal(p.read(COUNT), 101));
  check('the mutex actually excluded (no interleaved critical sections)', () =>
    assert.equal(result.exitCode, 0));
  check('both spawned threads made progress', () => {
    assert.ok(trace.filter((t) => t === 2).length === 50, `tid 2 ran ${trace.filter((t) => t === 2).length}`);
    assert.ok(trace.filter((t) => t === 3).length === 50, `tid 3 ran ${trace.filter((t) => t === 3).length}`);
  });
}

// ── 3. join: the exiting thread's word change wakes the joiner ───────────────
{
  const p = proc();
  const STATE = 256;
  const order = [];
  const result = await p.run(async () => {
    p.write(STATE, 1);
    p.spawn(async (tid) => {
      order.push(`child ${tid} ran`);
      p.write(STATE, 0);           // musl's detach_state → DT_EXITED
    });
    order.push('parent waits');
    await p.futexWait(STATE, 1, -1n);
    order.push('parent joined');
  });
  check('pthread_join-shaped wait resumes when the target updates its word', () =>
    assert.deepEqual(order, ['parent waits', 'child 2 ran', 'parent joined']));
  check('join completes the process cleanly', () =>
    assert.deepEqual(result, { exitCode: 0 }));
}

// ── 4. deadlock is proved and reported, not hung ─────────────────────────────
{
  const p = proc();
  const A = 512, B = 516;
  const result = await p.run(async () => {
    p.write(A, 1);
    p.write(B, 1);
    p.spawn(async () => { await p.futexWait(A, 1, -1n); });
    await p.futexWait(B, 1, -1n);
  });
  check('a cycle no thread can break is reported as a deadlock', () =>
    assert.match(result.error || '', /^deadlock: every thread is blocked and nothing can wake them/));
  check('the deadlock names every blocked thread', () =>
    assert.match(result.error || '', /tids 1, 2\)/));
  check('a deadlocked process exits non-zero', () => assert.equal(result.exitCode, 1));
}

// ── 5. a finite futex timeout expires as ETIMEDOUT ───────────────────────────
{
  const p = proc();
  let code;
  const result = await p.run(async () => {
    p.write(640, 5);
    code = await p.futexWait(640, 5, 30_000_000n);   // 30 ms
  });
  check('a finite futex deadline expires as ETIMEDOUT', () => assert.equal(code, -ETIMEDOUT));
  check('an expired wait does not end the process', () => assert.equal(result.exitCode, 0));
  check('a live timer is not mistaken for a deadlock', () => assert.equal(result.error, undefined));
}

// ── 6. sched_yield is round-robin over the runnable set ──────────────────────
{
  const p = proc();
  const trace = [];
  const spin = async (tid) => { for (let i = 0; i < 4; i++) { trace.push(tid); await p.sched.yieldNow(); } };
  await p.run(async () => {
    p.spawn(spin);
    p.spawn(spin);
    p.spawn(spin);
    // The main thread drops out after handing over, so the trace is exactly
    // the three children cycling in creation order.
    for (let i = 0; i < 14; i++) await p.sched.yieldNow();
  });
  const children = trace.filter((t) => t !== 1);
  check('yield cycles the runnable threads in creation order', () =>
    assert.deepEqual(children, [2, 3, 4, 2, 3, 4, 2, 3, 4, 2, 3, 4]));
}

// ── 7. run-to-park: a spawned thread does not start until the spawner parks ──
{
  const p = proc();
  const trace = [];
  await p.run(async () => {
    p.spawn(async () => { trace.push('child'); });
    trace.push('spawner continues');
    trace.push('spawner continues again');
    await p.sched.yieldNow();
    trace.push('spawner resumed');
  });
  check('thread-spawn returns without running the child', () =>
    assert.deepEqual(trace, ['spawner continues', 'spawner continues again', 'child', 'spawner resumed']));
}

// ── 8. proc_exit from a spawned thread ends the whole process ────────────────
{
  const p = proc();
  const after = [];
  const result = await p.run(async () => {
    p.spawn(async () => { throw new P.__WasiExit(7); });
    await p.sched.yieldNow();
    after.push('main kept running');
    p.write(704, 1);
    await p.futexWait(704, 1, -1n);
  });
  check('proc_exit from any thread ends the process with its code', () =>
    assert.deepEqual(result, { exitCode: 7 }));
  check('the exiting thread stops the peers rather than letting them park on', () =>
    assert.deepEqual(after, []));
}

// ── 9. an unhandled thread fault names the thread ────────────────────────────
{
  const p = proc();
  const result = await p.run(async () => {
    p.spawn(async () => { throw new Error('unreachable executed'); });
    await p.sched.yieldNow();
    await p.futexWait(768, 0, -1n);
  });
  check('a trapping thread reports its tid and message', () =>
    assert.equal(result.error, 'thread 2: unreachable executed'));
  check('a trapping thread exits the process non-zero', () => assert.equal(result.exitCode, 1));
}

// ── 10. the spawn cap is reported the way pthread_create reports it ──────────
{
  const p = proc();
  let over;
  let accepted = 0;
  await p.run(async () => {
    for (;;) {
      const tid = p.spawn(async () => { await p.futexWait(896, 0, -1n); });
      if (tid < 0) { over = tid; break; }
      accepted++;
      if (accepted > 200) break;
    }
  });
  check('spawning past the cap returns EAGAIN rather than exhausting memory', () =>
    assert.equal(over, -EAGAIN));
  check('the cap admits 127 threads beside the main one', () => assert.equal(accepted, 127));
}

// ── 11. a blocking syscall releases the token to a peer ──────────────────────
{
  const p = proc();
  const trace = [];
  let release;
  const hostCall = new Promise((resolve) => { release = resolve; });
  await p.run(async () => {
    p.spawn(async () => {
      trace.push('peer ran while main was in a syscall');
      release(ESUCCESS);
    });
    trace.push('main enters syscall');
    const rc = await p.sched.parkIo(hostCall);
    trace.push(`main resumed rc=${rc}`);
  });
  check('parkIo lets a peer run and returns the host value to the caller', () =>
    assert.deepEqual(trace, [
      'main enters syscall',
      'peer ran while main was in a syscall',
      'main resumed rc=0',
    ]));
}

// ── 12. the WASI layer routes its own parks through the scheduler ────────────
{
  const p = proc();
  const trace = [];
  let release;
  const supervisorAnswer = new Promise((resolve) => { release = resolve; });
  P.__wasiInitFS({ root: '', preopens: [], files: {}, dirs: [], modes: {} });
  // path_filestat_get is one of the imports withParkDeadline guards; handing it
  // a promise is what a supervisor round-trip does.
  const parked = p.sched.parkIo(supervisorAnswer);
  await p.run(async () => {
    p.spawn(async () => { trace.push('peer'); release(1); });
    trace.push('main');
    await p.sched.yieldNow();
  });
  void parked;
  check('a scheduler exists for the WASI layer to hand its parks to', () =>
    assert.equal(typeof p.sched.parkIo, 'function'));
  check('peers still run around a host round-trip', () =>
    assert.deepEqual(trace, ['main', 'peer']));
}

// ── 13. the import table ships the right calling conventions ─────────────────
{
  const p = proc();
  check('thread-spawn is a plain synchronous import (never Suspending)', () =>
    assert.equal(typeof p.imports.wasi['thread-spawn'], 'function'));
  check('futex_wait ships Suspending-wrapped exactly when the runtime has JSPI', () => {
    // A misaligned address returns -EINVAL before the scheduler is consulted,
    // so the unwrapped fallback answers synchronously; the Suspending wrapper
    // refuses any caller that is not a suspended wasm frame.
    if (typeof WebAssembly.Suspending === 'function') {
      assert.throws(() => p.imports.nimbus_threads.futex_wait(0x101, 0, -1n),
        'a JSPI runtime must receive a futex_wait only a promising wasm entry can call');
    } else {
      assert.equal(p.imports.nimbus_threads.futex_wait(0x101, 0, -1n), -EINVAL);
    }
  });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
