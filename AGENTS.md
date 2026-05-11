# AGENTS.md — Nimbus (lifo-edge-os) project context

**Last refreshed**: 2026-05-11 (CLN-1b wave)
**Scope**: project-specific guide for sessions working in this repo. The workspace-level `/workspace/AGENTS.md` covers cross-project orientation; this file is the canonical reference for "what's actually shipped in Nimbus right now."

---

## What Nimbus is

Cloud-native dev environment on Cloudflare Workers + Durable Objects. Each session is a SQLite-backed DO with:

- Persistent 10 GB VFS (`src/vfs/sqlite-vfs.ts`)
- npm install/registry layer (per-session R2 cache + cross-session L2)
- Real node, bun, esbuild, git (via cf-git fork), vite dev server
- 60+ Unix commands in-shell
- Three additional language runtimes via the package-manager substrate (below)

Entry point: `src/index.ts` exports `NimbusSession` DO. Routes in `src/session/routes.ts`. Production at `https://nimbus.ashishkmr472.workers.dev` (compat-date `2026-04-01`, flags `["nodejs_compat"]`).

Domain pick: **Stint** (stint.run primary). Earlier "Nimbus" / "TODO rebrand" mentions in older docs are stale.

---

## Substrate that runs 3 language runtimes (clang, Python, Ruby)

A single package-manager → catalog → per-user-VFS → child-facet shape ships all three. New runtimes added by:

1. Spec entry in `scripts/bundle-runtime.mjs` (append-only — sibling waves use this file)
2. Upload to R2 (`nimbus-runtime-cache` bucket): `blobs/<name>-<version>/...`, `manifests/<name>-<version>.json`, update `catalog/v1.json`
3. NEW `src/runtime/<name>-runner.ts` — mirrors python-runner / ruby-runner patterns
4. Register factory in `src/session/init.ts` via `registerRunnerFactory('<name>-runner', make<Name>RunnerFactory(...))`
5. Behavioral probes under `tests/behavioral/<name>/`

### Critical pattern: child-facet module-init bootstrap

Workerd's CSP forbids `new WebAssembly.Module(rawBytes)` at request time but **allows** at the child-facet's module-init context. Heavy bootstrap (wasm instantiate, JS-callback-to-wasm shims, FinalizationRegistry use, etc.) must run in the child-facet preamble. See `src/runtime/python-runner.ts` and `src/runtime/ruby-runner.ts` for the canonical shape.

Five blockers that bit Python v2 and partially Ruby v1 — re-check for any new runtime:

1. `FinalizationRegistry` — class-shim it at preamble top (compat-flag gated on older compat dates).
2. `sentinel` namespace (Pyodide) — replicate the tiny standalone wasm shim; attach `imports.sentinel = sentinelExports` before main `WebAssembly.instantiate`.
3. `WebAssembly.Module(rawBytes)` — move bootstrap into child-facet module-init OR use the `allow_eval_during_startup` compat flag (implied by date ≥ 2025-06-01).
4. `crypto.getRandomValues` at module-init — workerd blocks. Use Emscripten `addRunDependency` gate (Pyodide) or defer the crypto-dependent init to the FIRST request handler (Ruby).
5. `config.jsglobals = globalThis` — required by `finalizeBootstrap`'s `register_js_module` (Pyodide-specific).

Full breakdown: `/workspace/.seal-internal/2026-05-11-pyodide-v2/smoketest-result.md`.

---

## Runtimes shipped

| Runtime | Version | Bin names | Status | Probes |
|---|---|---|---|---|
| clang | binji-2020 (LLVM 8) | `clang`, `wasm-ld` | shipped; libc has rights gate, sysroot-swap to wasi-sdk-19 queued | `tests/behavioral/clang/` |
| python | Pyodide 0.29.4 (CPython 3.13) | `python`, `python3` | full v1: -c/-m/script/exit/stdlib | `tests/behavioral/python/` (21 probes) |
| ruby | ruby.wasm 2.9.3-2.9.4 (Ruby 3.3) | `ruby`, `ruby3` | full v1: -e/-r/script/exit/stdlib | `tests/behavioral/ruby/` (18 probes) |

