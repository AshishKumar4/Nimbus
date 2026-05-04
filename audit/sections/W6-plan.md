# W6 — WASM Swap Registry + REJECT_INSTALL UX — Plan (v2, post-review)

> **Status:** plan v2 committed prior to any src/ change (TDD discipline).
> **Branch:** `w6-wasm-swap` off `main` @ b266d1d.
> **Author:** autonomous Seal session, 2026-05-04.
> **Review:** v1 received an explore-agent review (verdict REVISE) that
> caught four must-fix correctness defects. v2 incorporates all four +
> high-value should-fixes. v1 is preserved in git history (this file
> is replaced wholesale to keep the live doc clean).

## 1. Goal (from MASTER-ROADMAP.md §W6)

> All native-binding packages either work via WASM swap or fail loudly with guidance.

Today, native packages (bcrypt, sharp, fsevents, prisma, …) either:
- silently install but crash at `require()` time, or
- silently `SKIP_PACKAGES`-skip if they happen to be in the build-only set, or
- silently install + extract but fail at WASM load (sql.js, @swc/wasm-web — loader gap).

Neither is "loud + helpful". W6 introduces typed registries that own these
names from the resolver/installer boundary inward.

## 2. Anti-goals (out of scope)

- **No bundler/runtime work.** WASM-loader gaps (sql.js missing
  `dist/sql-wasm.wasm` after extraction; `@swc/wasm-web` not pre-bundled)
  are tarball-extraction filter / pre-bundle wiring fixes, not registry
  semantics. They go in REJECT (with honest reason citing the gap)
  until the loader layer fixes them. Tracked W6.5 in retro.
