/**
 * wasi-threads.ts — pthread / wasi-threads parity for Nimbus.
 *
 * This is the host-side sibling of `ruby-green-threads.ts`. That file runs a
 * green-thread scheduler INSIDE a guest VM (fibers of one wasm instance); this
 * one runs the same model at the host layer, over MULTIPLE INSTANCES of one
 * module sharing one `WebAssembly.Memory`. One concurrency model, two layers —
 * the park set, run-to-park policy, deadlock detection and honest-limits
 * statement below are deliberately the same contract, not a second one.
 *
 * ── Why this works at all ──────────────────────────────────────────────────
 *
 * Instantiating one compiled module N times against a single
 * `new WebAssembly.Memory({ shared: true })` gives N wasm stacks over ONE
 * linear memory, and — the load-bearing property — each instance gets its own
 * GLOBALS, so every thread has a private `__stack_pointer` and `__tls_base`
 * for free. wasi-libc's `wasi_thread_start` sets both from the start struct
 * the spawning thread allocated, so TLS needs no host emulation.
 *
 * Threads of one process never cross an isolate boundary, so nothing here
 * needs a primitive workerd lacks. What workerd does lack is request-time
 * COMPILATION (`new WebAssembly.Module(bytes)` → "Wasm code generation
 * disallowed by embedder"); instantiation of an already-compiled module is
 * allowed. Every thread therefore reuses the one module the loader pool
 * compiled at startup. That is why `startThread` is injected rather than built
 * here: this file owns scheduling policy, the runner owns the module.
 *
 * ── 1. Scheduling policy ───────────────────────────────────────────────────
 *
 * Round-robin, run-to-park, creation order, exactly one thread executing at a
 * time. A thread runs until it parks; each scheduling pass walks the threads in
 * creation order and makes runnable every one whose wait condition is now
 * satisfied; the head of the run queue then gets the token.
 *
 * Serialised execution is what makes correctness reachable without
 * `Atomics.wait`: memory is genuinely shared, but access to it is serialised,
 * so the scheduler introduces no data race of its own.
 *
 * ── 2. The park set ────────────────────────────────────────────────────────
 *
 * Every operation that can block MUST park, or it is a latent deadlock:
 *
 *   futex wait (mutex, condvar, join, barrier, sem)   here, `futexWait`
 *   sched_yield                                       here, `yieldNow`
 *   every blocking WASI import (fd_read, poll_oneoff,
 *     sock_send/recv, …)                              wasi-instance,
 *                                                     `withParkDeadline`
 *                                                       → `parkIo`
 *
 * The WASI leg is one integration point rather than eight because
 * `withParkDeadline` already wraps every parkable import and already knows
 * "this call returned a promise, so it is a real park".
 *
 * ── 3. The software futex, and why there is no `futex_wake` ────────────────
 *
 * `Atomics.wait` throws in workerd (`SetAllowAtomicsWait(false)`), and the
 * `memory.atomic.wait32` INSTRUCTION traps for the same reason — so a guest
 * cannot block on memory by itself. wasi-libc provides the one hook that
 * matters: `__wasilibc_futex_wait` calls the weak symbol
 * `__wasilibc_futex_wait_maybe_busy` when it is defined, and falls back to the
 * instruction when it is not. Defining it (see `runtime-contracts/`) routes
 * every libc futex wait — mutex, condvar, join, barrier, semaphore — through
 * the host import `nimbus_threads.futex_wait`.
 *
 * The matching wake is INLINED into libc as `memory.atomic.notify` and cannot
 * be hooked. It does not need to be. A waiter parks on a PREDICATE —
 * "*addr != expected" — and every scheduling pass re-evaluates it. Because
 * exactly one thread runs at a time, memory can only change while some thread
 * runs, and a scheduling pass happens at every park, yield and exit; so a
 * predicate that is satisfiable at any instant a waiter could have run is
 * observed at that instant. The futex is level-triggered rather than
 * edge-triggered, which is strictly safer: a lost wakeup is not expressible.
 *
 * That same property makes deadlock detection EXACT rather than heuristic. If
 * every live thread is parked on a predicate, none is satisfied, and no host
 * I/O or timer is outstanding, then no thread can run, so memory can never
 * change, so no predicate can ever become true. That is a proof, and it is
 * reported as a deadlock instead of hanging — the `ruby-green-threads.ts`
 * precedent ("every thread is blocked and nothing can wake them").
 *
 * ── 4. Timeouts and the suspension ceiling ─────────────────────────────────
 *
 * A wasm stack suspended inside a Durable Object resumes in a later request
 * only under a measured ~15 s ceiling (`__WASI_PARK_CEILING_MS`); past it the
 * promise never settles at all. A finite futex timeout longer than
 * `__WASI_PARK_DEADLINE_MS` is therefore capped, and the capped expiry resolves
 * as a SPURIOUS WAKEUP (0), not `ETIMEDOUT`. That composes correctly rather
 * than by luck: POSIX permits spurious wakeups and every correct mutex/condvar
 * caller re-checks its predicate in a loop, so the guest simply re-parks. An
 * INFINITE wait gets no watchdog at all — the exact deadlock detection above
 * is a better answer than waking a thread every ten seconds forever.
 *
 * ── 5. Honest limits ───────────────────────────────────────────────────────
 *
 * CORRECT: mutual exclusion, condition variables, `pthread_join`/detach, TLS,
 * barriers, semaphores, once-init. A program correct under a real pthread
 * library is correct here.
 *
 * NOT PARALLEL: one core, one runnable thread at a time. A CPU-bound N-thread
 * program gets ZERO speedup and pays switching overhead on top. It finishes
 * correctly and slower than the single-threaded version would. This is not a
 * temporary state pending an offload path: every resident Nimbus process is a
 * DO Facet, and facet siblings serialise on CPU (measured), so there is no
 * independent-CPU substrate to escape to.
 *
 * NO PREEMPTION YET: a thread that never reaches the park set — a spinlock, a
 * tight compute loop — holds the process until it does. Unlike the Ruby layer,
 * which documents that preemption "is not possible" because it cannot rebuild
 * the Ruby VM, that is fixable here (back-edge yield fuel in the module build)
 * and is the next phase, not a permanent limit.
 *
 * LOUD, NEVER SILENTLY WRONG: a module that asks for `wasi.thread-spawn`
 * without an imported shared memory, without exporting `wasi_thread_start`, or
 * without the futex shim linked in is rejected at load with the exact remedy —
 * see `wasiThreadsLoadError`. It is never run in a way that would corrupt.
 */

