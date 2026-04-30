# Universal Node.js Compatibility Audit — Nimbus

> **Repo HEAD:** `e93b18d` (Wave 1 close-out — synthetic-entry barrel handling)
> **Prod build:** `c6449d38`
> **Probes captured:** 2026-04-29 against `https://nimbus.ashishkmr472.workers.dev`
> **Audit scope:** ~50 prod probe runs + full source review of resolver / shim / installer paths
>
> **Per-section evidence:**
> - [01 — `node:*` Builtins Matrix](sections/01-node-builtins.md) (24 probes; FNV-1a fake-hash bug; vm/tls/async_hooks missing; net.Socket lies)
> - [02 — Top-30 Package Compatibility](sections/02-packages.md) (33 probes; 1 ✅ jest, 32 ⚠️)
> - [03 — Resolver Gaps](sections/03-resolver-gaps.md) (file:line; peerDeps=0 src refs; runtime resolver hand-rolled and broken)
> - [04 — Native Bindings & WASM Mitigation](sections/04-native-mitigation.md) (12 probes; bcryptjs/esbuild-wasm/resvg/hash-wasm verified ✅)
> - [05 — Postinstall Policy](sections/05-postinstall-policy.md) (zero src/ refs; allowlist proposal)
> - [06 — Dynamic Semantics](sections/06-dynamic-imports.md) (11 probes; eval/TLA/import.meta verified blocked)
> - [07 — Workerd Hard Limits](sections/07-workerd-hard-limits.md) (17 platform-blocked features, citation each)

## Probe corpus

```
audit/probes/_driver.mjs         — reusable WS prod driver (uses base64-encoded JS-via-tmpfile to avoid eval-at-request blocks)
audit/probes/node-builtins/      — 24 builtin probes (.out.txt + .probe.js per cell)
audit/probes/packages/           — 33 npm pkg probes (install + import + smoke API)
audit/probes/wasm/               — 12 WASM-alternative probes
audit/probes/dynamic/            — 11 dynamic-semantics probes
```

Total: **80 raw probe artifacts** committed to git, each cited inline by
the section files.

---

## 1. Executive Summary

### State today vs target (probe-verified)

| Metric | Today (HEAD `e93b18d`) | After W2 (resolver) | After W3 (vm + crypto) | After W4 (WASM swap) | After W5 (peerDeps) | Hard cap |
|---|---|---|---|---|---|---|
| Top-33 ✅ end-to-end | **1 / 33 (3%)** | ≥18 / 33 (55%) | ≥21 (~64%) | ≥25 (~76%) | ≥27 (~82%) | ~30 (~91%) |
| Realistic full-npm coverage | ~70% | ~82% | ~88% | ~91% | ~93% | ~95% |

**The 5% irreducible gap is workerd-blocked**, not resolver-blocked. See
[Section 07](sections/07-workerd-hard-limits.md) — child_process,
.node dlopen, real-eval-at-request, no-net.Server.listen, no-fs.openSync,
node:wasi-stub, no-SharedArrayBuffer-threads.

### Top-3 highest-impact items (probe-backed, ranked)

#### 1. Resolver `exports`/`imports` gap → ~18 packages unblocked

