# GNU bash → wasm32-wasi + Nimbus fork/exec/pipe — bring-up status

> Edited & maintained by Claude; presented as-is. Evidence-first. This is the
> `feat/fork-bash` scaffold for REAL-FORK-BASH-PLAN M4 (the acid test). It builds
> on the PROVEN-LIVE M1/M2 (fork/exec/waitpid over asyncify) and M3 (byte pipes +
> FdTable/OFD over the fabric) — see `scratchpad/fork-m1-report.md`,
> `fork-m2-report.md`, `fork-m3-bash-report.md`.

## What is proven (verbatim, 2026-07-20, wasi-sdk 25 / clang 19, host gcc 15)

- **Toolchain + source**: unmodified GNU bash 5.2.37 + wasi-sdk-25 (wasm32-wasi,
  wasi-libc, `-mllvm -wasm-enable-sjlj` for setjmp).
- **`./configure --host=wasm32-wasi` SUCCEEDS** (exit 0) with the cross-cache
  (`cross.cache`) answering the runtime probes it cannot execute, emitting a full
  `config.h` + Makefiles.
- **bash's own C compiles to wasm**: `general.o` (17 KB) and `eval.o` (5 KB)
  compile clean; `shell.c`/`execute_cmd.c`/`subst.c` compile once the *generated*
  `builtins/builtext.h` exists and the Makefile passes `-DCONF_MACHTYPE=…`.
- **The Nimbus process-ABI overlay (`nimbus-proc.c`) compiles clean to wasm**
  (135 KB obj) with a tight import surface: `nimbus_proc.{fork,vfork,execve,
  waitpid,pipe,dup2,dup,kill,setpgid,getpgid,getppid,tcsetpgrp,tcgetpgrp}`.

## The blockers that were root-caused and handled

| Blocker | Root cause | Handling |
|---|---|---|
| `mkbuiltins.c`: "too many arguments to xmalloc" | GCC-15/clang-19 default to C23 where `f()` means `(void)`; bash 5.2 uses K&R decls | `-std=gnu17` on both build-tool and target compiles |
| `setjmp.h #error … requires Exception handling` | wasi-libc gates setjmp behind wasm EH | `-mllvm -wasm-enable-sjlj` (emits `__wasm_setjmp/__wasm_longjmp/__wasm_setjmp_test` helper imports) |
| `fork/execve/pipe/dup2/waitpid` undeclared | wasi-libc guards them all behind `__wasilibc_unmodified_upstream` (absent) | Nimbus overlay `nimbus-proc.h` (decls) + `nimbus-proc.c` (impls → `nimbus_proc.*` host imports) |
| `unknown type name 'rlim_t'`, no `sys/wait.h` | wasi-libc has no rlimit/wait | provided in `nimbus-proc.h` |
| `struct passwd` incomplete, no `<pwd.h>` | wasi-libc has no pwd | `struct passwd` + `getpw*` in the overlay; keep `HAVE_PWD_H` off, `HAVE_GETPWNAM` on |
| `conflicting types for 'gethostname'` | bash redeclares it incompatibly with wasi-libc | `#define HAVE_GETHOSTNAME 1` in config.h |

## Remaining work to a RUNNING bash (honest, ordered)

1. **Finish the target build orchestration.** Let the real Makefile drive it with
   `CC_FOR_BUILD=gcc` (build tools native) and the target `CFLAGS` from
   `build-bash.sh`; ensure `builtins/builtext.h` generates (mkbuiltins runs on the
   host) before `execute_cmd.c`/`subst.c`. A couple of trivial header guards remain
   (`jobs.c` includes `<sgtty.h>` — provide an empty one or fix the `HAVE_SGTTY_H`
   guard). Estimate: a few hours.
2. **Link.** `bash.wasm` = all bash objects + `nimbus-proc.o` + the SjLj helpers
   `__wasm_setjmp/__wasm_longjmp` (from compiler-rt when linked with the EH-enabled
   runtime, or provide our own EH-based helpers). Verify the final import list is
   exactly preview1 (for file/clock/env I/O) + `nimbus_proc.*`.
3. **Asyncify — the decisive M4 blocker, now ROOT-CAUSED (2026-07-20).**
   `wasm-opt --asyncify` **cannot process a module built with clang's
   `-mllvm -wasm-enable-sjlj`.** Verified with the probe `probe-sjlj-asyncify.c`
   (setjmp + a `nimbus_proc.fork` import): asyncify aborts with
   `unexpected expression type / UNREACHABLE at Asyncify.cpp` on **both Binaryen
   112 and Binaryen 123** (latest) — so it is NOT a version bug that got fixed;
   Binaryen's asyncify pass fundamentally does not support the constructs clang's
   SjLj lowering emits. The collision is architectural: **bash requires
   setjmp/longjmp (→ EH-based SjLj), and fork requires asyncify, and the two meet
   at the asyncify pass.** The naive `-wasm-enable-sjlj` + `wasm-opt --asyncify`
   pipeline is a dead end.

   **Resolution (the real M4 work):** do NOT use clang's EH-based SjLj. Provide
   our own `__wasm_setjmp` / `__wasm_longjmp` / `__wasm_setjmp_test` implemented
   **on top of asyncify itself** — longjmp is semantically "unwind to an earlier
   saved point," which is exactly an asyncify rewind to a `setjmp`-captured
   buffer/label. This keeps the whole binary in the single stack-capture mechanism
   asyncify already provides (no wasm-EH in the module at all), so asyncify
   instruments cleanly. It co-designs with the fork unwind/rewind machinery
   already proven in M1/M2. This is a focused, well-scoped implementation task —
   the next concrete step for M4, provable in local node V8 (the M0 method) before
   any full bash link.
   (Alternative, rejected: patch bash to remove setjmp — violates "unmodified GNU
   bash" and is far more invasive than an asyncify-native setjmp shim.)
4. **Real-worker integration (the big one).** Add the `nimbus_proc.*` layer to the
   facet preamble (`wasi-instance.ts` — the per-instance-context refactor from
   WASI-S2 §5.2 is a prerequisite so two instances can share one facet), a
   fork-capable multi-instance process runner (the probe's `procfacet` logic,
   productionized: FdTable/OFD, PipeTable in the session DO, supervisor waitpid/
   exec re-homing), and route the exec-bit/shebang dispatch (`session/init.ts`) for
   `bash`/`#!/bin/bash` to it. Stage `bash.wasm` via the runtime catalog
   (`nimbus install bash`) + uutils coreutils for PATH.
5. **Live-gate.** Attach a terminal to a probe session, run `bash -c 'echo hi'`,
   then `echo a | tr a b`, `( … )`, `$( … )`, and a script file; capture verbatim.

## Reproduce

```
export WASI_SDK=/path/to/wasi-sdk-25.0-x86_64-linux
export BASH_SRC=/path/to/bash-5.2.37     # from ftp.gnu.org/gnu/bash
./build-bash.sh
```
`cross.cache` + `nimbus-proc.h` + `nimbus-proc.c` are the Nimbus-specific inputs;
everything else is stock bash + wasi-sdk.
