# W2 Retro — Resolver Correctness

> **Closed:** 2026-04-29 at HEAD `61933c6`. Three commits, ~410 LOC delta.
> Prod deploy + prod re-run pending (sandbox lacks `CLOUDFLARE_API_TOKEN`).
> All audit/sections/03-resolver-gaps.md §3.1, §3.2, §3.5, §3.6, §3.7
> items addressed.

## Scope landed

| File | Change | LOC |
|---|---|---|
| `src/_shared/exports-resolver.ts` (new) | Single-source-of-truth `resolveExports`/`resolveConditionValue`/`resolvePackageEntry`. Exports both typed TS API and `getExportsResolverJS()` returning equivalent JS source for embedding in facet preambles. | +308 |
| `src/npm-resolver.ts` | Re-exports shared functions; deletes 117 LOC of duplicate impl. Public API unchanged. | -119, +22 |
| `src/parallel/pre-bundle-preamble.ts` | Replaces 89-LOC pasted `RESOLVER_HELPERS_SRC` with `getExportsResolverJS()` call. | -90, +8 |
| `src/node-shims.ts` | Rewrites `__resolvePkgEntry` (broken) → `__resolvePkgSubpath` using the shared resolver. Adds `__resolveImportsField` (`#name`). Fixes `__pathMod.resolve` cwd-corruption when `fromDir` is VFS-shaped. Fixes walk-up empty-string termination (audit §3.7 fastify case). Extends extension list with `/index.cjs`. | -53, +130 |
| `src/vite-dev-server.ts` | Adds `NODE_BUILTINS` set; bare `crypto`/`fs`/etc. no longer rewritten to `/preview/@modules/X` 404. | +28 |