/** The import namespace the wasi-threads proposal defines. */
export const WASI_THREADS_NAMESPACE = 'wasi';
/** The import namespace carrying Nimbus's software futex. */
export const NIMBUS_THREADS_NAMESPACE = 'nimbus_threads';
/** The guest export a wasi-threads module must provide. */
export const WASI_THREAD_START_EXPORT = 'wasi_thread_start';

/** The memory a threads module imports, as declared in its binary. */
export interface WasmMemoryImport {
  module: string;
  name: string;
  /** Pages (64 KiB each). */
  initial: number;
  /** Pages; wasm requires a maximum on shared memories. */
  maximum: number | null;
  shared: boolean;
}

/** What a compiled module asks of the host with respect to threads. */
export interface WasmThreadsInfo {
  /** True when the module imports `wasi.thread-spawn`. */
  spawns: boolean;
  /** True when the module imports `nimbus_threads.futex_wait`. */
  futex: boolean;
  /** The imported memory, or null when the module defines its own. */
  memory: WasmMemoryImport | null;
  /** True when the module exports `wasi_thread_start`. */
  threadStart: boolean;
}

function readVarU32(bytes: Uint8Array, at: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    if (i >= bytes.length) throw new Error('wasm: truncated LEB128');
    const b = bytes[i++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result >>> 0, i];
    shift += 7;
    if (shift > 35) throw new Error('wasm: LEB128 too long');
  }
}

/**
 * Read the import and export sections of a wasm binary.
 *
 * The JS API exposes `WebAssembly.Module.imports()` but not the TYPE of an
 * imported memory, and the host has to create that memory with the exact
 * initial/maximum the module declares or instantiation fails. So the limits
 * are read from the binary, supervisor-side, where the bytes already are.
 * Only the two sections that matter are decoded; every other section is
 * skipped by its declared length.
 */
