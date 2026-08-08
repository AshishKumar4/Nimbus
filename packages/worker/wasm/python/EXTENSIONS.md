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
| artifact | **18.41 MiB**, built and measured | larger: dylink sections, libc as its own module, no cross-module DCE |
| new runtime code | **none** | 400–700 lines of linker, plus debugging |
| toolchain | the existing pinned `build-python.sh` | PIC sysroot + PIC rebuild of all five C deps + PIC CPython |
| facet restart to use a new package | **yes** | **yes** |

That last row is what decides it. Nimbus compiles wasm only in the Worker-Loader
child-init window, so the set of modules must be known *before* the facet boots.
`pip install numpy` followed by `import numpy` needs a facet restart under either
strategy. The linker buys a restart we were going to pay anyway.

### What it actually came to

Built, and driven through the real WASI host by
`tests/unit/cpython-wasi-sci.mjs`. numpy 2.4.3, thirteen compiled modules, plus
markupsafe's `_speedups`.

| | base | sci |
|---|---|---|
| interpreter, stripped | 10.60 MiB | **18.41 MiB** |
| gzipped | 3.49 MiB | 5.29 MiB |
| Python half beside it | — | `sci-packages.zip`, 1.21 MiB |

**The earlier ~15.1 MiB estimate was 3.3 MiB low.** It was extrapolated from
Pyodide's wheel (4.71 MiB across 13 modules) on the assumption that dropping
relocation and dylink sections would make a static build no larger. Two costs
were not in that model: numpy 2.4 compiles a large C++ surface — highway,
pocketfft, the string ufuncs, the npysort templates — which pulls in libc++, and
the reference LAPACK is 32-bit-Fortran-shaped code that does not shrink. Cold
compile is not restated here because it has not been re-measured on the variant;
the base figure below is the only measured one.

Sizes for numpy in Pyodide, for reference (`numpy-2.2.5`, Pyodide 0.29.4):
4.71 MiB across 13 compiled modules, plus 3.53 MiB of pure Python.

### What building numpy for wasm32-wasi took

Nobody had published one. It needs no numpy source changes for the *compile* —
Pyodide's recipe is a cross file and `-Dallow-noblas=true`, and that carries
over — but a static single-binary link needs four things a shared-object build
does not.

- **`longdouble_format` stated in the cross file.** numpy otherwise determines
  it by running a program, which a cross build cannot. wasm32 reports
  `__LDBL_MANT_DIG__ 113`, so it is IEEE quad, little-endian.
- **One copy of the reference LAPACK** (`patches/0002`). numpy compiles
  `lapack_lite/*.c` into both `lapack_lite` and `_umath_linalg`. Two copies in
  two `.so` files is waste; two copies in one binary is a duplicate-symbol error
  on every Fortran symbol.
- **A namespace for the legacy RNG build** (`patches/0003`). numpy compiles
  `distributions.c` twice, as `int64_t` for `Generator` and as `long` for
  `RandomState`. On wasm32 those differ in width, and wasm-ld reports the
  collision as a **warning** while binding one API's callers to the other's ABI.
  The rename set is derived from the object's symbol table, not from
  `distributions.h`: `random_geometric_inversion` is defined in the `.c` and
  declared in no header, so a set read from declarations misses it.
- **`-lc-printscan-long-double`.** wasi-libc's `printf` aborts on a long double
  rather than formatting one, and numpy formats one while importing. The symptom
  is a bare wasm trap at `import numpy`.

### The C++ exception gap, which is real and is not fixed

wasi-sdk 25's sysroot cannot link C++ exceptions at all: its libc++abi defines
no `__cxa_throw`, no `__cxa_allocate_exception` and no `__wasm_lpad_context`, so
neither the default model nor `-fwasm-exceptions` links. `-fno-exceptions`
instead does not build, because pocketfft throws — 207 errors, every one a
`throw`.

So `nimbus-cxx-noeh.c` supplies those entry points and makes a throw a loud
abort. numpy's C++ error paths — a malformed FFT shape, say — therefore take the
interpreter down with a named message instead of raising a Python exception.
Normal input is unaffected, and it fails closed rather than silently. **The fix
is a wasi-sdk whose libc++abi is built with exception support**, at which point
those definitions must be deleted or they will shadow the real ones.

### BLAS

Reference speed, via numpy's bundled f2c'd LAPACK (`-Dallow-noblas=true`).
Pyodide ships the same thing and nobody has built an optimised BLAS for either
target, so this matches the state of the art rather than falling short of it.
Correctness is not affected: `tests/unit/cpython-wasi-sci.mjs` pins both RNG
streams and the linalg results to what native numpy produces.

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