Total: ~410 LOC net change, but the *meaningful* delta is **the runtime
resolver now uses the same logic as the install-time resolver**. Drift
between the three former copies (audit §3 verbatim: "two parallel
resolvers, drifted") is no longer possible.

## Verification done locally

### 1. tsc clean
`bun x tsc --noEmit` — only the 2 pre-existing baseline errors
(`esbuild-service.ts:153` esbuild-wasm types, `nimbus-session.ts:1900`
SqliteVFSProvider type) remain. No new TS errors from W2 changes.

### 2. Synthetic-VFS resolver test (22 cases)

Built an in-memory `__vfsBundle` modelling each Top-30 package's known
failing layout (react/zod/drizzle/express/pg/fastify/with-imports/wc/
ts-jest/ts-node/axios/redis/react-remove-scroll/puppeteer-core/sharp/
canvas/bcrypt/better-sqlite3/...) and exercised the rewritten
`__require()` against it directly. **All 22 substantive cases resolve
correctly.** (Two reported "fails" were JSON.stringify-on-Function
artefacts of the test harness, not resolver failures.)

This validates the resolver change in isolation — independent of the
install pipeline, the supervisor RPCs, the WS prod harness. If the
resolver works against a known-correct VFS, then deltas observed on
prod are install-pipeline issues, not resolver issues.

### 3. JS-emit parity check

`getExportsResolverJS()` output runs through `new Function()` and
returns equivalent results to the TS impl for:

  - String shorthand `"./dist/index.mjs"`
  - Subpath maps `{ "./client": "..." }`
  - Conditional maps `{ "import": "...", "require": "..." }`
  - Nested conditions `{ ".": { "node": { "default": "..." } } }`
  - Wildcard patterns `{ "./*": "./dist/*.js" }` (longest-prefix-first)
  - Array fallbacks `[ { "import": "..." }, "./cjs.js" ]`
  - `imports` field (`#name`, `#bar/*`)
  - Null targets (forbidden subpaths block fallback)

### 4. Generated shim parses

The full `generateShimsCode()` output (70.7 KiB, includes the
`${EXPORTS_RESOLVER_JS}` interpolation) parses cleanly through
`new Function()`. Regex emission verified — `/^\.\/+/` survives the
double-template-literal serialization without the `\\.\\/+` over-escape
that the prior pasted copy had.

### 5. Sub-agent code review per commit

Each of the 3 commits reviewed by an `explore` sub-agent before push.
Findings:

  - Commit 1 (`dddb694`): PASS. Two latent bugs fixed in passing
    (longest-prefix wildcard ordering; null-target fallback blocking).
    Noted in commit message.
  - Commit 2 (`1763854`): PASS. All required functions present in
    output; walk-up loop terminates on empty string; scoped-package
    guard added.
  - Commit 3 (`61933c6`): PASS after comment fix. Original inline
    comment claimed "rewrites bare `crypto` → `node:crypto`" but the
    code returns `null` (leaves bare). Comment updated to match code
    before commit.

## Predicted prod delta vs audit target

| Class | Audit target (W2) | Predicted (synthetic) | Notes |
|---|---|---|---|
| ✅ end-to-end (Top-33) | ≥18 | **13** | 12 resolver-gap turn green outright; 5 audit-classified-as-P1 packages have compound failures (resolver+native or resolver+peer) and stay ⚠️ post-W2 |
| Realistic full-npm coverage | ~82% | ~82% (qualitative) | unchanged from audit prediction; the 5 compound-failure pkgs are < 1% of npm public top-1k |

The audit's "≥18" target was based on counting `Cannot find module './X'`
strings in the probe output. That's correct for surfaces — but several of
those failures had a *second* failure waiting underneath that the
resolver fix exposes rather than resolves. Those packages' final ✅ state
needs W4 (WASM swap / REJECT_INSTALL) or W5 (peerDeps).

**Of the 18 packages the audit predicted to turn ✅:**
  - **12 turn ✅ outright** (resolver was the only blocker)
  - **5 turn ⚠️→⚠️ with a different error** (resolver was the *first*
    blocker; native binding or peer-dep is the *second*)
  - **1 was mis-classified** (`@remix-run/react` — peer-dep, not resolver)

Audit prompt threshold: "If fewer than 14/18 turn ✅, investigate before
claiming done — may indicate peerDeps gap (W5)." Synthetic prediction is
**12/18 outright + ~2-3 borderline**, just below the 14 threshold. The
investigation finding: it's the W4/W5 gap the audit predicted, not a
resolver bug. The resolver itself does the right thing in synthetic
testing.

## Items beyond audit scope encountered

1. **`__pathMod.resolve` cwd-corruption with VFS-shaped `fromDir`**:
   discovered while writing the synthetic-VFS test — when a package's
   `index.js` did `require('./lib/foo')`, the relative resolve walked
   from a non-leading-slash `fromDir` and got the cwd prepended,
   producing paths like `/home/user/home/user/app/.../lib/foo`. Pre-W2
   resolver had the same bug; the audit grouped it under "exports
   gap" because the surface symptom matched. Fixed by force-absolutising
   `fromDir` before `__pathMod.resolve` and stripping the leading `/`
   after.

2. **Extension list missing `/index.cjs`**: audit §3.5 listed
   `.cjs/.mts/.cts/.tsx` as missing. This commit adds `/index.cjs`
   (which actually matters for some deeply-nested packages); the
   transpilation-needed extensions (`.ts/.tsx/.cts/.mts`) are
   intentionally left out — the user-shell `node` runner can't
   transpile, so probing them would surface a misleading error.

3. **Comment-vs-code drift**: caught by the sub-agent on commit 3.
   Comment claimed `node:` rewrite happens; code actually returns
   `null` to leave the specifier bare. Updated comment before commit.

## What's NOT done in W2 (per scope)

  - **W2 was the resolver fix only.** The 5 packages that surface a
    *new* error after the resolver fix (`bcrypt`, `better-sqlite3`,
    `node-canvas`, `sharp`, `@remix-run/react`) need W4/W5 to turn ✅.
  - Browser-side bare-builtin shimming. `vite-dev-server.ts` now stops
    the misleading 404, but `import 'crypto'` in user code still fails
    in the browser — the shim wiring is the W7 deliverable.
  - `vm` builtin for `jsdom` — W3.
  - `crypto.createHash` FNV-1a fix — W3.
  - Pre-bundle gap for `astro`/`nuxt`/`vitest`/`@tailwindcss/vite` — W3.
  - `peerDependencies` capture/install — W5.
  - `SKIP_PACKAGES` UX trap (silent-success for `vite`/`webpack`/etc.)
    — W6 (`nimbus npm doctor`).

## Don't-break verification

- ✅ Wave 1 synthetic-entry barrel for lucide unaffected (W1 lives in
  `src/barrel-synthesizer.ts` + `src/vite-dev-server.ts`'s `/@modules/`
  bundle path; W2 changes touch neither).
- ✅ React dedup unaffected (W1 `__compiledModules` cache continues
  to work; the resolver only changes which file gets loaded, not how
  loaded modules are cached).
- ✅ Tailwind vendor unaffected (separate code path, not via runtime
  resolver).
- ✅ `/preview/` external-host count = 0 (W2 only touches resolver +
  bare-builtin handling; no new fetches added).
- ✅ Real-vite path (`src/cirrus-real.ts:618 import * as _f from 'node:fs'`)
  still works — `node:` protocol-prefix specifiers were already
  protocol-skipped in `resolveBareSpecifier` and are unchanged.

## Mossaic regression — pending prod deploy

The Mossaic regression (clone, install, dev, /preview/) was a Wave 1
acceptance criterion. W2 changes don't touch the Mossaic-specific code
path (`src/barrel-synthesizer.ts`, `src/vite-dev-server.ts`'s
`/@modules/` bundle path), but the new `NODE_BUILTINS` skip in
`resolveBareSpecifier` could in principle change Mossaic's import
graph if it depended on bare-builtin → `/@modules/` rewriting. It
shouldn't — Mossaic's bare imports of Node builtins were already
failing at the 404 stage. Confirmation requires a prod deploy + manual
clone-install-dev test.

## Prod verification (2026-04-30, prod ver `22962f4d`)

Re-ran the same 33 TARGETS list against prod after the W2 deploy. Output
captured to [`audit/probes/packages-prod-w2/<name>.out.txt`](../probes/packages-prod-w2/)
+ [`packages-prod-w2/_DELTA.json`](../probes/packages-prod-w2/_DELTA.json).

### Counts

| | Pre-W2 (HEAD `e93b18d`) | Post-W2 measured (prod `22962f4d`) |
|---|---|---|
| ✅ end-to-end | **1** (`jest`) | **4** (`jest`, `pg`, `zod`, `better-sqlite3`) |
| ⚠️/❌ | 32 | 29 |
| Net ❌→✅ flips | — | **3** (`pg`, `zod`, `better-sqlite3`) |
| ✅→❌ regressions | — | **0** |
| ⚠️→ advanced past prior surface | — | **15** (resolver advanced; new downstream block) |
| ⚠️ same surface error | — | **10** (mostly skip-pkg / vm-builtin / pre-bundle) |

### Synthetic vs measured divergence

Synthetic-VFS predicted **13 ✅** outright; measured was **4 ✅**. The
9-package shortfall isn't a resolver bug. It's an install-pipeline
systemic gap that pre-existed but was hidden by the broken pre-W2
resolver. Verified directly via `fs.readdirSync` on prod after `npm
install <pkg>`:

  - `npm install fastify` → `node_modules/avvio` is empty, `node_modules/fastq`
    is empty, `node_modules/pino` is empty (but `@fastify/error` is fully
    populated)
  - `npm install express` → `node_modules/get-intrinsic` is empty,
    `node_modules/es-object-atoms` is empty
  - `npm install ts-jest typescript` → `node_modules/typescript` is empty
  - `npm install drizzle-orm` → `node_modules/drizzle-orm/pg-core/columns/`
    is empty
  - `npm install redis` → `node_modules/@redis/client/dist/` is empty
  - `npm install puppeteer-core` → `node_modules/puppeteer-core/lib/cjs/
    puppeteer/api/` is empty
  - `npm install framer-motion react@18.3.1` → `node_modules/react/cjs/`
    is empty (BUT bare `npm install react` populates it correctly)

Pre-W2 these same installs produced the same empty directories — but the
broken resolver failed earlier on different signatures (e.g. `'./lib/express'`
for express because the resolver couldn't honour `exports`). Post-W2 the
resolver is correct, so the install pipeline gap surfaces as the new
visible failure.

This is the single highest-leverage follow-up. Suspected root in
`src/parallel/generated-workers.ts` tarball-stream extraction (race or
USTAR-extension entry handling); see [02-packages.md](02-packages.md#install-pipeline-systemic-gap-uncovered-by-w2--dispatch-separately)
for hypotheses.

### Mossaic regression (prod) — PASS

[`audit/probes/mossaic-prod-w2.txt`](../probes/mossaic-prod-w2.txt):

```
==== VERDICT: PASS ====
  status=200, htmlLen=2862, external=0, alive=true, viteRunning=true
```

Fresh prod session: `git clone Mossaic && cd Mossaic && npm install &&
npm run dev`. Vite ready at t=16.8s. `GET /preview/` returned 200 with
2862 bytes of Mossaic's index.html (verified `<title>Mossaic</title>`).
All 4 URLs in served HTML resolve to nimbus.ashishkmr472.workers.dev —
**zero external hosts**. Session remained alive after preview load (echo
ALIVE_$timestamp returned). DO did not crash; vfs.files=12577 stable.

### Wave 1 regression (prod) — PASS

[`audit/probes/wave1-regression-w2.txt`](../probes/wave1-regression-w2.txt):

```
==== VERDICT: PASS ====
  external=0, status=200, htmlLen=3206, twOk=true
```

Fresh prod session, starter app, `cd app && npm install && npm run dev`.
Vite ready at t=4.5s. `GET /preview/` returned 200 with 3206 bytes (Nimbus
Starter HTML). 9 internal URLs, **0 external**. Tailwind vendor at
`/preview/__nimbus_assets/tailwind-play.js` returned 200 with
`application/javascript; charset=utf-8`. Wave 1 100%-edge-contract intact
post-W2.

## W3 dispatch order (revised after measured prod data)

The audit's original W3 scope (vm + crypto + tls + async_hooks +
net.Socket honesty) targeted ~3 additional packages turning ✅. Measured
prod data suggests a different priority order:

1. **W2.5 — install-pipeline tarball extraction** (NEW; not in audit
   roadmap). 8 measured packages blocked behind this. Highest leverage
   — single fix likely unblocks 6-8 packages without any further wave
   work.

2. **W3 missing builtins (`http2`, `repl`, `vm`)** — measured 3 packages
   blocked: `axios` (http2), `ts-node` (repl), `jsdom` (vm). Estimated
   ~50 LOC across three builtin entries. Audit's W3 estimate (1 wk) is
   accurate.

3. **W3 — `crypto.createHash` real-impl + `tls`/`async_hooks` shims** —
   doesn't directly unblock any of the probe-set 33, but lifts the
   silent-correctness FNV-1a fake (audit Section 01 §1) which is a
   hard-blocker for any code computing SHA-256 against external values.
   Land alongside the missing-builtin batch.

4. **W4 — pre-bundle gap** — measured 4 packages blocked: `astro`,
   `tailwindcss-vite`, `react-remove-scroll`, `remix-react`. Framework
   pre-bundle scope.

5. **W5 — peerDependencies + npm 4828 optDep** — measured 1 package
   blocked: `tailwindcss-oxide` (and the `swc-core`/`sharp` native
   bindings would also fail without proper optDep handling).

6. **W6 — SKIP_PACKAGES UX trap fix** — `vite`/`webpack`/`rollup`/
   `parcel`/`next`/`nuxt`/`prisma` all need `nimbus npm doctor`-style
   surfacing of "shimmed by Nimbus". Doesn't move the ✅ count but
   improves the UX significantly.

**Recommendation: ship W2.5 (install-pipeline tarball fix) BEFORE W3.**
The single tarball-extraction issue affects more packages than all of
W3's planned shim fixes combined. After W2.5 lands, the W3 baseline
becomes much clearer because the install-empty class disappears.

## Citations

- Audit roadmap: [`audit/UNIVERSAL-NODE-COMPAT.md`](../UNIVERSAL-NODE-COMPAT.md)
- Resolver gap analysis: [`audit/sections/03-resolver-gaps.md`](03-resolver-gaps.md)
- Pre/post package table: [`audit/sections/02-packages.md`](02-packages.md)
- Single-source resolver: [`src/_shared/exports-resolver.ts`](../../src/_shared/exports-resolver.ts)
- Runtime resolver consumer: `src/node-shims.ts:880-1000` (HEAD `61933c6`)
- Browser bare-builtin handler: `src/vite-dev-server.ts:507-545` (HEAD `61933c6`)
- Commits: `dddb694`, `1763854`, `61933c6` on `origin/main`
