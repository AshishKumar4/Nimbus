# WASI Threads

Nimbus implements `wasi-threads`. pthread programs — mutexes, condition
variables, `pthread_join`, thread-local storage, barriers, semaphores,
`pthread_once` — run correctly.

They do not run in parallel. One core, one thread at a time. A CPU-bound
program with four threads finishes with the right answer and no faster than the
single-threaded version, plus context-switch overhead. Correctness and
compatibility are what this buys; speedup is not on offer.

## How it works

A Nimbus process is one isolate, and threads of one process never leave it, so
they need no cross-isolate primitive:

- One `WebAssembly.Memory`, created `shared: true` by the host.
- One module, compiled when the facet loads and instantiated once per thread.
  Every instance addresses the same linear memory and gets its **own globals**,
  which is where each thread's `__stack_pointer` and `__tls_base` live. TLS
  needs no host emulation: `wasi_thread_start` sets both from the start struct
  the spawning thread allocated.
- One cooperative scheduler — round-robin, run-to-park, creation order, exactly
  one thread executing at a time. Memory is genuinely shared; access to it is
  serialised, which is what makes correctness reachable.
- One software futex. `Atomics.wait` throws on Workers and the
  `memory.atomic.wait32` instruction traps for the same reason, so blocking is a
  host park: the waiter registers a predicate — `*addr != val` — and yields.
  There is no wake call. Every scheduling pass re-tests every waiter, so the
  futex is level-triggered and a lost wakeup is not expressible.

That last property also makes deadlock detection exact rather than heuristic.
If every live thread is parked on a predicate, none holds, and no host I/O or
timer is outstanding, then no thread can run, so memory can never change, so no
predicate can ever become true. Nimbus says so instead of hanging:

```
deadlock: every thread is blocked and nothing can wake them (tids 1, 2)
```

The implementation is `packages/worker/src/runtime/wasi-threads.ts`. It is the
host-side sibling of `runtime/ruby-green-threads.ts`, which runs the same model
inside the Ruby VM over fibers — one concurrency model at two layers.

## Building a program

```
clang --target=wasm32-wasip1-threads --sysroot=<wasi-sysroot> -pthread -O2 \
  -Wl,--import-memory,--shared-memory,--max-memory=67108864 \
  -o prog.wasm prog.c packages/worker/runtime-contracts/nimbus-threads.c
```

Three requirements, each checked before the program runs:

- **`--import-memory --shared-memory`.** The host creates the memory so every
  thread instance binds to the same one. A module that defines its own memory
  would give each thread a private address space.
- **`wasi_thread_start` exported.** The wasi-threads entry point; `-pthread`
  emits it.
- **`nimbus-threads.c` linked.** wasi-libc compiles its futex wait to
  `memory.atomic.wait32`, which traps on Workers with *"Atomics.wait cannot be
  called in this context"* the first time a lock is contended. wasi-libc calls
  the weak symbol `__wasilibc_futex_wait_maybe_busy` instead whenever something
  defines it; that file defines it, routing every blocking pthread operation to
  the host futex. The hook is wasi-libc's own — no patched libc, no binary
  rewriting.

A build missing any of these is rejected at load with the build line in the
error, rather than run in a way that could corrupt.

## Limits

- **No parallelism.** Every resident Nimbus process is a Durable Object Facet,
  and facet siblings serialise on CPU, so there is no independent-CPU substrate
  to offload to. This is a property of the platform, not a pending feature.
- **No preemption yet.** A thread that never reaches a blocking operation — a
  bare spin loop, a tight compute loop — holds the process until it does. A
  spinlock that calls `sched_yield()` is fine; one that does not will hang.
  Nimbus controls the module build, so back-edge yield fuel can fix this, and
  that is the next step.
- **Timing-dependent code behaves differently.** Execution is serialised, so
  interleavings a real scheduler would produce do not occur. Code whose
  correctness depends on a data race is undefined behaviour under pthreads
  anyway; here it is more deterministic, not less.
- **128 threads.** Each one is an instance plus a stack in shared memory. Past
  the cap `pthread_create` returns `EAGAIN`, which is what it documents for a
  thread that cannot be created.
- **Emscripten pthreads are not supported.** That model needs a Web Worker pool
  and `Atomics.wait`, neither of which exists here. Python (Pyodide) is an
  Emscripten build, so this does not give Python threads.

## Platform facts this rests on

Measured in a Durable Object at compatibility date 2026-04-01:

| | |
|---|---|
| Two instances of one module, one shared `WebAssembly.Memory` | Writes and atomic RMWs visible across instances; globals independent per instance |
| Distinct JSPI-suspended instances resumed round-robin | Trace `[0,1,2,0,1,2,…]` — a scheduler, not run-to-completion |
| `Atomics.load/store/add/compareExchange/notify`, `waitAsync` | Work |
| `Atomics.wait`, `memory.atomic.wait32` | Throw — hence the software futex |
| `WebAssembly.compile(bytes)` at request time | Blocked — hence one startup-compiled module, instantiated per thread |
| `new WebAssembly.Instance(module)` at request time | Allowed |