- **No npm-alias parsing.** Real npm has `"bcrypt": "npm:bcryptjs@^3"`
  spec syntax; Nimbus's resolver does not parse it. Without alias
  support, swapping `bcrypt`→`bcryptjs` would silently break
  `require('bcrypt')` in user code (different require() name, no shim).
  → All "different-require-name" candidates (bcrypt, argon2, node-sass,
  grpc, @swc/core, sharp's wasm-vips successor) are **REJECT** with a
  one-line code-change suggestion. Add alias support in W6.5.
- **No tldts resolver fix.** Excluded by user (carry-over from a
  different audit thread).
- **No expansion of top-30 native-package coverage** beyond what's
  testable from the registry layer. Per-package runtime viability is
  W6.5 / W11.

## 3. Data model

### 3.1 `WASM_SWAPS` — name→name rewrite

**v2 minimal swap set: only `esbuild → esbuild-wasm`.** All other "swap"
candidates have a different require()-name and are demoted to REJECT
with a code-change suggestion (see §2 anti-goal "No npm-alias parsing").

```ts
// src/wasm-swap-registry.ts
export interface SwapEntry {
  from: string;
  to: string;
  reason: string;
  /** 'drop-in' = require(from) and require(to) work identically (same export shape). */
  compat: 'drop-in';
}

export const WASM_SWAPS: ReadonlyArray<SwapEntry> = [
  // bcrypt → bcryptjs is INTENTIONALLY NOT here. The two packages have
  // different require() names; without npm-alias support, a swap silently
  // breaks `require('bcrypt')` in user code. It's in REJECT_INSTALL with
  // a guided code-change suggestion until alias support lands (W6.5).
  // Same logic for argon2, node-sass, grpc, @swc/core.
  {
    from: 'esbuild',
    to: 'esbuild-wasm',
    reason: 'Native esbuild not available in Workers; esbuild-wasm exposes the same build/transform/version/initialize API.',
    compat: 'drop-in',
  },
];
```

> **Open question (e2e probe answers it):** does `esbuild-wasm` truly
> drop-in for `esbuild` at the `require('esbuild')` site? See §7.3
> `swap-target-symbol-parity.mjs`. If parity fails, the entry demotes
> to REJECT.

### 3.2 `REJECT_INSTALL` — deny list

```ts
export interface RejectEntry {
  from: string;
  /** Helpful one-liner. Always actionable. */
  reason: string;
  /** Optional swap suggestion shown inline. */
  suggest?: string;
  /**
   * Per-entry transitive policy.
   * 'fail' = hard-fail at any depth. The user has it as a (perhaps
   *          deep) dependency and we will not pretend otherwise.
   * 'warn' = top-level fails, transitive logs '[skip]' and continues.
   *          Used for genuinely-optional natives like fsevents.
   */
  transitive: 'fail' | 'warn';
}

export const REJECT_INSTALL: ReadonlyArray<RejectEntry> = [
  // Same-require-name natives that crash at load time
  { from: 'sharp',           reason: 'Native libvips bindings; not portable to Workers.',                       suggest: 'no Workers-compatible swap; render server-side and ship pixels.', transitive: 'fail' },
  { from: 'sqlite3',         reason: 'Native sqlite3 .node binding.',                                            suggest: 'better-sqlite3-wasm or sql.js (after W6.5 loader fix).',          transitive: 'fail' },
  { from: 'better-sqlite3',  reason: 'Native sqlite .node binding.',                                             suggest: 'better-sqlite3-wasm or @libsql/client (after W6.5 loader fix).',  transitive: 'fail' },
  { from: 'canvas',          reason: 'Native Cairo bindings.',                                                   suggest: 'no Workers-compatible swap; render server-side and ship pixels.', transitive: 'fail' },
  { from: 'sodium-native',   reason: 'Native libsodium.',                                                        suggest: 'tweetnacl (pure JS) or libsodium-wrappers (WASM).',                transitive: 'fail' },
  { from: 'fsevents',        reason: 'macOS-only filesystem watcher; never runs in Workers.',                    suggest: 'optional dep — chokidar/watchpack work without it. Move to optionalDependencies.', transitive: 'warn' },
  { from: 'bufferutil',      reason: 'Native binding for ws speedups; install requires node-gyp.',               suggest: 'optional dep — ws works without it (slower frames). Move to optionalDependencies.', transitive: 'warn' },
  { from: 'utf-8-validate',  reason: 'Native binding for ws speedups; install requires node-gyp.',               suggest: 'same as bufferutil.',                                              transitive: 'warn' },
  { from: 'node-pty',        reason: 'PTY syscalls unavailable in workerd.',                                     suggest: 'use Nimbus built-in shell.',                                       transitive: 'fail' },
  { from: 'robotjs',         reason: 'Desktop automation; sandboxed Workers cannot access OS UI.',               suggest: 'no Workers-compatible target.',                                    transitive: 'fail' },
  { from: 'electron',        reason: 'Embedded Chromium runtime; not applicable to Workers.',                    suggest: 'no Workers-compatible target.',                                    transitive: 'fail' },

  // Different-require-name natives (would be SWAPS if we had npm-alias support)
  { from: 'bcrypt',          reason: 'Native bcrypt; pure-JS bcryptjs has identical sync API but the require() name differs and Nimbus does not yet support `npm:` aliases.', suggest: 'change `require("bcrypt")` to `require("bcryptjs")`, then `npm install bcryptjs`. APIs are sync-compatible.', transitive: 'fail' },
  { from: 'argon2',          reason: 'Native Argon2 C bindings.',                                                suggest: 'hash-wasm (argon2d/argon2i/argon2id; verified — see audit/probes/wasm/hash-wasm.out.txt).', transitive: 'fail' },
  { from: 'node-sass',       reason: 'Native libsass; deprecated upstream.',                                     suggest: 'sass (dart-sass, pure JS).',                                       transitive: 'fail' },
  { from: 'grpc',            reason: 'Deprecated native gRPC.',                                                  suggest: '@grpc/grpc-js (pure JS).',                                         transitive: 'fail' },
  { from: '@swc/core',       reason: 'Native Rust SWC.',                                                         suggest: '@swc/wasm-web (transform/parse only; no Plugin API; loader gap pending W6.5).', transitive: 'fail' },

  // ORM natives
  { from: 'prisma',          reason: 'Native query engine; not portable to Workers in this configuration.',     suggest: '@prisma/adapter-d1 (Prisma official Workers adapter), or migrate to drizzle-orm + @libsql/client.', transitive: 'fail' },
  { from: '@prisma/client',  reason: 'Same as `prisma`.',                                                        suggest: 'same as prisma.',                                                  transitive: 'fail' },

  // Build-time native compilers (always wrong in Workers)
  { from: 'node-gyp',        reason: 'Build-time native compiler; never runs in Workers.',                       suggest: 'remove from dependencies — Nimbus pre-skips build-only tools.',    transitive: 'warn' },
  { from: 'node-pre-gyp',    reason: 'Build-time native compiler; never runs in Workers.',                       suggest: 'remove from dependencies.',                                        transitive: 'warn' },

  // Bundled-binary giants
  { from: 'puppeteer',       reason: 'Bundled Chromium binary (~150 MB).',                                       suggest: 'puppeteer-core + Cloudflare Browser Rendering.',                   transitive: 'fail' },
  { from: 'playwright',      reason: 'Bundled browsers (~300 MB).',                                              suggest: '@playwright/test against a remote browser endpoint.',              transitive: 'fail' },

  // Loader-gap honesty (these install fine but fail at runtime today; W6.5 loader fix removes them)
  { from: 'sql.js',          reason: 'Installs but fails at runtime: WASM artifact `dist/sql-wasm.wasm` not extracted by Nimbus (loader gap).', suggest: 'tracked as W6.5 — extraction filter for `dist/*.wasm`.', transitive: 'fail' },
  { from: '@swc/wasm-web',   reason: 'Installs but fails at runtime: file not pre-bundled in VFS (loader gap).', suggest: 'tracked as W6.5 — VFS pre-bundle wiring.',                          transitive: 'fail' },
];
```

> **Note on `@libsql/client`**: probe artifact says "needs W2 resolver fix"
> — that's a *resolver* gap, not a *load* gap. Excluded from REJECT to
> avoid pre-empting a fix that may already have landed (it post-dates
> the probe). If users hit it after W6 ships, add a reject entry then.

### 3.3 Lookup API

```ts
export function lookupSwap(name: string): SwapEntry | undefined;
export function lookupReject(name: string): RejectEntry | undefined;

/** Pure: rewrite swap.from→swap.to in specs map. Idempotent. */
export function applySwaps(specs: Record<string, string>):
  { specs: Record<string, string>; swaps: SwapEntry[] };

/**
 * Pure: return rejects whose policy applies at this depth.
 *   ctx='top'        → returns ALL matching rejects (any policy).
 *   ctx='transitive' → returns only `transitive: 'fail'` rejects.
 *                      'warn' rejects at depth>0 are handled by the
 *                      resolver as a `[skip]` log + continue.
 */
export function findRejects(specs: Record<string, string>, ctx: 'top' | 'transitive'): RejectEntry[];

export function shouldWarnSkipTransitive(name: string): RejectEntry | undefined;

/** Formatters return ANSI-coloured single-line strings. */
export function formatSwapNotice(s: SwapEntry): string;
export function formatRejectError(rejects: RejectEntry[]): string;     // multi-package, leading summary line
export function formatTransitiveSkip(r: RejectEntry): string;
```

## 4. Detection points

### 4.0 Pre-step — migrate names from `SKIP_PACKAGES` to the registry

**Critical defect identified by reviewer:** `SKIP_PACKAGES` in
`npm-resolver.ts:619-630` and its preamble duplicate at
`parallel/npm-resolve-preamble.ts:30-45` filter via `shouldSkipPackage`
**before** `applySwaps` would run. So `esbuild` and `fsevents` (both in
SKIP_PACKAGES today) are stripped from the spec map before the registry
ever sees them. Fix: move them out.

**Names removed from `SKIP_PACKAGES`** (and added to W6 registries):
- `esbuild`     → WASM_SWAPS (target: esbuild-wasm)
- `fsevents`    → REJECT_INSTALL (transitive=warn)

**Names that REMAIN in `SKIP_PACKAGES`** (build-only, no runtime swap/reject needed):
typescript, vite, rollup, webpack, parcel, postcss, autoprefixer,
tailwindcss, cssnano, prettier, eslint, stylelint, chokidar, node-gyp,
node-pre-gyp, @cloudflare/vite-plugin, @cloudflare/workers-types,
wrangler, husky, lint-staged, commitlint.

`chokidar` stays — the real-vite shim intercepts it (Section-04 concern,
not W6). `node-gyp`/`node-pre-gyp` are in BOTH `SKIP_PACKAGES` (build-only
pruning) AND `REJECT_INSTALL` with `transitive='warn'` — that's
intentional: a top-level `npm install node-gyp` should hard-fail with a
clear message, but transitive `node-gyp` (ubiquitous in lifecycle scripts)
should be silently skipped exactly as today. The registry's top-level
`findRejects(...,'top')` fires before `shouldSkipPackage`; transitively
`shouldSkipPackage` fires first, so the warn-message never appears for
transitive node-gyp. **Documented intent**, see §10 risk row.

The `parallel/npm-resolve-preamble.ts` SKIP set must mirror the same
removals; functional/preamble-parity probe gates this.

### 4.1 Top-level — in `buildSpecs` (`npm-installer.ts:832-880`)

After both branches populate `specs`, before `return`:

```ts
// in src/npm-installer.ts buildSpecs():
const { specs: swapped, swaps } = applySwaps(specs);
for (const s of swaps) onProgress?.(formatSwapNotice(s));

const rejects = findRejects(swapped, 'top');
if (rejects.length) {
  throw new Error(formatRejectError(rejects));
}
return swapped;
```

Catches:
- `npm install bcrypt` (explicit-package branch)
- a `package.json` with `"bcrypt": "^5"` (package.json branch)

`buildSpecs` does NOT call `shouldSkipPackage` *after* §4.0's removal — wait,
it still does, at lines 864 and 872 (filtering chokidar etc.). That's fine:
removing `esbuild`/`fsevents` from SKIP_PACKAGES means they pass through
the filter and reach `applySwaps`. Names still in SKIP_PACKAGES are still
filtered out — they never reach the registry, by design.

### 4.2 Transitive — THREE locations, kept byte-equivalent

The transitive resolver exists in three places that **must stay in
lock-step** (precedent: `SHOULD_SKIP_PACKAGE` is already duplicated this
way). Edits to ANY without the others is a silent regression.

| File | Location | Why |
|---|---|---|
| `src/npm-resolver.ts` `resolveTree` | ~line 532 (next to `shouldSkipPackage` call) | Legacy in-supervisor walk. Used when `NIMBUS_FACET_RESOLVER=0`. |
| `src/npm-resolve-facet.ts` `resolveTreeInFacet` body | ~line 412 + ~line 513 | **Default prod path** — runs in NimbusFacetPool isolate. References preamble symbols by bare identifier (the function is serialised via `fn.toString()`). |
| `src/parallel/npm-resolve-preamble.ts` | After existing `SHOULD_SKIP_PACKAGE` (line ~45) | String-injected preamble providing helpers to the facet isolate. New helpers `SHOULD_SWAP(name)` and `SHOULD_WARN_SKIP_TRANSITIVE(name)` go here. |

Because the facet function is serialised, the swap/reject lookup tables
**must also be inlined into the preamble** — you can't `import` from
the supervisor's `wasm-swap-registry` module from inside the isolate.

Transitive policy:
- **swap match:** rewrite name in-flight; resolver fetches the swap
  target's packument. Emits `[swap]` log via `onProgress`.
- **reject match, `transitive='fail'`:** throw inside the resolver — same
  behaviour as a top-level fail. Same error formatter. **Why** (vs warn):
  finding `puppeteer` deep in a tree means the user has it as a real
  dependency; silently dropping it at depth>0 would be a worse silent-
  failure than the registry exists to prevent.
- **reject match, `transitive='warn'`:** log a `[skip]` line via
  `onProgress`, return null from `resolvePackage` (matches existing
  `shouldSkipPackage` behaviour), continue.

`shouldUseFacetResolver()` defaults to true (npm-installer.ts:478-485).
A patch that only edits `resolveTree` ships dead code in prod.

### 4.3 Why three points instead of one

- Top-level rejects must fail before resolution (faster feedback;
  nothing fetched).
- Both transitive resolvers must be patched or behaviour diverges
  between local-test (legacy path) and prod (facet path).

## 5. REJECT message taxonomy

### 5.1 Swap notice (informational, yellow)

```
[npm] [swap] esbuild → esbuild-wasm (Native esbuild not available in Workers; esbuild-wasm exposes the same build/transform/version/initialize API.)
```

Format string: `` `[npm] \x1b[33m[swap]\x1b[0m ${from} → ${to} (${reason})` ``

### 5.2 Reject error (hard, red, two-column)

For top-level (thrown), with leading summary:

```
npm install rejected: 3 of 5 packages are not supported on Nimbus.
  ❌ sharp     — Native libvips bindings.       try: render server-side and ship pixels.
  ❌ prisma    — Native query engine.            try: @prisma/adapter-d1.
  ❌ bcrypt    — Native bcrypt; require() name differs.  try: change require("bcrypt") → require("bcryptjs"), then npm install bcryptjs.

Run `nimbus npm doctor` for a full compatibility report.
```

(`nimbus npm doctor` is aspirational; if not implemented, the line is
dropped — see §10.)

### 5.3 Transitive skip (warn, yellow)

```
[npm] [skip] fsevents — macOS-only filesystem watcher; never runs in Workers
```

Format: `` `[npm] \x1b[33m[skip]\x1b[0m ${from} — ${reason}` ``

## 6. Per-package WASM viability methodology

W6 src/ changes do **not** add new runtime support. The registry's job
is *honest naming*. Per-package viability comes from:

- Existing `audit/probes/wasm/*.out.txt` artefacts (12 packages probed
  2026-04-29). `_SUMMARY.json` is **misleading** — it records `ok:true`
  for install success; actual import results are in the per-package
  `.out.txt`. Verified: `sql.js` ENOENT on .wasm; `@swc/wasm-web` not
  pre-bundled; `wasm-vips` only `default` export.
- A new prod-gated `e2e/registry-coverage.mjs` walking the registry
  against a live session. Off by default, mirrors W5's prod-gated e2e.

### 6.1 Initial verdict matrix (refined in retro)

| Package          | Install? | Load+smoke? | W6 action                |
|------------------|----------|-------------|--------------------------|
| esbuild-wasm     | ✅       | ✅ (used)    | swap target              |
| esbuild (native) | n/a      | n/a         | **SWAP**                 |
| bcrypt           | resolves | crash       | **REJECT** (require-name)|
| argon2           | resolves | crash       | **REJECT** (require-name)|
| node-sass        | resolves | crash       | **REJECT** (require-name)|
| grpc             | resolves | crash       | **REJECT** (require-name)|
| @swc/core        | resolves | crash       | **REJECT** (require-name)|
| sharp            | resolves | crash       | **REJECT**               |
| sqlite3 / better-sqlite3 | resolves | crash | **REJECT**            |
| canvas           | resolves | crash       | **REJECT**               |
| sodium-native    | resolves | crash       | **REJECT**               |
| fsevents         | resolves | n/a optional| **REJECT** (warn)        |
| bufferutil / utf-8-validate | resolves | n/a optional | **REJECT** (warn) |
| node-pty / robotjs / electron | various | n/a | **REJECT**          |
| prisma / @prisma/client | resolves | crash | **REJECT**             |
| node-gyp / node-pre-gyp | resolves | n/a | **REJECT** (warn)        |
| puppeteer / playwright | huge | n/a | **REJECT**                    |
| sql.js           | ✅       | ❌ ENOENT    | **REJECT** (loader gap)  |
| @swc/wasm-web    | ✅       | ❌ pre-bundle| **REJECT** (loader gap)  |
| @libsql/client   | ✅       | unknown     | leave alone (resolver may already work post-W2/W5) |
| wasm-vips        | ✅       | partial     | leave alone (suggest target only) |
| bcryptjs / hash-wasm / sass / @grpc/grpc-js | ✅ | ✅ | suggest targets only |

## 7. Test plan (TDD red phase)

All probes follow the W5 layout (`audit/probes/w6/{functional,regression,e2e}/`,
`_tap.mjs`-style assertions, `run-all.mjs` orchestrator).

### 7.1 Functional (pure-unit, no network)

| Probe | Asserts |
|---|---|
| `functional/registry-shape.mjs` | `WASM_SWAPS` and `REJECT_INSTALL` exported; required fields present; no overlap of `from` between the two; every reject has reason; suggest is optional. |
| `functional/lookup.mjs` | `lookupSwap('esbuild')` returns the entry; `lookupSwap('not-listed')` returns undefined; case-sensitive. |
| `functional/apply-swaps.mjs` | `applySwaps({esbuild:'^0.19', lodash:'^4'})` → `{esbuild-wasm:'latest', lodash:'^4'}` + one swap. **Idempotent** (`applySwaps(applySwaps(x).specs).specs` deep-equals `applySwaps(x).specs`). Empty input → empty output. |
| `functional/find-rejects.mjs` | `findRejects({sharp:'*', lodash:'^4'}, 'top')` → one sharp reject. Same input ctx='transitive' for `transitive='fail'` (`sharp.transitive==='fail'`) → still one. For `fsevents`: ctx='top' returns it (any-depth fail); ctx='transitive' returns empty (warn-only). Empty for clean inputs. |
| `functional/format-messages.mjs` | `formatSwapNotice` exact string match; `formatRejectError([single])` and `[multi]` match templates in §5.2; `formatTransitiveSkip` matches §5.3. ANSI codes present; reason and from substrings appear. |
| `functional/no-conflict-with-skip.mjs` | None of `WASM_SWAPS.from` / `REJECT_INSTALL.from` (with `transitive='fail'`) appears in the `SKIP_PACKAGES` set in `npm-resolver.ts`. (`transitive='warn'` rejects MAY overlap intentionally — node-gyp/node-pre-gyp/fsevents — and the test allows this for a documented allowlist.) |
| `functional/preamble-parity.mjs` | The `parallel/npm-resolve-preamble.ts` string contains every name in `WASM_SWAPS.from` and `REJECT_INSTALL.from`. Catches preamble drift on registry edits. |

### 7.2 Regression

| Probe | Asserts |
|---|---|
| `regression/install-pipeline-coverage-meta.mjs` | The prod install-pipeline-coverage probe still exists, parses, has all 4 scenario labels (fastify/express/ts-jest/redis). Mirrors `w5/regression/install-pipeline-coverage.mjs`. |
| `regression/skip-set-curated.mjs` | The post-W6 `SKIP_PACKAGES` set (in resolver + preamble) is **exactly** the curated residual list in §4.0. Catches both accidental re-adds (esbuild/fsevents back into skip) AND accidental removals. |
| `regression/builds-specs-passthrough.mjs` | `buildSpecs` with no W6-affected packages in its inputs returns the same map shape as before W6 (sentinel input: `{lodash:'^4', react:'^18'}`). |
| `regression/resolver-paths-symmetric.mjs` | A simulated transitive walk through both `resolveTree` (legacy) and `resolveTreeInFacet`/preamble (facet) produces identical swap/reject behaviour for a fixed input. (Stub the network calls; assert decisions only.) |

### 7.3 E2E

| Probe | Asserts |
|---|---|
| `e2e/build-specs-integration.mjs` | A live `applySwaps`+`findRejects` call with input `{esbuild:'*', sharp:'*', lodash:'^4'}` (mixed swap + reject + neutral): swap notice emitted, reject thrown with sharp-and-prisma-style multi-line message, lodash unchanged. |
| `e2e/transitive-warn-not-throw.mjs` | Simulated resolver loop: `fsevents` at depth>0 emits `[skip]` via captured onProgress, does NOT throw, the function returns. |
| `e2e/lockfile-replay-with-swap.mjs` | Cold install with `esbuild` in deps → swap notice emitted, lockfile records `esbuild-wasm`. Warm install with same lockfile → swap notice NOT re-emitted (deps already swapped); package.json still says `esbuild`. |
| `e2e/swap-target-symbol-parity.mjs` | For each `compat:'drop-in'` swap: load both `<from>` (in the dev dependencies of THIS workspace where available) and `<to>` and assert export-key symmetric difference is empty for the keys we depend on (`build`, `transform`, `version`, `initialize`). Currently exercises only esbuild ↔ esbuild-wasm. If parity fails, the test fails red and forces a swap-entry demote. |
| `e2e/swap-preserves-package-json.mjs` | After a swap install (`npm install esbuild`), the user's `package.json` still contains key `"esbuild"` (NOT `"esbuild-wasm"`). The lockfile contains `esbuild-wasm`. (Tests that `updatePackageJson` honours the swap and does not silently rewrite the source-of-truth.) |
| `e2e/registry-coverage.mjs` | (PROD-gated `NIMBUS_W6_E2E_PROD=1`) Walks the registry: each swap → install `<from>`, expect `<to>` in node_modules; each reject → install `<from>`, expect non-zero exit + reason substring. **Skipped by default** — local-runnable probes alone cover the registry contract. |

`run-all.mjs` orchestrates all of the above as W5 does. Prod-only probes
are tagged and emit `SKIP (prod-gated)` rather than failing when the
gate env-var is unset.

## 8. Build plan (Phase C)

Order of commits, each green-turning a named test:

1. **Add `wasm-swap-registry` module** — `src/wasm-swap-registry.ts`.
   Greens: `functional/registry-shape`, `lookup`, `apply-swaps`,
   `find-rejects`, `format-messages`.
2. **Migrate `esbuild` and `fsevents` out of `SKIP_PACKAGES`** —
   `src/npm-resolver.ts` SKIP set + `src/parallel/npm-resolve-preamble.ts`
   SKIP set. Greens: `regression/skip-set-curated`,
   `functional/no-conflict-with-skip`.
3. **Add preamble swap/reject helpers** —
   `src/parallel/npm-resolve-preamble.ts`: inline `WASM_SWAPS` and
   `REJECT_INSTALL` lookup tables + `SHOULD_SWAP`/`SHOULD_WARN_SKIP_TRANSITIVE`
   helpers. Greens: `functional/preamble-parity`.
4. **Wire `buildSpecs`** — call `applySwaps` + `findRejects('top')` and
   throw on rejects. Greens: `e2e/build-specs-integration`,
   `regression/builds-specs-passthrough`.
5. **Wire `resolveTree`** (legacy path) — same logic at the transitive
   loop. Greens: `e2e/transitive-warn-not-throw` (legacy half).
6. **Wire `resolveTreeInFacet`** — patch both call sites
   (lines ~412 and ~513) using preamble helpers. Greens:
   `e2e/transitive-warn-not-throw` (facet half) + `regression/resolver-paths-symmetric`.
7. **Honour swap in `updatePackageJson`** — when a spec key was rewritten
   by `applySwaps`, write the original key into package.json (not the
   target). Greens: `e2e/swap-preserves-package-json`.
8. **Lockfile replay test fixture** — runs against in-memory installer
   without prod. Greens: `e2e/lockfile-replay-with-swap`.

Each commit message references the green-turning test (TDD discipline).
Sub-agent diff review per commit (or serial inline review with explicit
review-comment commit message if Task tool unavailable).

## 9. Sub-agent review

This file (v2) is the post-review revision of v1. Phase B onward gets
a sub-agent review on every src/ commit; if the Task tool fails (as
it sometimes does on large prompts), the session does serial inline
review and commits a "review-comment" line into the commit body.

## 10. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Registry in supervisor and registry duplicate in preamble drift | `functional/preamble-parity.mjs` snapshot test gates registry edits. Same pattern as existing SKIP_PACKAGES. |
| `applySwaps` called twice; second pass double-rewrites | Idempotency assertion in `functional/apply-swaps.mjs`. |
| Transitive `node-gyp`/`node-pre-gyp` flows through SKIP first, registry's `[skip]` warn-message never appears | **Documented intent** — top-level keeps the warn (better feedback), transitive falls through SKIP silently as it does today. The two filters compose: SKIP=silent build-only prune, REJECT(warn)=loud about it when at top. Test allowlist in `functional/no-conflict-with-skip` covers the intentional overlap. |
| Swap target has different require() name (bcryptjs ≠ bcrypt etc.) | All such candidates are REJECT, not SWAP. v1 included them as swap; reviewer caught. Documented as W6.5 ("add npm-alias support"). |
| `updatePackageJson` writes swap-target name to user's package.json (cross-env footgun) | Step 7 of build plan: skip the rewrite when key was swapped. Probe `e2e/swap-preserves-package-json`. |
| Lockfile records swap target; package.json still says original; appears "out of sync" | Intentional. Lockfile is source-of-truth for "what's installed"; package.json is source-of-truth for "what the user asked for". `isLockfileValid` already handles this (it walks the spec map, which has been swap-applied, against the lockfile, which records swap targets). Tested by `e2e/lockfile-replay-with-swap`. |
| Reject-target's own deps include another reject (e.g., wasm-vips suggested for sharp depends on something rejected) | Same registry walk applies to swap targets. A reject inside a swap-target tree hard-fails the install — correct behaviour. v1 of any registry update should manually verify swap-target trees are clean; documented in retro. |
| `nimbus npm doctor` referenced in §5.2 but not implemented | Drop the line if `npm doctor` shell command isn't wired. Not gating. |
| Loader-gap REJECTs (sql.js, @swc/wasm-web) become stale when W6.5 fixes the loader | Retro lists them as W6.5 candidates. The day the loader fix lands, those entries get removed in a follow-up wave. |
| `esbuild → esbuild-wasm` swap might not be drop-in for all users | `e2e/swap-target-symbol-parity.mjs` gates this. If parity fails, demote to REJECT in same commit. |

## 11. Done criteria

- [ ] `audit/sections/W6-plan.md` ✓ (this file, v2)
- [ ] All `audit/probes/w6/{functional,regression,e2e}/*.mjs` exist + committed RED before any src/ change
- [ ] `src/wasm-swap-registry.ts` exists; `buildSpecs`, `resolveTree`, `resolveTreeInFacet`, and `npm-resolve-preamble.ts` integrated; `updatePackageJson` honours swap
- [ ] All w6 functional + regression + non-prod e2e probes green locally (`bun audit/probes/w6/run-all.mjs`)
- [ ] `bunx tsc --noEmit` clean
- [ ] `audit/sections/W6-retro.md` ✓
- [ ] `audit/sessions/W6-progress.md` shows all 6 phases ✓
- [ ] Branch pushed to `origin/w6-wasm-swap` (or stuck file written + clear handoff)
