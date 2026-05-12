# Nimbus

A Linux-like development environment that runs entirely in your browser, on Cloudflare's edge. Open a URL, get a real shell with `node` + `bun` (Cloudflare workerd `nodejs_compat` runtime), `npm`, `git`, real `python` (Pyodide-compiled CPython 3.13), real `ruby` (ruby.wasm 3.3), real `clang` (LLVM 8 → wasm32-wasi), and 60+ Unix commands. No Docker. No containers. No cold-start wait. Sessions hibernate at $0 idle cost and resume in milliseconds.

🌐 **Try it now:** https://nimbus.ashishkmr472.workers.dev

![Demo](docs/demo.gif)

## Why Nimbus

Cloud dev environments today are either heavy VMs (slow to start, expensive to idle) or browser sandboxes that can't run real toolchains. Nimbus is different:

- **Linux-like userland.** `node` and `bun` over the Cloudflare workerd `nodejs_compat` runtime (the same V8 your Workers code runs on — not a JS interpreter stub, but also not the upstream Node/Bun binaries: it's the workerd-compatibility surface). Real `git clone` over HTTPS via isomorphic-git. Real `npm install` against the live npm registry. Real `python` (Pyodide-compiled CPython 3.13, WebAssembly), real `ruby` (ruby.wasm 3.3, WebAssembly), real `clang` (LLVM 8 with modern wasi-libc, compiles C to wasm32-wasi in-session).
- **Sub-500ms cold start.** Each session is a Cloudflare Durable Object backed by SQLite. No VM boot. No image pull.
- **$0 when idle.** Sessions hibernate. Your filesystem persists. Come back tomorrow, the URL still works, your files are still there.
- **The URL is the session.** Bookmark it, share it, hand it to a teammate — they join the same filesystem.
- **10 GB of persistent storage per session**, SQLite-backed, durable across reconnects and DO eviction.

## Quickstart

### Try the live demo

```
1. Visit https://nimbus.ashishkmr472.workers.dev
2. Click "Launch" — you'll be redirected to /s/<your-session-id>/
3. The URL is now your dev environment. Bookmark it.
```

You're in a real shell. Try:

```bash
node --version              # workerd nodejs_compat (V8 + Node-API shim)
git clone https://github.com/AshishKumar4/Markflow   # real git over HTTPS
cd Markflow && npm install  # real npm against registry.npmjs.org
npm run dev                  # vite dev server — preview in the iframe
```

The preview iframe on the right shows your running app at `/s/<id>/preview/`.

Or write some C:

```bash
cat > hello.c <<EOF
#include <stdio.h>
int main(void) { printf("hello from clang on the edge\n"); return 0; }
EOF
clang hello.c -o hello.wasm
./hello.wasm
```

### Run it locally

```bash
git clone https://github.com/AshishKumar4/Nimbus.git
cd Nimbus
bun install
bun run dev      # wrangler dev --ip 0.0.0.0 --port 8787
```

Open http://localhost:8787 and click **Launch**.

## What works today

Verified against the live deploy by 183 behavioral probes in `tests/behavioral/` (run them yourself — see [Tests](#tests)).

| Capability | Status |
|---|:---:|
| Real shell, 60+ Unix commands, persistent 10 GB filesystem | ✅ |
| `node`, `bun` via Cloudflare workerd `nodejs_compat` (V8 + Node-API shim, not the upstream binaries) | ✅ |
| `python` / `python3` — Pyodide-based CPython 3.13 (script + `-c` + `-m` + stdlib) | ✅ |
| `ruby` / `ruby3` — ruby.wasm-based Ruby 3.3 (script + `-e` + `-r` + stdlib) | ✅ |
| `clang` — LLVM 8 → wasm32-wasi, modern wasi-libc sysroot default, multi-TU + user headers + `fopen` | ✅ |
| Interactive REPLs — `python`, `ruby`, `node`, `bun` (see [REPL](#repl) for state semantics) | ✅ |
| `npm install` against the live registry, with cross-session L2 cache | ✅ |
| `git clone` over HTTPS (small repos + 1 600-file repos in 12–17 s) | ✅ |
| Vite SPA dev server — full HMR to the preview iframe | ✅ |
| `wrangler dev` for single-file Workers; Workers + Static Assets | ✅ |
| `npx <pkg>` — first-class shebang + auto-install fallback | ✅ |
| `node_modules/.bin/*` resolves and executes | ✅ |
| Binary file round-trip via `fs.writeFileSync` / `readFileSync` | ✅ |
| Session recovery — WebSocket drop → reconnect preserves cwd, env, files | ✅ |
| WASI preview1 — 45 of 46 spec functions; outbound TCP via `path_open('/dev/tcp/<host>/<port>')` (JSPI); full `poll_oneoff` (fd / clock / socket subscriptions) | ✅ |
| `wasi-threads` (`thread_spawn`) — refused at link time, by design | ⛔ ([why](docs/wasi-threads-infeasibility.md)) |

### Status: alpha

Nimbus is under active development. Some frameworks work, others surface bugs we're chasing wave-by-wave:

- **Stable:** Vite + React, the Cloudflare Vite Plugin, single-file Workers, Workers with Static Assets, npm + git workflows, Python and Ruby scripts, clang C compilation (single-file and multi-file).
- **Partial:** Astro, Next.js, Nuxt, Remix, SvelteKit — some scaffold and run, others hit known bugs in the package-resolver or runtime shim. We add probes and fix as we go.
- **Not yet supported:** Cloudflare Pages (`wrangler pages dev` not wired), multi-tab concurrent sessions, `cirrus-real` Vite DO-Facet path (gated on a Cloudflare compatibility-flag promotion to GA).

## REPL

`python`, `ruby`, `node`, and `bun` launch interactive REPLs when given no arguments. There are two honest categories:

**Stateful (real interpreter, real persistence):**

- `python` / `python3` — drives Pyodide's `PyodideConsole` directly. Variables, functions, imports, multi-line blocks persist across submits. `>>> ` primary, `... ` continuation.
- `ruby` / `ruby3` — drives the long-lived ruby.wasm runtime. `irb`-style `irb> ` / `irb* ` prompts. Variables, methods, requires persist.

**Stateless emulation (workerd CSP-bounded):**

- `node` / `bun` — workerd's CSP blocks runtime `eval` and `new Function`, so we can't persist `var` / `let` / `const` declarations across submits the way upstream Node/Bun do. `console.log` and per-line side effects work; for stateful work, run a script (`node -e '<code>'` or `node script.js`). The banner says exactly this.

Press Ctrl-D or type `exit` / `.exit` to leave. Probes: `tests/behavioral/repl/` (13 probes covering exit semantics, prompts, stateful Python, error recovery).

## C compilation

`clang` compiles C to `wasm32-wasi` in-session, then `wasm-ld` links. Both binaries run in a child-facet isolate; the user VFS is mounted into a virtual `memfs` so `#include "your-header.h"` and `fopen("./data.txt", "r")` work.

What's wired today (v12 sysroot, currently deployed):

- Modern wasi-libc sysroot (binji-shape, derived from upstream wasi-sdk-19).
- Multi-translation-unit compile + link (`clang a.c b.c -o prog`).
- User headers in cwd or under `-I<dir>`.
- `fopen("...", "r" | "w" | "a")` against VFS paths (relative + absolute).
- 128-bit math intrinsics (`__muloti4`, `__divti3`) provided via linked `libclang_rt.builtins-wasm32.a`.

Currently has the rough edges that the v13 sysroot (staged in R2, awaiting deploy) fixes — most notably stdio-buffer flush on `main` return and `atexit()` handler firing. v13 sysroot + probes are landed in `tests/behavioral/clang-stdio/`; activation is a deploy-time catalog flip, not a code change.

Probes: `tests/behavioral/clang/`, `tests/behavioral/clang-includes/`, `tests/behavioral/clang-stdio/`, `tests/behavioral/wasi-paths/`.

`-pthread` / `wasi-threads` is intentionally not supported — see [docs/wasi-threads-infeasibility.md](docs/wasi-threads-infeasibility.md) for why a partial implementation would silently corrupt user data.

## Performance

Measured against the live deploy.

| Operation | Wall time |
|---|---|
| `git clone` 1 600-file repo | 12–17 s |
| `npm install zod` (cold session) | ~6 s |
| `node -e 'console.log(...)'` (warm) | 102–152 ms |
| Vite hot reload | 302 ms median |

Cross-session caching gives 9–16× speedups for warm package installs vs cold. Perf-regression probes in `tests/behavioral/perf-regression/` assert these thresholds on every deploy.

## Architecture (high level)

![System topology](docs/architecture/topology.svg)

One session = one Cloudflare Durable Object with SQLite storage. The Durable Object is your shell, your filesystem, your port registry, and your process table. CPU-heavy work (npm resolution, esbuild bundling, git clone, WASM execution, REPL eval) fans out to ephemeral Worker Loader isolates that run, return results, and die. Hot reads are cached at the per-colo edge; cross-session assets (npm tarballs, esbuild-wasm, runtime blobs) live in R2.

![Layered architecture](docs/architecture/layers.svg)

Four layers, each owning a single concern: the browser terminal talks to the supervisor DO over WebSocket; the supervisor routes RPC; isolates do compute; R2 + `caches.default` hold cross-session state.

## Tests

`tests/behavioral/` contains 183 black-box probes that drive a real session via `POST /new` + WebSocket. Probes assert real user-visible behavior — structural-only assertions (regex on a bundle, HTTP 200 alone) are not accepted as pass criteria. See `tests/behavioral/PROBE-QUALITY.md` for the contract.

Run them all against the live deploy:

```bash
BASE=https://nimbus.ashishkmr472.workers.dev bun test:behavioral
```

Or just one probe:

```bash
BASE=https://nimbus.ashishkmr472.workers.dev bun tests/behavioral/clang-stdio/new/multi-printf-no-fflush.mjs
```

## License + credits

MIT. Built by [Ashish Kumar Singh](https://github.com/AshishKumar4) on top of [LIFO OS](https://github.com/lifo-sh/lifo) by [Sanket Sahu](https://github.com/sanketsahu), which seeded the shell interpreter, coreutils, and Node.js shim (MIT). The Cloudflare-native primitives — Durable Objects with SQLite storage, Worker Loaders, R2, `caches.default`, and WorkerEntrypoint RPC — are the architectural backbone.

Contributions welcome. Open an issue or PR at https://github.com/AshishKumar4/Nimbus.