export function inspectWasmThreads(bytes: Uint8Array): WasmThreadsInfo {
  const info: WasmThreadsInfo = { spawns: false, futex: false, memory: null, threadStart: false };
  if (bytes.length < 8) return info;
  if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return info;
  const utf8 = new TextDecoder();
  let i = 8;
  while (i < bytes.length) {
    const id = bytes[i++];
    let size: number;
    [size, i] = readVarU32(bytes, i);
    const end = i + size;
    if (end > bytes.length) break;
    if (id === 2) {
      let count: number;
      let p = i;
      [count, p] = readVarU32(bytes, p);
      for (let n = 0; n < count; n++) {
        let len: number;
        [len, p] = readVarU32(bytes, p);
        const mod = utf8.decode(bytes.subarray(p, p + len));
        p += len;
        [len, p] = readVarU32(bytes, p);
        const name = utf8.decode(bytes.subarray(p, p + len));
        p += len;
        const kind = bytes[p++];
        if (kind === 0x00) {
          [, p] = readVarU32(bytes, p);  // type index
          if (mod === WASI_THREADS_NAMESPACE && name === 'thread-spawn') info.spawns = true;
          if (mod === NIMBUS_THREADS_NAMESPACE && name === 'futex_wait') info.futex = true;
        } else if (kind === 0x01) {
          p++;                            // reftype
          const flags = bytes[p++];
          [, p] = readVarU32(bytes, p);   // initial
          if (flags & 0x01) [, p] = readVarU32(bytes, p);
        } else if (kind === 0x02) {
          const flags = bytes[p++];
          let initial: number;
          [initial, p] = readVarU32(bytes, p);
          let maximum: number | null = null;
          if (flags & 0x01) [maximum, p] = readVarU32(bytes, p);
          info.memory = { module: mod, name, initial, maximum, shared: (flags & 0x02) !== 0 };
        } else if (kind === 0x03) {
          p += 2;                         // valtype + mutability
        } else {
          return info;                    // unknown import kind: stop, report what is known
        }
      }
    } else if (id === 7) {
      let count: number;
      let p = i;
      [count, p] = readVarU32(bytes, p);
      for (let n = 0; n < count; n++) {
        let len: number;
        [len, p] = readVarU32(bytes, p);
        const name = utf8.decode(bytes.subarray(p, p + len));
        p += len;
        const kind = bytes[p++];
        [, p] = readVarU32(bytes, p);
        if (kind === 0x00 && name === WASI_THREAD_START_EXPORT) info.threadStart = true;
      }
    }
    i = end;
  }
  return info;
}

/**
 * The build flags a threads module must have been linked with, quoted in every
 * load error so the remedy travels with the diagnosis.
 */
const THREADS_LINK_FLAGS =
  '--target=wasm32-wasip1-threads -pthread '
  + '-Wl,--import-memory,--shared-memory,--max-memory=<bytes> '
  + 'and link runtime-contracts/nimbus-threads.c';

/**
 * Why this module cannot be run with threads, or null when it can.
 *
 * Every unsupported shape fails HERE — at load, with the remedy — rather than
 * part-way through a run with corrupted memory semantics. A module that does
 * not ask for threads at all is not this function's business and returns null.
 */
