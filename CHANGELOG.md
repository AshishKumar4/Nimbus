# Changelog

All notable changes to Nimbus. Dates are UTC. Each entry links to its commit
range so claims are traceable to code.

The version field tracks `src/constants.ts:NIMBUS_VERSION`. Releases follow
calendar-versioned waves rather than semver, because each wave delivers a
behavioral surface rather than an API revision.

---

## 2026-05-11 — Stream A + Stream B + Stream C + Bug-Sweeps R1–R4

Massive multi-stream day. 91 commits between `0f37108` and `2268c1b`. Probe
suite grew from 91 to 183. The new surfaces are below, grouped by stream;
each bullet names the canonical commit(s) and the behavioral probe path that
locks the behavior in.

### Stream A — Interactive REPL across four runtimes

Honest framing: `python` / `ruby` get real stateful interpreters (Pyodide
`PyodideConsole` + long-lived ruby.wasm); `node` / `bun` get a stateless
emulation that the banner is explicit about, because workerd's CSP blocks
runtime `eval` and `new Function`.

- **Python REPL** — real PyodideConsole driver. Variables, functions,
  imports, multi-line blocks all persist. `>>> ` / `... ` prompts.
  - Commits: `78a6d83` (P2–P6 substrate + Python pilot), `28e732d` (flush
    framing + expression/exception/exit fix), `1890456` (PyodideConsole
    stub `loadPackagesFromImports` for stdlib-only env), `5a6ad73`
    (explicit `__nimbus_repl_finish` displayhook), `17268bf`
    (serialize `handleInput` across WS frames).
  - Probes: `tests/behavioral/repl/python-*.mjs` (8 probes).
- **Ruby REPL** — real ruby.wasm driver. `irb> ` / `irb* ` prompts.
  - Commits: `ca02c8e` (adapter + factory + 6 probes), `9f42532`
    (simplify driver, remove unused `__nimbus_e`).
  - Probe: `tests/behavioral/repl/ruby-hello-repl.mjs`.
- **Bun + Node REPL** — stateless emulation. Banner names the CSP limit
  explicitly: "the REPL cannot persist `var` / `let` / `const` across
  lines — for stateful work, run a script."
  - Commits: `339dbac` (switch from `node:vm` to indirect eval because
    `node:vm` is non-functional in workerd), `92f9d38` (switch to
    `new Function` + accumulate-and-replay history strategy), `0a3df79`
    (final shape: banner CSP note + EvalError handler), `598e459`
    (banner copy).
  - Probes: `tests/behavioral/repl/bun-hello-repl.mjs`,
    `tests/behavioral/repl/node-hello-repl.mjs`.

Substrate: `src/runtime/repl-session.ts` (runtime-agnostic plumbing) +
`src/runtime/{python,ruby,bun,node}-repl.ts` (per-runtime adapters).

### Stream B — WASI preview1 surface 30 → 45 of 46

Plus outbound TCP via JSPI Suspending, plus full `poll_oneoff` covering all
three subscription kinds. `sock_accept` is intentionally absent (we are a
client, not a server).

- **B1–B6** — filestat times, symlinks, `fd_allocate`, `proc_raise`,
  `fdstat_set_rights`, hardlinks. Commit `7a7cd8c` + 11 probes.
- **B7** — outbound TCP via `path_open('/dev/tcp/<host>/<port>')` (bash's
  convention), `sock_send` / `sock_recv` / `sock_shutdown` wrapped in
  `WebAssembly.Suspending` so user wasm sees synchronous I/O over an
  async dispatch underneath. Commit `b77dc4f` + 3 probes.
- **B8** — `poll_oneoff` for FD-read / clock / socket-read subscriptions,
  also via Suspending. Commit `214ae0f`.
- **B9** — `wasi-threads` documented as a permanent infeasibility (workerd
  has no API to share `WebAssembly.Memory` across isolates).
  `docs/wasi-threads-infeasibility.md`.
- **Prod-fix** — `__wasiRunStartAsync` lookup + `sock_shutdown` SHUT_WR
  half-close edge case (7/7 previously-red probes flipped GREEN).
  Commits `787984e`, `911eef6`.

Counts (verifiable by enumerating the imports table in
`src/runtime/wasi-instance.ts`): 45 of 46 spec functions implemented;
`sock_accept` is the only omission.

