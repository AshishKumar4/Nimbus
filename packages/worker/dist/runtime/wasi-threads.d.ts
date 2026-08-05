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
export declare const WASI_THREADS_NAMESPACE = "wasi";
/** The import namespace carrying Nimbus's software futex. */
export declare const NIMBUS_THREADS_NAMESPACE = "nimbus_threads";
/** The guest export a wasi-threads module must provide. */
export declare const WASI_THREAD_START_EXPORT = "wasi_thread_start";
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
export declare function inspectWasmThreads(bytes: Uint8Array): WasmThreadsInfo;
/**
 * Why this module cannot be run with threads, or null when it can.
 *
 * Every unsupported shape fails HERE — at load, with the remedy — rather than
 * part-way through a run with corrupted memory semantics. A module that does
 * not ask for threads at all is not this function's business and returns null.
 */
export declare function wasiThreadsLoadError(info: WasmThreadsInfo): string | null;
/**
 * Source string appended to the WASI preamble. Evaluated verbatim in the facet
 * isolate, where the thread instances live — self-contained apart from the
 * constants and the `__wasiThreads` slot the WASI preamble declares.
 */
export declare const WASI_THREADS_PREAMBLE_SRC = "\n// \u2500\u2500 BEGIN: wasi-threads preamble (green-thread scheduler + software futex) \u2500\u2500\u2500\n// Source mirror: src/runtime/wasi-threads.ts. Keep in sync by hand.\n\n// wasi-libc gives the main thread tid 1 and expects the host to allocate\n// spawned tids above it; musl stores the tid as the mutex owner word, so a\n// collision would make one thread able to unlock another's mutex.\nconst __WASI_THREAD_MAIN_TID = 1;\n\n// A green thread costs an instance (its own globals + stack in shared memory),\n// so an unbounded spawn loop is a memory fault with no error. pthread_create\n// reports EAGAIN for exactly this, and the guest's own error path handles it.\nconst __WASI_THREADS_MAX = 128;\n\n/**\n * The scheduler. Owns every green thread and decides which one may run.\n *\n * It knows nothing about WebAssembly on purpose: `startThread` is supplied by\n * whoever owns the compiled module, which keeps the \"one startup-compiled\n * module, instantiated per thread, never recompiled\" rule where the module is.\n */\nclass __WasiThreadScheduler {\n  constructor(opts) {\n    // Re-read through .buffer on every access: a shared memory can grow, and a\n    // grown memory means a new backing buffer.\n    this.memory = opts.memory;\n    // (tid, startArg) -> Promise, resolving when that thread's body returns.\n    this.startThread = opts.startThread;\n    this.threads = [];            // creation order \u2014 the scheduling pass walks this\n    this.nextTid = __WASI_THREAD_MAIN_TID + 1;\n    this.current = null;          // the one thread holding the token\n    this.runQueue = [];\n    this.pendingIo = 0;           // threads parked on a host promise\n    this.pendingTimers = 0;       // futex waits with a live timer\n    this.finished = null;         // { exitCode, error } once the process ends\n    this.settleProcess = null;\n    this.spawnError = null;       // why the last thread-spawn returned EAGAIN\n  }\n\n  words() { return new Int32Array(this.memory.buffer); }\n\n  live() {\n    let n = 0;\n    for (const t of this.threads) if (t.state !== 'exited') n++;\n    return n;\n  }\n\n  // \u2500\u2500 Import table \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n  //\n  // thread-spawn returns i32 synchronously and must NOT be Suspending; futex\n  // waits park the caller and must be.\n  hostImports() {\n    const spawn = (startArg) => this.spawn(startArg | 0);\n    const futexWait = (addr, expected, maxWaitNs) => this.futexWait(addr | 0, expected | 0, maxWaitNs);\n    const suspending = (typeof WebAssembly !== 'undefined' && typeof WebAssembly.Suspending === 'function')\n      ? new WebAssembly.Suspending(futexWait)\n      : futexWait;\n    return {\n      'wasi': { 'thread-spawn': spawn },\n      'nimbus_threads': { futex_wait: suspending },\n    };\n  }\n\n  // \u2500\u2500 Thread lifecycle \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n  record(tid) {\n    return {\n      tid,\n      state: 'runnable',   // runnable | running | parked | exited\n      cond: null,          // { word, expected } while futex-parked\n      timer: null,\n      settlePark: null,\n      resume: null,\n    };\n  }\n\n  /**\n   * wasi-threads `thread-spawn`: allocate a tid, hand the guest's start\n   * struct to a fresh instance, and queue it. Returns the tid, or a negative\n   * value the guest's pthread_create turns into EAGAIN.\n   *\n   * The child does not run here \u2014 the spawning thread keeps the token and runs\n   * to its next park, which is what run-to-park means and what makes the\n   * ordering reproducible.\n   */\n  spawn(startArg) {\n    if (this.finished) return -__WASI_EAGAIN;\n    if (this.live() >= __WASI_THREADS_MAX) return -__WASI_EAGAIN;\n    const t = this.record(this.nextTid);\n    let begin;\n    try {\n      begin = this.startThread(t.tid, startArg);\n    } catch (e) {\n      // Instantiating the shared module failed (out of memory for the\n      // instance, or a host defect). The guest sees EAGAIN, which is the\n      // errno pthread_create already documents for \"cannot create thread\".\n      this.spawnError = 'thread-spawn failed: ' + ((e && e.message) ? e.message : String(e));\n      return -__WASI_EAGAIN;\n    }\n    this.nextTid++;\n    this.threads.push(t);\n    t.resume = () => {\n      let entered;\n      try {\n        entered = begin();\n      } catch (e) {\n        this.onThreadSettled(t, e);\n        return;\n      }\n      Promise.resolve(entered).then(() => this.onThreadSettled(t, null), (e) => this.onThreadSettled(t, e));\n    };\n    this.runQueue.push(t);\n    return t.tid;\n  }\n\n  /**\n   * Run the process. `enter` is the main thread's promising entry (_start).\n   * Resolves with the same shape __wasiRunStart returns.\n   */\n  runMain(enter) {\n    const t = this.record(__WASI_THREAD_MAIN_TID);\n    t.state = 'running';\n    this.threads.push(t);\n    this.current = t;\n    const done = new Promise((resolve) => { this.settleProcess = resolve; });\n    let entered;\n    try {\n      entered = enter();\n    } catch (e) {\n      this.onThreadSettled(t, e);\n      return done;\n    }\n    Promise.resolve(entered).then(() => this.onThreadSettled(t, null), (e) => this.onThreadSettled(t, e));\n    return done;\n  }\n\n  onThreadSettled(t, err) {\n    t.state = 'exited';\n    if (t.timer !== null) { clearTimeout(t.timer); t.timer = null; this.pendingTimers--; }\n    if (this.current === t) this.current = null;\n    if (err) {\n      // proc_exit from ANY thread ends the process, which is POSIX exit(3).\n      if (err && err.constructor && err.constructor.name === '__WasiExit') {\n        this.endProcess({ exitCode: err.code });\n        return;\n      }\n      this.endProcess({\n        exitCode: 1,\n        error: 'thread ' + t.tid + ': ' + ((err && err.message) ? err.message : String(err)),\n      });\n      return;\n    }\n    // The main thread returning ends the process and every thread with it \u2014\n    // POSIX semantics for exit(3), and the same rule ruby-green-threads\n    // applies when its main body finishes.\n    if (t.tid === __WASI_THREAD_MAIN_TID) {\n      this.endProcess({ exitCode: 0 });\n      return;\n    }\n    this.dispatch();\n  }\n\n  endProcess(result) {\n    if (this.finished) return;\n    this.finished = result;\n    this.current = null;\n    this.runQueue.length = 0;\n    for (const t of this.threads) {\n      if (t.timer !== null) { clearTimeout(t.timer); t.timer = null; }\n    }\n    this.pendingTimers = 0;\n    if (__wasiThreads === this) __wasiThreads = null;\n    // A failed spawn is reported to the guest as EAGAIN and usually surfaces\n    // as its own error message; if the program died without one, say why.\n    if (this.spawnError && !result.error && result.exitCode !== 0) result.error = this.spawnError;\n    this.settleProcess(result);\n  }\n\n  // \u2500\u2500 The token \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n  /**\n   * One scheduling pass, then hand the token to the head of the run queue.\n   *\n   * The pass walks the threads in creation order and makes runnable every one\n   * whose futex predicate now holds. It runs at every park, yield and exit \u2014\n   * the only moments memory can have changed \u2014 which is what makes the\n   * level-triggered futex complete and the deadlock verdict exact.\n   */\n  dispatch() {\n    if (this.finished || this.current) return;\n    const words = this.words();\n    for (const t of this.threads) {\n      if (t.state !== 'parked' || t.cond === null) continue;\n      if (Atomics.load(words, t.cond.word) !== t.cond.expected) this.makeRunnable(t, __WASI_ESUCCESS);\n    }\n    const next = this.runQueue.shift();\n    if (!next) { this.checkIdle(); return; }\n    this.current = next;\n    next.state = 'running';\n    const go = next.resume;\n    next.resume = null;\n    // Always a fresh task: a spawned thread's first entry runs wasm\n    // synchronously, and doing that from the parking thread's stack would nest\n    // one JS frame per context switch.\n    queueMicrotask(go);\n  }\n\n  makeRunnable(t, code) {\n    t.state = 'runnable';\n    t.cond = null;\n    if (t.timer !== null) { clearTimeout(t.timer); t.timer = null; this.pendingTimers--; }\n    const settle = t.settlePark;\n    t.settlePark = null;\n    t.resume = () => settle(code);\n    this.runQueue.push(t);\n  }\n\n  /**\n   * Nothing is runnable. Either the process is winding down, or every live\n   * thread is blocked on a predicate no thread can ever satisfy \u2014 which is a\n   * deadlock, provable rather than suspected, and reported instead of hung.\n   */\n  checkIdle() {\n    if (this.finished || this.current || this.runQueue.length) return;\n    if (this.pendingIo > 0 || this.pendingTimers > 0) return;\n    const blocked = [];\n    for (const t of this.threads) if (t.state === 'parked') blocked.push(t.tid);\n    if (!blocked.length) return;\n    this.endProcess({\n      exitCode: 1,\n      error: 'deadlock: every thread is blocked and nothing can wake them (tids '\n        + blocked.join(', ') + ')',\n    });\n  }\n\n  // \u2500\u2500 The park set \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n  /**\n   * The software futex. Returns 0 when woken, -EAGAIN when the word already\n   * moved (the race-free check uses the atomic load, which works \u2014 only\n   * Atomics.wait is blocked), and -ETIMEDOUT when a finite deadline expires.\n   * Mirrors the return contract of wasi-libc's own\n   * `__wasilibc_futex_wait_atomic_wait`, which is what it replaces.\n   */\n  futexWait(addr, expected, maxWaitNs) {\n    if ((addr & 3) !== 0) return -__WASI_EINVAL;\n    const words = this.words();\n    const word = addr >>> 2;\n    if (word >= words.length) return -__WASI_EINVAL;\n    if (Atomics.load(words, word) !== expected) return -__WASI_EAGAIN;\n    const t = this.current;\n    if (!t) {\n      throw new Error('nimbus threads: futex_wait called outside a scheduled thread');\n    }\n    const ns = typeof maxWaitNs === 'bigint' ? maxWaitNs : BigInt(maxWaitNs === undefined ? -1 : maxWaitNs);\n    const infinite = ns < 0n;\n    const p = new Promise((resolve) => { t.settlePark = resolve; });\n    t.state = 'parked';\n    t.cond = { word, expected };\n    if (!infinite) {\n      // Capped at the park deadline: past the measured suspension ceiling a\n      // parked promise never settles at all. Expiry INSIDE the cap is a real\n      // ETIMEDOUT; expiry AT the cap is reported as a spurious wakeup, which\n      // POSIX permits and every correct futex caller already re-checks for.\n      const wantMs = Number(ns / 1000000n);\n      const waitMs = Math.min(wantMs, __WASI_PARK_DEADLINE_MS);\n      const timedOut = waitMs >= wantMs;\n      this.pendingTimers++;\n      t.timer = setTimeout(() => {\n        t.timer = null;\n        this.pendingTimers--;\n        if (t.state !== 'parked') return;\n        this.makeRunnable(t, timedOut ? -__WASI_ETIMEDOUT : __WASI_ESUCCESS);\n        this.dispatch();\n      }, waitMs);\n    }\n    this.current = null;\n    this.dispatch();\n    return p;\n  }\n\n  /**\n   * sched_yield: go to the BACK of the run queue so peers get a turn. This is\n   * also the primitive back-edge yield fuel will call once module builds carry\n   * it, which is why it is a scheduler operation rather than a WASI detail.\n   */\n  yieldNow() {\n    const t = this.current;\n    if (!t || this.finished) return __WASI_ESUCCESS;\n    let settle;\n    const p = new Promise((resolve) => { settle = resolve; });\n    t.state = 'runnable';\n    t.resume = () => settle(__WASI_ESUCCESS);\n    this.runQueue.push(t);\n    this.current = null;\n    this.dispatch();\n    return p;\n  }\n\n  /**\n   * A blocking WASI import parked the running thread on a host promise. Give\n   * the token up while it waits, and take it back \u2014 through the run queue, not\n   * ahead of it \u2014 once the host answers.\n   */\n  parkIo(promise) {\n    const t = this.current;\n    if (!t || this.finished) return promise;\n    t.state = 'parked';\n    t.cond = null;\n    this.pendingIo++;\n    this.current = null;\n    this.dispatch();\n    const reacquire = (settle) => {\n      this.pendingIo--;\n      if (this.finished) return new Promise(() => {});  // the process is over; never resume\n      return new Promise((resolve) => {\n        t.state = 'runnable';\n        t.resume = () => resolve(undefined);\n        this.runQueue.push(t);\n        this.dispatch();\n      }).then(settle);\n    };\n    return promise.then(\n      (v) => reacquire(() => v),\n      (e) => reacquire(() => { throw e; }),\n    );\n  }\n}\n\n/**\n * Create the process scheduler and publish it to the WASI layer, which routes\n * its own parks through it. One facet is one process, so there is one\n * scheduler, held the same way __wasiFS and __wasiSup are.\n */\nfunction __wasiThreadsCreate(opts) {\n  __wasiThreads = new __WasiThreadScheduler(opts);\n  return __wasiThreads;\n}\n\n/**\n * How a thread comes into existence: one more instance of the module the\n * loader pool compiled at startup, bound to the same imports \u2014 and therefore\n * the same shared memory, the same fd table and the same futex \u2014 entered at\n * the guest's own `wasi_thread_start`, which sets that instance's private\n * __stack_pointer and __tls_base from the start struct.\n *\n * Instantiating an already-compiled module is allowed at request time;\n * COMPILING one is not (\"Wasm code generation disallowed by embedder\"), so\n * nothing here may ever touch bytes.\n *\n * Returns a thunk rather than entering the guest, so a failed instantiation is\n * reported to pthread_create as EAGAIN while the thread body itself starts\n * only when the scheduler hands it the token.\n */\nfunction __wasiThreadsStarter(module, importObject) {\n  return function startThread(tid, startArg) {\n    const child = new WebAssembly.Instance(module, importObject);\n    const entry = child.exports['wasi_thread_start'];\n    const promising = WebAssembly.promising(entry);\n    return () => promising(tid, startArg);\n  };\n}\n\n/**\n * The threaded analogue of __wasiRunStartAsync: _start becomes thread 1 and\n * the scheduler owns the process from there. Same result shape, so callers\n * branch on nothing but which entry point they used.\n */\nfunction __wasiRunStartThreads(instance, sched) {\n  const start = instance.exports._start;\n  if (typeof start !== 'function') {\n    return Promise.resolve({ exitCode: 1, error: '_start is not a function (got ' + typeof start + ')' });\n  }\n  if (typeof WebAssembly.promising !== 'function' || typeof WebAssembly.Suspending !== 'function') {\n    // Loud rather than \"threads that are function calls\": without JSPI a\n    // thread cannot be suspended, so the futex could not block and every\n    // contended lock would be silently wrong.\n    return Promise.resolve({\n      exitCode: 1,\n      error: 'wasi-threads requires JSPI (WebAssembly.promising / Suspending), which this runtime does not provide',\n    });\n  }\n  return sched.runMain(WebAssembly.promising(start));\n}\n\nglobalThis.__wasiThreadsCreate  = __wasiThreadsCreate;\nglobalThis.__wasiThreadsStarter = __wasiThreadsStarter;\nglobalThis.__wasiRunStartThreads = __wasiRunStartThreads;\n// \u2500\u2500 END: wasi-threads preamble \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n";
//# sourceMappingURL=wasi-threads.d.ts.map