export function wasiThreadsLoadError(info: WasmThreadsInfo): string | null {
  if (!info.spawns) return null;
  if (!info.memory) {
    return 'wasi-threads: this module imports wasi.thread-spawn but defines its own memory, so '
      + 'its threads could not share one address space. Rebuild with: ' + THREADS_LINK_FLAGS;
  }
  if (!info.memory.shared) {
    return 'wasi-threads: this module imports a non-shared memory, which cannot back more than '
      + 'one instance. Rebuild with: ' + THREADS_LINK_FLAGS;
  }
  if (info.memory.maximum === null) {
    return 'wasi-threads: a shared memory must declare a maximum size. Rebuild with: '
      + THREADS_LINK_FLAGS;
  }
  if (!info.threadStart) {
    return 'wasi-threads: this module does not export ' + WASI_THREAD_START_EXPORT + ', so the host '
      + 'has no entry point to start a thread on. Rebuild with: ' + THREADS_LINK_FLAGS;
  }
  if (!info.futex) {
    return 'wasi-threads: this module was not linked against the Nimbus futex shim, so every '
      + 'blocking pthread operation would execute memory.atomic.wait32, which traps on Workers '
      + '("Atomics.wait cannot be called in this context"). Link runtime-contracts/'
      + 'nimbus-threads.c into the program. If you DID link it, the wasi-libc you built against '
      + 'predates the weak __wasilibc_futex_wait_maybe_busy hook that file defines: nothing calls '
      + 'the definition, so the linker drops it and the build reports no error. Rebuild with '
      + 'wasi-sdk 27 or newer. Full build line: ' + THREADS_LINK_FLAGS;
  }
  return null;
}

/**
 * Source string appended to the WASI preamble. Evaluated verbatim in the facet
 * isolate, where the thread instances live — self-contained apart from the
 * constants and the `__wasiThreads` slot the WASI preamble declares.
 */