### Stream C — clang on modern wasi-libc, multi-TU, stdio polish

- **v12 catalog flip** (`bcdf5a4`, `2366f8f`) — clang's default sysroot
  is now `wasi-sdk-19`-derived modern wasi-libc. Linker resolves
  `__muloti4` / `__divti3` (128-bit math from `utimensat`) via
  `libclang_rt.builtins-wasm32.a`. `wasm-ld` dead-strips for trivial
  mains so binji-2020-shape binaries are unaffected.
- **Path resolution fix** (`6608789`) — `__wasiResolvePath` strips the
  chroot-collision prefix so absolute paths under a preopen resolve
  correctly. Unlocks `fopen("/tmp/foo", "w")`.
- **Multi-TU + user headers** (`0a7d0f2`) — `clang a.c b.c -o prog` works.
  User `#include "your-header.h"` resolves from cwd; `-I<dir>` adds
  search paths.
- **v13-crt1 stdio polish** (`5eb01d5`) — stdio flushed on `exit()` and
  on normal `main` return via the C runtime's atexit chain. Global
  destructors run in order. Behavioral probes shipped; the matching
  sysroot is staged in R2 for the next deploy wave to flip.

Probes: `tests/behavioral/clang-includes/` (9), `tests/behavioral/clang-stdio/` (8),
`tests/behavioral/wasi-paths/` (8).

### Shell bug-sweeps R1–R4

Four sweeps fixed 20+ real user-visible shell bugs. Each fix has a
matching behavioral probe in `tests/behavioral/shell*/`.

| Sweep | Highlights | Commits |
|---|---|---|
| R1 | `wrap()` deadlock on `terminalStdin.readAll()`; FD redirect normalize (`2>&1`, `>&2`); `wc -c` correct on binary; `echo -n` / `-e` flags. | `70703e9`, `4bd2e04`, `51088c4`, `d26e3fa` |
| R2 | `rm -f` silent on missing target; `fs.readFileSync` absolute path; `xargs` actually executes; `awk` BEGIN/END/printf/arithmetic (workerd-CSP-safe evaluator, no `new Function`); `date` strftime. | `98717e1`, `7fd5a87`, `b370903`, `85eda74`, `24f9f9f`, `ac25e61` |
| R3 | `/dev` mount; subshell `(...)`; brace expansion `{a,b}`; `$$` PID var; heredoc variable interpolation; `type` builtin. | `4825c8c`, `8bfb101` |
| R4 | `unset`; full `printf` format; `grep` flags; backtick command substitution; `find` predicates (`-name`, `-type`, `-mtime`); `du -sh`; `readlink`. | `6c262fb`, `fadcb1f` |

### Tests + tooling

- Probe count: 91 → 183 (verifiable: `find tests/behavioral -name '*.mjs'
  -not -name '_*' | wc -l`).
- New categories: `repl/`, `clang-includes/`, `clang-stdio/`,
  `wasi-paths/`, `shell-r3/`, `shell-r4/`, `shell/`.

### Honest non-deliveries (for the same day)

- `wasi-threads` — refused at link time, by design. See
  `docs/wasi-threads-infeasibility.md`.
- Bun + Node REPL state across submits — not delivered; not deliverable
  on workerd. The banner is explicit; the recommended path is
  `node -e '<code>'` / `bun -e '<code>'`.
- Modern wasi-libc sysroot for the very latest crt1 (v13 with explicit
  `__wasi_init_environ` ordering) — probes shipped; matching sysroot
  staged in R2 awaiting the next deploy wave. Existing v12 sysroot
  remains the active default and is sufficient for everything the
  README claims.

---

## Earlier history

The repo's commit log is the canonical earlier-history reference. Prior
landmark waves include: package-manager substrate (clang + python + ruby
ingest pipeline), perf-regression probes with verbatim baselines (TST-3),
CI wiring via GitHub Actions (TST-9), recursive probe discovery (TST-2,
13 → 91 probes), and the framework substrate fixes (Astro / Next / Nuxt /
Remix / SvelteKit `import.meta`, `package.json#exports`, `#imports`,
ESM-CJS interop, dynamic-import VFS routing, unhandled-rejection trap).