Node + Bun are native (workerd's nodejs_compat); not in this substrate.

### Anti-touch (waves in flight)
- **NO touching** `src/runtime/python-runner.ts` (Pyodide v2 stabilized)
- **NO touching** `src/runtime/ruby-runner.ts` (Ruby v1 stabilized)
- **NO touching** `src/runtime/clang-runner.ts` (Path C clang-sysroot-swap in flight)
- **NO touching** `catalog/v1.json` (Path C)
- **NO touching** `src/runtime/{wasm-runner, wasi-instance, esbuild-service, node-shims, runtime-registry, runtime-catalog}.ts` (canonical surfaces)
- **NO touching** `src/facets/*` (manager.ts has long shared history)
- **NO touching** `src/npm/` and `src/_shared/*` (CLN-1 settled)
- **APPEND-ONLY** on `scripts/bundle-runtime.mjs` (multi-wave shared)

---

## Framework + Workers substrate fixes shipped (chronological-ish)

| Wave | What | Files |
|---|---|---|
| remix-wrappy | ESM→CJS wrap survives top-level await | `src/runtime/esbuild-service.ts` |
| require-dot-res | `require('./x.json')` resolves via VFS | (npm resolver) |
| sk-mjs | `.mjs` files treated as ESM in the require chain | (esbuild service) |
| nuxt-import-meta | `import.meta.url` resolved at esbuild-transform time | (esbuild service) |
| sk-exports | `package.json#exports` field honored | (esbuild service) |
| chalk-imports-field | `package.json#imports` (`#name` specifiers) | npm prefetch resolver |
| dynamic-import-shim | Facet body handles dynamic `import()` | facet preamble |
| unhandled-rejection | Facet installs unhandledrejection + error listeners | facet preamble |

Test surface for these: `tests/behavioral/{module-format, require-resolution, frameworks}/`.

---

## Test suite

**Probe contract**: `tests/behavioral/PROBE-QUALITY.md` — behavioral probes must fail when and only when a real user would see the bug. Structural-only assertions (regex on bundle, HTTP 200 alone) are forbidden as the sole pass criterion.

**Runner**: `tests/behavioral/run-all.mjs` (recursive discovery as of TST-2 — pre-fix it saw 13 probes; post-fix it sees 91+).

**Categories of interest**:
- `behavioral/PROBE-QUALITY.md` — the contract
- `behavioral/_driver.mjs` — black-box driver (POST /new, WS /s/<sid>/ws, GET /preview/, GET /port/<n>/)
- `behavioral/_runtime-behavioral-template.mjs` — real Chrome via puppeteer-core for browser-side probes
- `behavioral/python/` (21 probes), `behavioral/ruby/` (18 probes), `behavioral/clang/` (5 probes)
- `behavioral/perf-regression/` (TST-3 — 6 threshold probes with verbatim baselines)
- `behavioral/module-format/` (4 probes), `behavioral/require-resolution/` (1 probe)
- `behavioral/cache-observability/` (2 probes), `behavioral/pkg-manager/` (multiple)
- `behavioral/unhandled-rejection/` (9 probes), `behavioral/frameworks/` (real-Vite/Next/Nuxt/SvelteKit/Remix)

**Run a probe**: `BASE=https://nimbus.ashishkmr472.workers.dev bun tests/behavioral/<category>/<probe>.mjs`

**Anti-reqs for probes**: NO `setTimeout`/`sleep`/`retry`/`defensive-catch` in assertion logic. Bounded poll-until-found (e.g., `while (perf.now() - t0 < BUDGET)` with `fail loudly when budget expires`) is the accepted shape. Perf-regression probes assert `duration ≤ threshold` where threshold is `p95 × 1.5` from documented baseline (slack-floor 100 ms for low-variance probes).

---

## Multi-session parallel work

Multiple sessions/agents commonly land in this repo simultaneously. Conventions:

- **Worktree pattern**: `git worktree add /workspace/worktrees/<name> -b <branch> origin/main`
- **Sibling deploy window**: 5 min. If your deploy is older than 5 min, rebase + redeploy before pushing main.
- **Append-only shared files**: `scripts/bundle-runtime.mjs` (multi-wave runtime ingest), `tests/behavioral/run-all.mjs` (multi-wave probes).
- **Anti-touch lists** in charters take precedence over surface-area instincts.
- **NO push main until prod-verify GREEN** — for waves that touch deployed code.
- **Commit message convention**: `<WaveID>-<phase>: <one-line summary>` with verbatim probe-pass counts in body.

---

## Build / test / deploy commands

| Task | Command |
|---|---|
| Dev (workerd local) | `bun run dev` (wrangler dev --ip 0.0.0.0 --port 8787) |
| Typecheck | `./node_modules/.bin/tsc --noEmit` (2 known-baseline errors: esbuild-wasm/esbuild.wasm module + SqliteVFSProvider FileType — neither blocks deploy) |
| Deploy prod | `CLOUDFLARE_ACCOUNT_ID=f44999d1ddda7012e9a87729eba250f1 ./node_modules/.bin/wrangler deploy -e production` |
| Deploy dry-run | append `--dry-run --outdir /tmp/wrangler-build` to inspect bundle |
| Probe | `BASE=https://nimbus.ashishkmr472.workers.dev bun tests/behavioral/<probe>.mjs` |

Compat-date: `2026-04-01` (constants.ts:`CF_COMPAT_DATE`). Compat-flags: `["nodejs_compat"]` only. The `allow_eval_during_startup` flag is implicitly enabled by date ≥ 2025-06-01 and MUST NOT be listed explicitly (validator rejects redundant flags).

---

## Critical files map

| File | What it owns |
|---|---|
| `src/index.ts` | Workers entry + `NimbusSession` DO class |
| `src/session/init.ts` | Per-session init: registers commands, runtimes, git, package-manager |
| `src/session/routes.ts` | HTTP route table |
| `src/constants.ts` | Single source of truth for `NIMBUS_VERSION`, `NODE_VERSION`, `CF_COMPAT_DATE` |
| `src/vfs/sqlite-vfs.ts` | The 10 GB user VFS |
| `src/runtime/<name>-runner.ts` | Per-runtime handler factories (clang, python, ruby) |
| `src/runtime/wasi-instance.ts` | WASI shim used by wasm-runner, clang-runner, ruby-runner |
| `src/loaders/loader-pool.ts` | Child-facet spawning (Worker Loader API) |
| `src/npm/installer.ts` | npm install dispatch + facet orchestration |
| `scripts/bundle-runtime.mjs` | R2 ingest script — runtime bundle uploader |
| `wrangler.jsonc` | Worker config, R2 bindings, DO bindings, compat-flags |
| `tests/behavioral/` | Behavioral probe suite (91+ probes) |

---

## Common gotchas

1. **isomorphic-git imports**: cf-git fork uses **named** exports. Always `await import('isomorphic-git')`, never `.default`.
2. **NODE_VERSION**: pull from `src/constants.ts` — never inline literals. (CLN-1b fix history.)
3. **`nodejs_compat`**: required for git, npm install, fs shim.
4. **`process` shim**: hide `globalThis.process` when bootstrapping runtimes (Pyodide/Ruby detection paths take Node code paths otherwise).
5. **Child-facet vs request-time CSP**: heavy wasm work must run at child-facet module-init. See substrate section above.
6. **Port 3000**: reserved by the platform; use 8787 (wrangler) / 5173 (vite).
7. **Bun, not npm**: workspace convention for all package management.
8. **Sibling deploys**: ALWAYS `git fetch origin` + check `origin/main` before pushing — 5-min window.

---

## Internal scratch dirs

Wave-specific design + verdict docs live at `/workspace/.seal-internal/<date>-<wave>/`:

- `2026-05-10-pyodide-v1/`, `2026-05-11-pyodide-v2/` — Python wave research + verdicts
- `2026-05-11-ruby-v1/` — Ruby wave audit + verdict
- `2026-05-10-true-os/` — Wave-3 substrate (clang)
- `2026-05-10-cleanup-audit/` — Test-suite hardening audit (TST-1 through TST-9 plan)
- `2026-05-11-tst3-perf-probes/` — Perf-regression thresholds + baselines

Consult these for any wave that touches similar surfaces; they document the iterations and the binding constraints discovered.