export const WASI_THREADS_PREAMBLE_SRC = `
// ── BEGIN: wasi-threads preamble (green-thread scheduler + software futex) ───
// Source mirror: src/runtime/wasi-threads.ts. Keep in sync by hand.

// wasi-libc gives the main thread tid 1 and expects the host to allocate
// spawned tids above it; musl stores the tid as the mutex owner word, so a
// collision would make one thread able to unlock another's mutex.
const __WASI_THREAD_MAIN_TID = 1;

// A green thread costs an instance (its own globals + stack in shared memory),
// so an unbounded spawn loop is a memory fault with no error. pthread_create
// reports EAGAIN for exactly this, and the guest's own error path handles it.
const __WASI_THREADS_MAX = 128;

/**
 * The scheduler. Owns every green thread and decides which one may run.
 *
 * It knows nothing about WebAssembly on purpose: \`startThread\` is supplied by
 * whoever owns the compiled module, which keeps the "one startup-compiled
 * module, instantiated per thread, never recompiled" rule where the module is.
 */
class __WasiThreadScheduler {
  constructor(opts) {
    // Re-read through .buffer on every access: a shared memory can grow, and a
    // grown memory means a new backing buffer.
    this.memory = opts.memory;
    // (tid, startArg) -> Promise, resolving when that thread's body returns.
    this.startThread = opts.startThread;
    this.threads = [];            // creation order — the scheduling pass walks this
    this.nextTid = __WASI_THREAD_MAIN_TID + 1;
    this.current = null;          // the one thread holding the token
    this.runQueue = [];
    this.pendingIo = 0;           // threads parked on a host promise
    this.pendingTimers = 0;       // futex waits with a live timer
    this.finished = null;         // { exitCode, error } once the process ends
    this.settleProcess = null;
    this.spawnError = null;       // why the last thread-spawn returned EAGAIN
  }

  words() { return new Int32Array(this.memory.buffer); }

  live() {
    let n = 0;
    for (const t of this.threads) if (t.state !== 'exited') n++;
    return n;
  }

  // ── Import table ─────────────────────────────────────────────────────────
  //
  // thread-spawn returns i32 synchronously and must NOT be Suspending; futex
  // waits park the caller and must be.
  hostImports() {
    const spawn = (startArg) => this.spawn(startArg | 0);
    const futexWait = (addr, expected, maxWaitNs) => this.futexWait(addr | 0, expected | 0, maxWaitNs);
    const suspending = (typeof WebAssembly !== 'undefined' && typeof WebAssembly.Suspending === 'function')
      ? new WebAssembly.Suspending(futexWait)
      : futexWait;
    return {
      '${WASI_THREADS_NAMESPACE}': { 'thread-spawn': spawn },
      '${NIMBUS_THREADS_NAMESPACE}': { futex_wait: suspending },
    };
  }

  // ── Thread lifecycle ─────────────────────────────────────────────────────

  record(tid) {
    return {
      tid,
      state: 'runnable',   // runnable | running | parked | exited
      cond: null,          // { word, expected } while futex-parked
      timer: null,
      settlePark: null,
      resume: null,
    };
  }

  /**
   * wasi-threads \`thread-spawn\`: allocate a tid, hand the guest's start
   * struct to a fresh instance, and queue it. Returns the tid, or a negative
   * value the guest's pthread_create turns into EAGAIN.
   *
   * The child does not run here — the spawning thread keeps the token and runs
   * to its next park, which is what run-to-park means and what makes the
   * ordering reproducible.
   */
  spawn(startArg) {
    if (this.finished) return -__WASI_EAGAIN;
    if (this.live() >= __WASI_THREADS_MAX) return -__WASI_EAGAIN;
    const t = this.record(this.nextTid);
    let begin;
    try {
      begin = this.startThread(t.tid, startArg);
    } catch (e) {
      // Instantiating the shared module failed (out of memory for the
      // instance, or a host defect). The guest sees EAGAIN, which is the
      // errno pthread_create already documents for "cannot create thread".
      this.spawnError = 'thread-spawn failed: ' + ((e && e.message) ? e.message : String(e));
      return -__WASI_EAGAIN;
    }
    this.nextTid++;
    this.threads.push(t);
    t.resume = () => {
      let entered;
      try {
        entered = begin();
      } catch (e) {
        this.onThreadSettled(t, e);
        return;
      }
      Promise.resolve(entered).then(() => this.onThreadSettled(t, null), (e) => this.onThreadSettled(t, e));
    };
    this.runQueue.push(t);
    return t.tid;
  }

  /**
   * Run the process. \`enter\` is the main thread's promising entry (_start).
   * Resolves with the same shape __wasiRunStart returns.
   */
  runMain(enter) {
    const t = this.record(__WASI_THREAD_MAIN_TID);
    t.state = 'running';
    this.threads.push(t);
    this.current = t;
    const done = new Promise((resolve) => { this.settleProcess = resolve; });
    let entered;
    try {
      entered = enter();
    } catch (e) {
      this.onThreadSettled(t, e);
      return done;
    }
    Promise.resolve(entered).then(() => this.onThreadSettled(t, null), (e) => this.onThreadSettled(t, e));
    return done;
  }

  onThreadSettled(t, err) {
    t.state = 'exited';
    if (t.timer !== null) { clearTimeout(t.timer); t.timer = null; this.pendingTimers--; }
    if (this.current === t) this.current = null;
    if (err) {
      // proc_exit from ANY thread ends the process, which is POSIX exit(3).
      if (err && err.constructor && err.constructor.name === '__WasiExit') {
        this.endProcess({ exitCode: err.code });
        return;
      }
      this.endProcess({
        exitCode: 1,
        error: 'thread ' + t.tid + ': ' + ((err && err.message) ? err.message : String(err)),
      });
      return;
    }
    // The main thread returning ends the process and every thread with it —
    // POSIX semantics for exit(3), and the same rule ruby-green-threads
    // applies when its main body finishes.
    if (t.tid === __WASI_THREAD_MAIN_TID) {
      this.endProcess({ exitCode: 0 });
      return;
    }
    this.dispatch();
  }

  endProcess(result) {
    if (this.finished) return;
    this.finished = result;
    this.current = null;
    this.runQueue.length = 0;
    for (const t of this.threads) {
      if (t.timer !== null) { clearTimeout(t.timer); t.timer = null; }
    }
    this.pendingTimers = 0;
    if (__wasiThreads === this) __wasiThreads = null;
    // A failed spawn is reported to the guest as EAGAIN and usually surfaces
    // as its own error message; if the program died without one, say why.
    if (this.spawnError && !result.error && result.exitCode !== 0) result.error = this.spawnError;
    this.settleProcess(result);
  }

  // ── The token ────────────────────────────────────────────────────────────

  /**
   * One scheduling pass, then hand the token to the head of the run queue.
   *
   * The pass walks the threads in creation order and makes runnable every one
   * whose futex predicate now holds. It runs at every park, yield and exit —
   * the only moments memory can have changed — which is what makes the
   * level-triggered futex complete and the deadlock verdict exact.
   */
  dispatch() {
    if (this.finished || this.current) return;
    const words = this.words();
    for (const t of this.threads) {
      if (t.state !== 'parked' || t.cond === null) continue;
      if (Atomics.load(words, t.cond.word) !== t.cond.expected) this.makeRunnable(t, __WASI_ESUCCESS);
    }
    const next = this.runQueue.shift();
    if (!next) { this.checkIdle(); return; }
    this.current = next;
    next.state = 'running';
    const go = next.resume;
    next.resume = null;
    // Always a fresh task: a spawned thread's first entry runs wasm
    // synchronously, and doing that from the parking thread's stack would nest
    // one JS frame per context switch.
    queueMicrotask(go);
  }

  makeRunnable(t, code) {
    t.state = 'runnable';
    t.cond = null;
    if (t.timer !== null) { clearTimeout(t.timer); t.timer = null; this.pendingTimers--; }
    const settle = t.settlePark;
    t.settlePark = null;
    t.resume = () => settle(code);
    this.runQueue.push(t);
  }

  /**
   * Nothing is runnable. Either the process is winding down, or every live
   * thread is blocked on a predicate no thread can ever satisfy — which is a
   * deadlock, provable rather than suspected, and reported instead of hung.
   */
  checkIdle() {
    if (this.finished || this.current || this.runQueue.length) return;
    if (this.pendingIo > 0 || this.pendingTimers > 0) return;
    const blocked = [];
    for (const t of this.threads) if (t.state === 'parked') blocked.push(t.tid);
    if (!blocked.length) return;
    this.endProcess({
      exitCode: 1,
      error: 'deadlock: every thread is blocked and nothing can wake them (tids '
        + blocked.join(', ') + ')',
    });
  }

  // ── The park set ─────────────────────────────────────────────────────────

  /**
   * The software futex. Returns 0 when woken, -EAGAIN when the word already
   * moved (the race-free check uses the atomic load, which works — only
   * Atomics.wait is blocked), and -ETIMEDOUT when a finite deadline expires.
   * Mirrors the return contract of wasi-libc's own
   * \`__wasilibc_futex_wait_atomic_wait\`, which is what it replaces.
   */
  futexWait(addr, expected, maxWaitNs) {
    if ((addr & 3) !== 0) return -__WASI_EINVAL;
    const words = this.words();
    const word = addr >>> 2;
    if (word >= words.length) return -__WASI_EINVAL;
    if (Atomics.load(words, word) !== expected) return -__WASI_EAGAIN;
    const t = this.current;
    if (!t) {
      throw new Error('nimbus threads: futex_wait called outside a scheduled thread');
    }
    const ns = typeof maxWaitNs === 'bigint' ? maxWaitNs : BigInt(maxWaitNs === undefined ? -1 : maxWaitNs);
    const infinite = ns < 0n;
    const p = new Promise((resolve) => { t.settlePark = resolve; });
    t.state = 'parked';
    t.cond = { word, expected };
    if (!infinite) {
      // Capped at the park deadline: past the measured suspension ceiling a
      // parked promise never settles at all. Expiry INSIDE the cap is a real
      // ETIMEDOUT; expiry AT the cap is reported as a spurious wakeup, which
      // POSIX permits and every correct futex caller already re-checks for.
      const wantMs = Number(ns / 1000000n);
      const waitMs = Math.min(wantMs, __WASI_PARK_DEADLINE_MS);
      const timedOut = waitMs >= wantMs;
      this.pendingTimers++;
      t.timer = setTimeout(() => {
        t.timer = null;
        this.pendingTimers--;
        if (t.state !== 'parked') return;
        this.makeRunnable(t, timedOut ? -__WASI_ETIMEDOUT : __WASI_ESUCCESS);
        this.dispatch();
      }, waitMs);
    }
    this.current = null;
    this.dispatch();
    return p;
  }

  /**
   * sched_yield: go to the BACK of the run queue so peers get a turn. This is
   * also the primitive back-edge yield fuel will call once module builds carry
   * it, which is why it is a scheduler operation rather than a WASI detail.
   */
  yieldNow() {
    const t = this.current;
    if (!t || this.finished) return __WASI_ESUCCESS;
    let settle;
    const p = new Promise((resolve) => { settle = resolve; });
    t.state = 'runnable';
    t.resume = () => settle(__WASI_ESUCCESS);
    this.runQueue.push(t);
    this.current = null;
    this.dispatch();
    return p;
  }

  /**
   * A blocking WASI import parked the running thread on a host promise. Give
   * the token up while it waits, and take it back — through the run queue, not
   * ahead of it — once the host answers.
   *
   * The promise is the one \`withParkDeadline\` already guarded, so it always
   * settles; an unsettleable park would leave pendingIo raised and suppress
   * the deadlock verdict, which is exactly what that watchdog exists to stop.
   */
  parkIo(promise) {
    const t = this.current;
    if (!t || this.finished) return promise;
    t.state = 'parked';
    t.cond = null;
    this.pendingIo++;
    this.current = null;
    this.dispatch();
    const reacquire = (settle) => {
      this.pendingIo--;
      if (this.finished) return new Promise(() => {});  // the process is over; never resume
      return new Promise((resolve) => {
        t.state = 'runnable';
        t.resume = () => resolve(undefined);
        this.runQueue.push(t);
        this.dispatch();
      }).then(settle);
    };
    return promise.then(
      (v) => reacquire(() => v),
      (e) => reacquire(() => { throw e; }),
    );
  }
}

/**
 * Create the process scheduler and publish it to the WASI layer, which routes
 * its own parks through it. One facet is one process, so there is one
 * scheduler, held the same way __wasiFS and __wasiSup are.
 */
function __wasiThreadsCreate(opts) {
  __wasiThreads = new __WasiThreadScheduler(opts);
  return __wasiThreads;
}

/**
 * How a thread comes into existence: one more instance of the module the
 * loader pool compiled at startup, bound to the same imports — and therefore
 * the same shared memory, the same fd table and the same futex — entered at
 * the guest's own \`wasi_thread_start\`, which sets that instance's private
 * __stack_pointer and __tls_base from the start struct.
 *
 * Instantiating an already-compiled module is allowed at request time;
 * COMPILING one is not ("Wasm code generation disallowed by embedder"), so
 * nothing here may ever touch bytes.
 *
 * Returns a thunk rather than entering the guest, so a failed instantiation is
 * reported to pthread_create as EAGAIN while the thread body itself starts
 * only when the scheduler hands it the token.
 */
function __wasiThreadsStarter(module, importObject) {
  return function startThread(tid, startArg) {
    const child = new WebAssembly.Instance(module, importObject);
    const entry = child.exports['${WASI_THREAD_START_EXPORT}'];
    const promising = WebAssembly.promising(entry);
    return () => promising(tid, startArg);
  };
}

/**
 * The threaded analogue of __wasiRunStartAsync: _start becomes thread 1 and
 * the scheduler owns the process from there. Same result shape, so callers
 * branch on nothing but which entry point they used.
 */
function __wasiRunStartThreads(instance, sched) {
  const start = instance.exports._start;
  if (typeof start !== 'function') {
    return Promise.resolve({ exitCode: 1, error: '_start is not a function (got ' + typeof start + ')' });
  }
  if (typeof WebAssembly.promising !== 'function' || typeof WebAssembly.Suspending !== 'function') {
    // Loud rather than "threads that are function calls": without JSPI a
    // thread cannot be suspended, so the futex could not block and every
    // contended lock would be silently wrong.
    return Promise.resolve({
      exitCode: 1,
      error: 'wasi-threads requires JSPI (WebAssembly.promising / Suspending), which this runtime does not provide',
    });
  }
  return sched.runMain(WebAssembly.promising(start));
}

globalThis.__wasiThreadsCreate  = __wasiThreadsCreate;
globalThis.__wasiThreadsStarter = __wasiThreadsStarter;
globalThis.__wasiRunStartThreads = __wasiRunStartThreads;
// ── END: wasi-threads preamble ──────────────────────────────────────────────
`;
