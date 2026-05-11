# wasi-threads — Hard Limit in Nimbus

**Status**: NOT IMPLEMENTED. Will NOT be implemented.
**Date**: 2026-05-11 (Stream-B P4 / B9)
**Author**: Stream-B wave; permanent reference

---

## §1. What is wasi-threads?

`wasi-threads` is a proposal that extends WASI preview1 with one extra
import:

```
wasi_snapshot_preview1.thread_spawn(start_arg: i32) → tid
// Plus a corresponding wasm-side export:
//   wasi_thread_start(tid: i32, start_arg: i32) → ()
```

When the host runtime processes `thread_spawn`, it must instantiate a
new instance of the SAME wasm module, with the SAME linear memory
shared, and run `wasi_thread_start` on it. This is the WASI bridge for
`pthread_create(3)`.

The reference implementation is in wasmtime (https://github.com/bytecodealliance/wasmtime/tree/main/crates/wasi-threads) and requires:

1. `(memory $mem ... shared)` — the wasm linear memory declared shared.
2. `<atomic ops>` — emitted by the threaded toolchain (LLVM `-pthread`).
3. The host runtime to allocate a thread, instantiate a sibling
   instance, and arrange for the sibling instance's exports to see the
   parent's memory.

---

## §2. Why this is infeasible in Nimbus

Nimbus runs each request inside a child-facet isolate spawned via the
Cloudflare Workers Loader API (`env.LOADER.get(...)`). Each isolate has
its OWN `WebAssembly.Memory`. There is no API in workerd that allows
two isolates to share a linear memory object.

Specifically:

| Requirement | Workerd today |
|---|---|
| `new WebAssembly.Memory({ shared: true, ... })` | Supported in V8, but the resulting `SharedArrayBuffer` cannot cross isolate boundaries in workerd. |
| `postMessage(memory, [memory.buffer])` to transfer | `SharedArrayBuffer` is not transferable in workerd's `MessagePort` impl. |
| Spawn a sibling isolate with pre-shared memory | No such API. `env.LOADER.get(id)` returns a fresh isolate with its own globals + heap. |
| `Atomics.wait` / `Atomics.notify` | Available within ONE isolate; useless across isolates without shared memory. |

The Workers concurrency model is **request-scoped isolates with no
shared mutable state**. Adding wasi-threads would require breaking that
model, which is architecturally fundamental to how Workers scales.

---

## §3. Workarounds considered and rejected

### 3.1 Spawn sibling LOADER facet + message-pass

Possible: each `thread_spawn` could allocate a new facet via
`env.LOADER.get(...)` and dispatch the user-code function in it.

**Why rejected**: this is the Web Workers memory model, not the
pthread memory model. The new "thread" gets its own copy of linear
memory. Any pthread program that uses:

- Shared mutable state across threads (e.g. `pthread_mutex_lock` on a
  global lock).
- Producer-consumer queues backed by a circular buffer in memory.
- `_Atomic` integers for lock-free flags.
- `pthread_cond_wait` on a shared condition.

...will compile, link, and load — but will silently produce wrong
results at runtime because writes from one "thread" are invisible to
the other. This is WORSE than a clean link-time error: users would file
bugs about "Rust async-runtime X is broken" with no obvious cause.

### 3.2 Asyncify-emulated pthreads on a single isolate

Possible: compile user code with Asyncify-style stack instrumentation
so that `pthread_create` becomes a cooperative scheduler.

**Why rejected**:
1. Massive binary-size penalty (Asyncify roughly doubles wasm size).
2. Requires a recompile of wasi-libc + the user's code with the
   instrumentation pass. Nimbus can't impose this on opaque user-supplied
   .wasm.
3. Still doesn't fix the memory model — Asyncify gives cooperative
   threads in one address space, but `Atomics.wait` becomes a busy-loop
   because there's only one execution context.

### 3.3 Wait for workerd to gain shared-memory primitives

Possible future scenario: Cloudflare adds a way to share
`SharedArrayBuffer` across isolates.

**Status**: no public roadmap signal as of 2026-05-11. Tracking via:
- https://github.com/cloudflare/workerd/labels/feature-request
- https://github.com/cloudflare/workerd/issues?q=is%3Aissue+%22shared+memory%22+OR+%22wasi-threads%22

If this lands, this document should be revisited.

---

## §4. What Nimbus does instead

The `wasi_snapshot_preview1.thread_spawn` import is **NOT** in our
shim's import table at `src/runtime/wasi-instance.ts:__wasiMakeImports`.

Consequence at link time:
```
wasm-ld: error: undefined symbol: thread_spawn
>>> referenced by libwasi-emulated-pthreads.a(...)
```

User-visible: any attempt to compile a pthreaded program with `-pthread`
fails with a clear linker error, NOT a runtime memory-corruption bug.
Users see the failure at build time and can choose to:

1. Compile without `-pthread` (single-threaded execution).
2. Restructure their code to use async I/O instead of threads.
3. Run their workload outside of Nimbus on a runtime that supports
   wasi-threads (e.g. wasmtime).

This is the **honest dishonest** answer: pretend threads are an option
and you'll silently corrupt user data. Refuse them at link time and
users find out early.

---

## §5. Adjacent surfaces that DO work

- `wasi-libc-modern`'s emulated pthreads (`-lwasi-emulated-pthread`):
  these provide a stub `pthread_create` that returns `ENOSYS`. User
  code can probe with `pthread_create` and fall back gracefully. We
  don't actively support this, but we don't block it either.
- `cloudflare:sockets` for outbound TCP (Stream-B B7) — most async I/O
  use cases that motivate threading can be solved with non-blocking
  sockets + `poll_oneoff` (Stream-B B8) instead.
- Web Workers-style concurrency: the user can fork their architecture
  to use multiple Nimbus sessions / multiple HTTP requests. Each is
  isolated; they communicate via the user-VFS or HTTP. This is the
  Workers-native concurrency model and works well for embarrassingly-
  parallel workloads.

---

## §6. Decision authority

Stream-B P4 (B9). Documented as a hard limit per the master plan's
§2.B9 directive: "do NOT expose the `wasi_thread_start` import.
If user code needs it, the build fails with a clear link error rather
than a runtime memory-safety bug."

Revisit only if workerd publishes a shared-memory primitive.