> See [Section 03 §3.1](sections/03-resolver-gaps.md#31-packagejsonexports--runtime-resolver-partial-)

The runtime CJS resolver in `src/node-shims.ts:889-913 __resolvePkgEntry`
is a hand-rolled subset of `npm-resolver.ts:resolveExports` (which is
already correctly implemented at `src/npm-resolver.ts:625-688`). The
runtime version misses subpath maps, subpath wildcards, all conditions
besides `require|default|import`, nested conditions, and the entire
`imports` field.

**Verified by 18 of the 32 ⚠️ probes in Section 02** — react, zod,
drizzle-orm, express, pg, redis, ioredis, axios, mocha, ts-jest, ts-node,
mysql2, @libsql/client, react-remove-scroll, framer-motion, @radix-ui,
@remix-run/react, puppeteer-core all fail with messages like
`Cannot find module './X' (from .../package)` where `./X` is in the
package's `exports` map.

**Same gap blocks 4/12 WASM swap targets** (Section 04): sass, @grpc/grpc-js, @libsql/client, @rollup/wasm-node — all fail at "find module" before WASM init even starts.

**Fix scope:** ~75 LOC port of `resolveExports` into `node-shims.ts`. Effort **M (1.5 wks)**.

#### 2. `crypto.createHash` returns a structurally-degenerate FNV-1a fake → silent correctness bug

> See [Section 01 F1](sections/01-node-builtins.md#1-cryptocreatehash-is-a-fake--silent-correctness-bug)

```
Probe sha256(hello):    abdd62852c5bd7fc9fa116d64f0254ecabdd62852c5bd7fc9fa116d64f0254ec
expected real:          2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
```

The 32-byte SHA-256 output is a 16-byte FNV-1a state **repeated twice**.
Any user code computing SHA-256 to verify against an external value
silently produces wrong output. Source: `src/node-shims.ts:543-563`
(comment at `:543`: "synchronous FNV-1a variant for MD5/SHA-1 (common
non-security uses)" — but the same path runs for SHA-256+).

**Critical** because:
- Bug is silent (no exception, returns 32 hex chars that look correct)
- workerd's real `node:crypto` IS available (since 2025-04-08); shim shadows it
- WebCrypto `crypto.subtle` IS available globally ([Section 06 globals probe](probes/dynamic/globals.out.txt) confirms)
- A W2 fix can route `createHash` to either via static `import 'node:crypto'` or `crypto.subtle.digestSync` if/when workerd exposes one

**Fix scope:** delete FNV-1a impl, route through workerd. Effort **S (3-5 days)**.

#### 3. `vm` / `tls` / `async_hooks` missing from shim builtins → `jsdom` + ts-node + jiti family blocked

> See [Section 01 §3.2](sections/01-node-builtins.md#32-vm-and-tls-and-async_hooks-are-not-in-the-shim-builtins-table)

```
Probe vm:           Cannot find module 'vm' (from /tmp)
Probe tls:          tls require failed: Cannot find module 'tls' (from /tmp)
Probe async_hooks:  async_hooks fail: Cannot find module 'async_hooks' (from /tmp)
```

`src/node-shims.ts:771-849` builtins table doesn't include these three.
Adding `vm` (Function-based runInNewContext at module-eval time) +
`async_hooks` (workerd has AsyncLocalStorage natively) + `tls` (workerd
has partial since 2025-04-08) is mostly wiring.

**`jsdom` blocked specifically by `vm`** — verified probe
[jsdom.out.txt](probes/packages/jsdom.out.txt):
`Cannot find module 'vm' (from home/user/app/node_modules/jsdom/lib)`.

**Fix scope:** ~40 LOC across three builtin entries. Effort **S (1-3 days)**.

### Recommended Wave 2 ordering

```
W2 (resolver correctness)
   → unblocks ~18 packages + 4 WASM swaps for free
W3 (shim fidelity: vm + crypto + tls + async_hooks + net.Socket honesty)
   → unblocks jsdom + correct hashing + 1 more package
W4 (WASM swap layer + REJECT_INSTALL list)
   → unblocks bcrypt/esbuild/argon2 silent swaps; refuses better-sqlite3 with guidance
W5 (peerDeps + optionalDeps + lockfile-range validation)
   → unblocks Radix/Remix/Yjs class transitively
W6 (postinstall scripts capture + EMULATED/REJECTED tables + nimbus npm doctor)
   → makes hidden failures visible
W7 (browser-bundle CJS correctness + bare→node:* aliasing)
   → fixes Mossaic-class browser-side failures
```

W2 is unambiguously highest-leverage. Each downstream wave gets cheaper
once W2 lands because most "WASM doesn't load" / "shim not in table" /
"native binding" failures unmask resolver issues underneath them.

---

## 2. `node:*` Built-ins Matrix (summary)

Full table: [Section 01](sections/01-node-builtins.md).

Probe-verified status of 24 builtins in user-shell `node` facet:

| Module | Status | Failure mode |
|---|---|---|
| `fs` | ⚠️ | no `openSync`/`realpathSync`/`fd` APIs |
| `crypto` | 🔴 | FNV-1a fake hash, no cipher/scrypt/pbkdf2 |
| `util` | ⚠️ | `inspect` swallows cycles, no `parseArgs` |
| `path` | ✅ | full posix subset |
| `stream` | ⚠️ | no `promises`/`web` |
| `buffer` | ⚠️ | no `Blob`/`File` |
| `events` | ⚠️ | no `getEventListeners` |
| `os` | ⚠️ | hard-coded linux/x64 stubs, no `availableParallelism` |
| `url` | ✅ | full |
| `querystring` | ⚠️ | custom-sep arg ignored |
| `zlib` | ⚠️ | sync APIs throw, `deflateSync` not even shimmed, no brotli |
| `http` | ⚠️ | createServer works (ports), client `request`/`get` throw `Use fetch()` |
| `https` | ⚠️ | calls fetch under the hood |
| `net` | 🔴 | `Socket.connect` lies — emits `'connect'` without real TCP |
| `tls` | ❌ | not in builtins |
| `child_process` | ❌ | every API throws by design |
| `vm` | ❌ | not in builtins |
| `worker_threads` | ⚠️ stub | `Worker` is a no-op EventEmitter |
| `async_hooks` | ❌ | not in builtins (but `AsyncLocalStorage` reachable via static import) |
| `timers` | ⚠️ | no `timers/promises` |
| `assert` | ⚠️ | JSON-stringify based, fails on cycles |
| `perf_hooks` | ⚠️ | no `PerformanceObserver` |
| `process` | ⚠️ | `memoryUsage()` returns zeros |
| `fs/promises` | ⚠️ | no `cp`/`rm`/`open`/FileHandle |

🔴 = correctness bug or lie. ⚠️ = partial. ❌ = entirely missing.

---

## 3. Top-30 Package Compatibility (summary)

Full table: [Section 02](sections/02-packages.md). Generated table:
[`audit/probes/packages/_TABLE.md`](probes/packages/_TABLE.md).

### Status counts (33 probed)

- **✅** install + runtime works: **1** (`jest`)
- **⚠️** installs but breaks at runtime: **28**
- **❌** install silently skipped: **4** (`vite`, `webpack`, `rollup`, `parcel`)

### Failure-mode taxonomy

| Pattern | Count | Wave |
|---|---|---|
| P1 — Runtime resolver `exports`/subpath gap | ~18 | W2 |
| P2 — Native binding (.node dlopen blocked) | 6 | W4 |
| P3 — `__vfsBundle` doesn't include pkg at runtime | 4 | W4 |
| P4 — `SKIP_PACKAGES` silent-success UX trap | 4 | W6 |
| P5 — Missing builtin (vm) | 1 | W3 |
| P6 — Peer deps not auto-installed | 2 explicit, many implicit | W5 |
| P7 — Bare-from-nested doesn't walk-up | 1 (fastify) | W2 sub |

---

## 4. Resolver Gaps (summary)

Full audit: [Section 03](sections/03-resolver-gaps.md).

### Two parallel resolvers, drifted

| Layer | File:lines | Coverage |
|---|---|---|
| **Install-time** | `src/npm-resolver.ts:625-688` (`resolveExports`) + `731-750` (`resolvePackageEntry`) | ✅ proper Node.js spec impl |
| **Runtime** (user-shell `node`) | `src/node-shims.ts:889-913` (`__resolvePkgEntry`) + `:920-963` (`__resolveNodeModule`) | ❌ broken hand-roll: only `entry.require\|default\|import`, no subpath, no patterns, no imports |

### Verified zero-grep facts

- `peerDependencies`: **0 references** in 47 non-generated TS files in `src/`
- `optionalDependencies`: **0 references** (same scope)
- `postinstall` / `preinstall` / `scripts`: **0 references** in install pipeline files

---

## 5. Native Bindings & WASM Mitigation (summary)

Full audit: [Section 04](sections/04-native-mitigation.md).

### Probe-verified WASM working set

| Package | Status | Use as drop-in for |
|---|---|---|
| `bcryptjs` | ✅ verified | `bcrypt` |
| `esbuild-wasm` | ✅ verified (already used internally) | `esbuild` |
| `@resvg/resvg-wasm` | ✅ verified | SVG-only `sharp` use cases |
| `hash-wasm` | ✅ verified (`argon2id` works) | `argon2`, sync hash family |
| `wasm-vips` | ⚠️ partial (only `default` export) | `sharp` (with caveats) |

### Probe-verified WASM blocked

| Package | Block | Mitigation |
|---|---|---|
| `sass` | resolver `'./sass.dart.js'` | W2 fixes |
| `@grpc/grpc-js` | resolver `'./call-credentials'` | W2 fixes |
| `@libsql/client` | resolver `'@libsql/core/config'` | W2 fixes |
| `@rollup/wasm-node` | resolver `'./shared/rollup.js'` | W2 fixes |
| `@swc/wasm-web` | not pre-bundled | W4 (pre-bundle cache share) |
| `sql.js` | `.wasm` ENOENT | spike — H1 install-filter or H2 fs-shim path bug |
| `@tailwindcss/oxide-wasm32-wasi` | requires `node:wasi` (workerd stub) | reject; wait for upstream |

---

## 6. Phased Roadmap

Each wave includes a re-run of the probe corpus as acceptance test. Output
to `audit/probes/<area>/W<N>-<area>-VALIDATION.md` documenting deltas.

### W2 — Resolver correctness · effort **M (1.5 wks)**

**Problem:** `src/node-shims.ts:889-913 __resolvePkgEntry` is a broken
hand-roll. The proper impl already exists at `src/npm-resolver.ts:625-688
resolveExports` and is unused at runtime.

**Scope:**
- Inline `resolveExports` + `resolvePackageEntry` into the
  `node-shims.ts` shim preamble (~75 LOC port; can't import directly
  because shim runs as facet preamble string)
- Add `imports` field handling for `#name` specifiers
- Make `__resolveFile` extension list match
  `src/npm-resolver.ts:resolvePackageEntry` (add `.cjs`, `.mts`, etc.)
- Fix `__resolveNodeModule` to honour subpath via exports (currently does
  raw `__resolveFile(nmDir + "/" + subpath)` at `:946`)
- Fix `__resolveNodeModule` walk-up to find root-level deps from nested pkgs (fastify case)
- `require.resolve` for builtins (currently fails — see [require-resolve.out.txt](probes/dynamic/require-resolve.out.txt))

**Don't break:**
- `SKIP_PACKAGES`/`SKIP_PREFIXES` at `src/npm-resolver.ts:754-783`
- `__compiledModules` precompile-at-startup at `src/facet-manager.ts:187-191`
- Real-vite path (`src/cirrus-real.ts:618` does `import * as _f from 'node:fs'` to escape the shim — must continue working)

**Acceptance:**
- ✅ `bunx tsc --noEmit` passes
- ✅ Re-run [packages probe](probes/packages/) shows ≥18 ✅ (vs 1 today)
- ✅ Re-run [wasm probe](probes/wasm/) shows ≥9 ✅ (vs 4 today)
- ✅ Mossaic regression test still passes
- ✅ Real-vite still serves React+Tailwind sample with HMR

**Top-33 ✅ delta target:** 1 → 18.

### W3 — Shim fidelity (vm + crypto + tls + async_hooks + net.Socket honesty) · effort **M (1 wk)**

**Problem:** Section 01 surfaced 5 fidelity bugs:
- Cryptographic hash is FNV-1a fake (`crypto.createHash`)
- `vm` missing → `jsdom` can't load
- `tls` missing → packages doing `require('tls')` fail
- `async_hooks` missing → `AsyncLocalStorage`-via-require fails
- `net.Socket.connect` lies (emits `'connect'` without real TCP)

**Scope:**
- Replace shim's `createHash` with route to `crypto.subtle.digestSync` if available, else throw a clear error pointing at the global `crypto.subtle` API. Keep `randomBytes`/`randomUUID`/`timingSafeEqual` (all already real). (`src/node-shims.ts:523-604`)
- Add `vm` to `builtins` table (`src/node-shims.ts:771-849`): `runInNewContext(code, ctx)` wraps in `Function(varNames..., 'with(__ctx){return(' + code + ')}')` — works at module-eval time only; throws clear "request-time eval blocked" error from request handler
- Add `tls` builtin: thin wrapper over workerd's static `import 'node:tls'`
- Add `async_hooks` builtin: re-export `AsyncLocalStorage` from workerd's static `import 'node:async_hooks'`
- Make `net.Socket.connect` actually fail (or actually use `cloudflare:sockets`) — current "lie" is worse than honest failure

**Don't break:** the FNV-1a swap requires the W2 resolver fix to use static `node:` imports correctly — sequence W2 → W3.

**Acceptance:**
- ✅ Re-run [crypto probe](probes/node-builtins/crypto.out.txt): `sha256(hello)` matches `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`
- ✅ Re-run [jsdom probe](probes/packages/jsdom.out.txt): `title: x`
- ✅ Re-run [vm probe](probes/node-builtins/vm.out.txt): `runInNewContext result: 3`
- ✅ Re-run [net probe](probes/node-builtins/net.out.txt): if no real TCP, emit `'error'` not `'connect'`

**Top-33 ✅ delta target:** 18 → 21 (jsdom + 2 more cascade fixes).

### W4 — WASM swap layer + REJECT_INSTALL list · effort **L (2 wks)**

**Problem:** Sections 02+04 — 6 native-binding packages today fail
unhelpfully; some have viable WASM swaps, some don't.

**Scope:**
- Add `AUTO_SWAP` / `PROMPT_SWAP` / `REJECT_INSTALL` tables to
  `src/npm-resolver.ts` (sibling of `SKIP_PACKAGES`). Initial entries
  per [Section 04](sections/04-native-mitigation.md#proposed-swap-policy):
  - AUTO: `bcrypt → bcryptjs`, `esbuild → esbuild-wasm` (already happens implicitly)
  - PROMPT: `node-sass → sass`, `grpc → @grpc/grpc-js`, `rollup → @rollup/wasm-node`, `@swc/core → @swc/wasm-web`, `argon2 → hash-wasm`
  - REJECT: `better-sqlite3`, `sqlite3`, `node-pty`, `robotjs`, `puppeteer`, `playwright`, `electron`, `canvas`, `@tailwindcss/oxide-wasm32-wasi`
- Spike: `sql.js` `.wasm` ENOENT — verify whether install pipeline filters non-script tarball entries. If yes, fix; if no, fix runtime fs-shim resolver
- Per-project allowlist via `package.json#nimbus.allowSwap`/`rejectSwap` (mirrors pnpm)
- Pre-bundle cache sharing for user-shell `node` runner (fixes astro/nuxt/vitest/@swc/wasm-web)

**Acceptance:**
- ✅ `npm install bcrypt` produces a working `bcryptjs`-aliased install
- ✅ `npm install better-sqlite3` refuses with clear error pointing at `@libsql/client`
- ✅ Re-run [wasm probe](probes/wasm/): ≥7 ✅ verified (bcryptjs, esbuild-wasm, resvg-wasm, hash-wasm, sass-with-W2, grpc-grpc-js-with-W2, @libsql/client-with-W2)
- ✅ `sql.js` either works OR has a documented "use @libsql/client instead" REJECT message

**Top-33 ✅ delta target:** 21 → 25.

### W5 — peerDependencies + optionalDependencies + lockfile range validation · effort **M (1 wk)**

**Problem:** zero handling of peer/optional deps in src/. Lockfile validity
check ignores range changes.

**Scope:**
- Capture `peerDependencies`, `peerDependenciesMeta`, `optionalDependencies`, `browser` field in `ResolvedPackage` interface (`src/npm-resolver.ts:58-68`)
- Schema migration in `src/npm-cache.ts` registry cache: new columns `peerDepsJson`, `peerOptionalJson`, `optionalDepsJson`, `browserField`
- `npm-resolver.ts:resolveTree:540-549`: after `dependencies`, enqueue peer deps (filter by `peerDependenciesMeta.optional`) and optional deps (with try/swallow)
- `npm-installer.ts:isLockfileValid:861-871`: validate locked version still satisfies spec range (use `satisfiesRange`)
- `npm-resolver.ts:resolvePackageEntry:742-745`: consult `pkg.browser` (string OR map)

**Acceptance:**
- ✅ `npm install y-protocols` automatically also installs `yjs`
- ✅ `npm install @radix-ui/react-dialog` works without manually adding `react`/`react-dom`
- ✅ Editing `^1.0.0` → `^2.0.0` in `package.json` invalidates the lockfile

**Top-33 ✅ delta target:** 25 → 27.

### W6 — Postinstall script capture + `nimbus npm doctor` · effort **L (1.5 wks)**

**Problem:** Section 05 — `scripts` field never captured anywhere; install
silently runs zero scripts; users hit `Cannot find module './node-gyp-build.js'` etc.

**Scope:**
- Capture `scripts` field in `ResolvedPackage` (5-LOC schema migration)
- Per-install `unbuilt.json` artifact under `node_modules/.nimbus/`
- `EMULATED_BY_NIMBUS` table for esbuild/biome/etc.
- `KNOWN_REJECTED` table from [Section 05](sections/05-postinstall-policy.md#recommended-policy-w3-deliverable)
- `nimbus npm doctor` CLI command — auto-summary at install end + full report on demand
- Replace silent `SKIP_PACKAGES` success with clear "shimmed by Nimbus" message
- (Optional/W6.5) Sandboxed runner via NimbusFacetPool — `globalOutbound` sealed, scoped fs binding, 5s/64MB budget — for opt-in JS-only postinstalls (husky)

**Acceptance:**
- ✅ `npm install` of project with `husky` shows "1 package has unbuilt postinstall" summary
- ✅ `npm install puppeteer` refuses with REJECT message pointing at Cloudflare Browser Rendering
- ✅ `nimbus npm doctor` lists every dropped script with category

### W7 — Browser-bundle CJS correctness + bare→node:* aliasing · effort **M (1 wk)**

**Problem:** `src/vite-dev-server.ts:507-521 resolveBareSpecifier` skips
`node:crypto` (line 512) but rewrites bare `crypto` to
`/preview/@modules/crypto` → 404. Mossaic-class.

**Scope:**
- Add `NODE_BUILTINS` set in `vite-dev-server.ts:507`; rewrite bare `crypto`/`buffer`/`util`/etc. to `node:<name>` BEFORE alias check
- Fix `extractCjsExportNames` `__esModule`-flagged CJS handling (`vite-dev-server.ts:316-322`)
- Inject `process.env.NODE_ENV` define on install-time pre-bundle path (currently inconsistent with on-demand)
- Inject `__dirname`/`__filename` defines for browser bundles
- Bump `BUNDLER_VERSION` (`src/esbuild-service.ts`)

**Acceptance:**
- ✅ `import { Buffer } from 'buffer'` in user code resolves correctly in browser
- ✅ TS-compiled CJS packages (lodash-shim) stop double-defaulting
- ✅ Cached install-time bundles for React etc. don't crash on `process.env.NODE_ENV`

---

## 7. Open Architectural Decisions

These gate W3+ implementation. Recommended answer in **bold**.

### D1 — `crypto.createHash` swap target

The shim's `createHash` returns a fake. Three options:

- **(a) Route to workerd's `node:crypto` via static import** — reachable from a generated module the shim's `__require` can dispatch to. Requires the W2 resolver fix to land first. **Recommended.**
- (b) Route to WebCrypto's `crypto.subtle.digest` — but it's async-only; would break `digest(enc)` sync API.
- (c) Bundle a JS SHA-256 implementation (`hash-wasm` works, ~140 KB) — keeps sync API but adds bundle weight.

### D2 — `vm` shim semantics

- **(a) Function-based at module-eval time** — works for jsdom-style "evaluate this script string against a context" if the string is known at module-eval. Not great for runtime-generated code (which is blocked by `disallow_eval_during_request_handler` anyway).
- (b) Spawn a sub-isolate via `LOADER.load` per `runInNewContext` call — proper isolation but heavy. **Recommended only for jsdom-class consumers.**

Recommendation: **start with (a) at module-eval time; fall back to throwing a Nimbus-specific error at request time.** This unblocks jsdom (which precompiles its globals at module load) and is honest about the rest.

### D3 — AUTO_SWAP defaults: silent or opt-in?

- **Silent for true drop-ins** (`bcrypt → bcryptjs`, `node-sass → sass`, `grpc → @grpc/grpc-js`, `esbuild → esbuild-wasm`). Print one-line summary at install end. **Recommended.**
- Prompt-on-first-encounter for partial-fidelity (`@swc/core → @swc/wasm-web` (no Compiler), `sharp → wasm-vips` (different API), `argon2 → hash-wasm`).
- Reject for impossibles (`better-sqlite3`, `node-pty`, `robotjs`).

### D4 — REJECT_INSTALL strictness: direct vs transitive?

- **Refuse direct** with hard error + mitigation message
- **Install-skip-warn transitive** — install everything else, skip the rejected pkg, warn "if your code never calls into <pkg>, this is fine". **Recommended.**

### D5 — Postinstall allowlist syntax

- **(a) pnpm-style array** in `package.json#nimbus.allowBuilds`. Familiar, trivial. **Recommended for W6.**
- (b) Capability-style with per-package `{fs, network, spawn, time}` tuples. More expressive; layer on top of (a) in W6.5.

### D6 — Multi-version: physical nesting vs alias rename?

- **Physical nesting in `node_modules/<parent>/node_modules/<child>`** — matches Node, `require.resolve` paths work. **Recommended.**
- Alias rename — cheaper to implement but breaks `require.resolve` paths in user code.

Defer this until after W2/W3/W4 land — first-version-wins works for most current users; the hard cases (React 17/18 mix) are uncommon.

### D7 — Shim shadowing of workerd builtins (parked)

Today, `__require('crypto')` returns the FNV-1a fake instead of workerd's
real `node:crypto`. The right architectural fix is to NOT shadow workerd
builtins at all — let `require('crypto')` reach workerd's native, and
keep the shim only for things workerd doesn't have or where Nimbus has
real semantics (VFS-backed `fs`, RPC-backed `process`, etc.).

This is high-value but high-risk: every facet, every shim, every test
gets touched. Recommended after W2-W7 land, when we have a clear baseline
of what the shim still needs to do.

---

## 8. Hard Limits — Quotable Reference

Full table: [Section 07](sections/07-workerd-hard-limits.md).

The 17 items below are platform-blocked. Cite when refusing user requests
for "make it like real Node":

1. `child_process.spawn`/`fork`/`execSync` — no process model
2. `vm.runInContext` real V8 isolation — best we have is Function() at module-eval time
3. `eval()` / `new Function()` at request time — workerd default disallows
4. `.node` dlopen — workerd cannot load native code
5. `SharedArrayBuffer` + Web Workers — no Worker constructor
6. TLS server, raw TCP server (`net.Server.listen`) — outbound TLS client only
7. `node:wasi` — workerd ships throwing stub
8. Synchronous fd APIs (`fs.openSync`, `realpathSync`) — no kernel fds
9. `http2` client streaming bidi — workerd stub
10. `fs.watch` real inotify — Nimbus polls
11. `import.meta.url` for user `node` scripts — runs in `new Function()`, not module
12. Top-level await for user `node` scripts — same as 11
13. Real `process.memoryUsage()` inside DO — returns zeros
14. `Atomics.wait`/`notify` — needs SharedArrayBuffer
15. Per-isolate memory > 128 MiB — workerd cap
16. CPU time per request > 30s free / 5min paid — workerd budget
17. `crypto.createHash` sync via shim — shim shadows workerd's real `node:crypto` (not platform-blocked, but architectural)

---

## 9. Citations

- All probe artifacts: [audit/probes/](probes/)
- Section files: [audit/sections/](sections/)
- Source citations: file:line throughout each section
- Cloudflare docs: linked per-claim in section files
- Workerd source: https://github.com/cloudflare/workerd

---

*Document v2.0 — written 2026-04-29 against Nimbus HEAD `e93b18d` /
prod `c6449d38`. Supersedes any prior `memory/`-stored audit (which did
not survive sandbox reset). Probe-driven; every claim has a probe
artifact, file:line, or docs URL.*
