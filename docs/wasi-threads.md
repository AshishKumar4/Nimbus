# WASI Threads

Nimbus does not implement `wasi-threads`.

`wasi-threads` requires the host to instantiate a second copy of the same
WebAssembly module with the same shared linear memory and then run
`wasi_thread_start` in that sibling instance. Cloudflare Workers do not expose
a way for Worker Loader isolates to share a `WebAssembly.Memory` object.

| Requirement | Workers runtime |
|---|---|
| Shared wasm linear memory across isolates | Not available |
| Transfer `SharedArrayBuffer` through Worker Loader messaging | Not available |
| Spawn a sibling isolate with pre-shared memory | Not available |
| Use `Atomics.wait` across isolate-local memories | Not meaningful |

Nimbus therefore omits `thread_spawn` from the WASI import table. Programs that
require pthread-style shared-memory execution fail at build or link time instead
of running with incorrect memory semantics.

Supported alternatives:

- compile single-threaded WASI programs
- use asynchronous I/O and `poll_oneoff`
- split parallel work across independent Nimbus sessions or HTTP requests
- run pthread-dependent workloads on a runtime that supports shared wasm memory

This decision should be revisited only if the Workers runtime exposes a stable
shared-memory primitive for Worker Loader isolates.
