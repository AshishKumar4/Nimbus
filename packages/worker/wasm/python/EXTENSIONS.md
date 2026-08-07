# Compiled Python extensions on wasm32-wasi

*This document is edited and maintained by Claude, and is presented as-is.*

How a compiled package — numpy is the one that matters — reaches this
interpreter, what it costs, and which routes are closed. Numbers here are
measured unless marked otherwise; the method is recorded so they can be
re-taken rather than trusted.

## The decision

**Static linking, in a small number of prebuilt interpreter variants.** A base
build, and one with the scientific set linked in, selected at spawn from what
the session actually installed.

The alternative was a WebAssembly runtime linker: build CPython position-
independent, ship each extension as a wasm side module, and resolve them in the
host at instantiation. That is what Pyodide does — its shipping artifact imports
`GOT.mem` and `GOT.func`, which is the dynamic-linking ABI.

It loses on every axis once the numbers are in front of you.

| | static variant | runtime linker |
|---|---|---|
| artifact | 10.61 + ~4.5 = **~15.1 MiB** | larger: dylink sections, libc as its own module, no cross-module DCE |
| cold compile | **~211 ms** (+63 ms over base) | at least that, same child-init window |
| new runtime code | **none** | 400–700 lines of linker, plus debugging |
| toolchain | the existing pinned `build-python.sh` | PIC sysroot + PIC rebuild of all five C deps + PIC CPython |
| facet restart to use a new package | **yes** | **yes** |

That last row is what decides it. Nimbus compiles wasm only in the Worker-Loader
child-init window, so the set of modules must be known *before* the facet boots.
`pip install numpy` followed by `import numpy` needs a facet restart under either
strategy. The linker buys a restart we were going to pay anyway.

Sizes for numpy are measured from Pyodide's own wheel (`numpy-2.2.5`, Pyodide
0.29.4): **4.71 MiB** across 13 compiled modules, plus 3.53 MiB of pure Python.
A static wasi build should land at or below that, since it drops the per-module
relocation and dylink sections and shares one libc.

### What static linking costs, stated plainly

The compiled-package set is fixed at build time. Pure-Python wheels — most of
PyPI — install normally through pip and are unaffected. Adding a compiled
package is a CI rebuild of one variant, not a runtime feature. `build-python.sh`
is pinned and checksummed, so that rebuild is reproducible.

BLAS/LAPACK is reference-speed either way. Pyodide ships `lapack_lite` at
0.20 MiB of f2c'd LAPACK and nobody has built an optimised BLAS for either
target; matching that is the ceiling, not a regression.

### Variants are selected by state, not by prediction

Two variants are a capability split only if something has to *guess* which one a
program needs. This one does not: the variant follows what the session installed,
which is real state. That is why it is acceptable here and why the
asyncify-vs-JSPI question below was **not** allowed to become a variant — that
one would have to be decided per program, by guessing whether a script will bind
a port, and guessing wrong reproduces the bug it was meant to fix.

## Closed: asyncify

**Do not reopen this without new evidence.** It was investigated because a
resident server appeared to need a suspension substrate that survives a request
boundary, and because Pyodide was believed to be asyncified.

Both premises were wrong.

- **Pyodide is not asyncified.** Its shipping `pyodide.asm.wasm` has 9,708
  exports and not one `asyncify_*` among them. `runPythonAsync` is Python-level
  `asyncio` and `pyodide.http.pyfetch` is an `async def` coroutine; neither needs
  a suspended native stack.
- **A resident server does not need one either.** `serve_forever()` registers the
  server and returns, the program runs to completion, and each inbound request
  re-enters the interpreter and dispatches one connection into the object left on
  the Python heap. See `python-server-adapter.ts`.

### The recorded tax, if anyone proposes it anyway

Measured on this interpreter, Binaryen 112, with the minimal import allowlist
(`sock_accept`, `sock_recv`, `sock_send`, `poll_oneoff`, `fd_read`, `fd_write`,
`fd_pread`, `path_filestat_get`):

| | stripped | gzip | cold compile |
|---|---|---|---|
| baseline (JSPI) | 10.61 MiB | 3.6 MiB | **148 ms** (measured live) |
| asyncified | **33.89 MiB** | 12.45 MiB | ~473 ms (projected at the measured rate) |

**3.19×, and `--pass-arg=asyncify-imports@…` does not bound it.** That flag limits
which *imports* trigger an unwind; Binaryen still instruments every *function*
that can transitively reach one. Bash's asyncify tax is bounded because bash is
small with a shallow call graph. In CPython, `ceval` reaches everything through
indirect calls, so "can reach `fd_read`" is very nearly the whole interpreter.

`asyncify-onlylist` would let the instrumented set be named explicitly, but
deriving a correct one by hand for CPython's call graph is not tractable, and an
omission is silent stack corruption rather than a failure — see the note in
`../bash/build-bash.sh` about `poll_oneoff` missing from bash's own list.

Two further consequences worth knowing: 12.45 MiB gzipped exceeds the 10 MiB
Worker script limit (production delivers via R2, so this constrains test rigs
rather than shipping), and asyncify is a **host protocol**, not a build flag. The
shared `wasi/preamble.ts` suspends via JSPI; driving an asyncified guest needs
`asyncify_start_unwind`/`stop_rewind` and per-stack buffer management, which
exists only in bash's private preamble. Adding it would mean either a second WASI
host for Python — the thing this migration deleted 2,918 lines to remove — or
teaching the shared host two suspension modes.

## Method, so the numbers can be re-taken

Cold compile is measured on a throwaway Worker with only a `worker_loaders`
binding, timing client-side: the in-worker clock does not advance through
CPU-only work. Each timed boot uses a **fresh loader id** carrying identical
bytes, which is the production scenario — there is no compiled-artifact cache
across loader instances or across isolate turnover, so every cold session
recompiles. Subtract a floor measured the same way with an 8-byte module.

Measured for this interpreter: floor 69 ms, interpreter 217 ms, **net 148 ms**
over 10,863 KB = **0.01362 ms/KB** — which independently reproduces the
0.0138 ms/KB in `scratchpad/wasm-perf-levers.md` from a different module.
