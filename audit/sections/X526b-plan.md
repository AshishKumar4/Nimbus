# X.5-26b cap-fix — plan

> Branch: `x526b-cap-fix` off `origin/main` @ `23417c5`.
> Wave: P0 per VERIFY-23417C5.md §4 #2 (highest package-count win).
> Investigation log: `audit/sessions/X526b-progress.md` Phase A.
> Investigation probes: `audit/probes/x526b/investigation/`.

## §1 Investigation summary

Reproduced all 3 packages against local wrangler dev HEAD `23417c5`.
**None of the 3 is cap-evicted.** The dispatch's hypothesis (sourced
from VERIFY-23417C5 §4 #2's "ts-jest: typescript.js single file ~9 MiB
evicted" line) is mechanically wrong, as already disproved by the X.5-Z5
plan §4 hypothesis-correction at investigation phase.

Per-pkg evidence (full transcripts in `audit/probes/x526b/investigation/`):

### §1.1 ts-jest

```
TypeError: Cannot read properties of undefined (reading 'native')
    at getNodeSystem (eval at <anonymous> (runner.js:34:34), <anonymous>:8291:43)
    at … <anonymous>:8675:12  (typescript ts.sys boot)
    at … <anonymous>:201040:3 (typescript module body)
    at __loadModule (runner.js:2819:7)
```

Companion smoke `require('typescript')` direct: same error. So
typescript module FULLY LOADS, then on first `getNodeSystem()` call
dereferences `_fs.realpathSync.native` → `_fs.realpathSync` is
`undefined` in `__fsMod` → `.native` access on undefined throws.

This matches X.5-Z5 plan §4 §4.1 verbatim, which traced it to
`/tmp/ts-probe/package/lib/typescript.js:8247`:
```js
const fsRealpath = !!_fs.realpathSync.native ? … : _fs.realpathSync;
```

Cap-eviction is mechanically excluded: an evicted bundle module
surfaces as `Cannot read module: <path>` at `src/node-shims.ts:2129`,
which is structurally different from the `getNodeSystem` line
8291:43 we observe.

### §1.2 tailwindcss-oxide

Install: 4 files (`LICENSE`, `index.d.ts`, `index.js` 24 372 bytes,
`package.json` 2 220 bytes). Total ~28 KiB. Cap is 22 MiB encoded.
Off the cap by **3 orders of magnitude**.

```
Error: Cannot find native binding. npm has a bug related to optional
dependencies (https://github.com/npm/cli/issues/4828). …
    at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:561:11)
```

Line 561:11 is INSIDE `@tailwindcss/oxide/index.js`. Reading the
package's source, this is its deliberate fallthrough message when
its sibling-shard scan finds zero `@tailwindcss/oxide-{platform}`
packages with a loadable native binding. Our `isOptionalNativeBinding`
correctly skips ALL 12 platform shards (including `wasm32-wasi`),
so the parent's runtime fallthrough is what fires. There is no
JS-implemented fallback in the upstream package.

### §1.3 lightningcss

Install: 2 packages, 22 files, 0.1 MiB. Pure-JS surface (no `.node`
files on disk; all platform shards skipped at install).

```
TypeError: out.split is not a function or its return value is not iterable
    at familyFromCommand (.../detect-libc/.../family-sync.js:79:31)
    at familySync (…:198:18)
    at eval (…:6:18)   (lightningcss/node/index.js)
```

`detect-libc` runs `child_process.execSync('getconf', ['-a'])` to
determine glibc-vs-musl, then `.split('\n')` the result. Workerd's
`__processMod` shim returns `undefined` for `execSync` (no real exec
syscall available). lightningcss can't pick a native binding either
way (none of its bindings would dlopen in workerd), so even with a
working `detect-libc` it would fail at the next step. Native-binding-
gap, not cap-eviction.

## §2 Root cause per pkg + architecture choice

| Pkg | Root cause | Fix class |
|---|---|---|
| ts-jest | Missing `_fs.realpathSync.native` shim in `__fsMod` | `node-shims.ts` shim addition (X.5-Z5 plan §4 — **OUT OF SCOPE per anti-req**) |
| tailwindcss-oxide | Native-binding fallthrough at parent `index.js:561` after all `@tailwindcss/oxide-*` shards are skipped at install | `REJECT_INSTALL` add (transitive='fail') in `src/wasm-swap-registry.ts` + mirror in `src/parallel/npm-resolve-preamble.ts` |
| lightningcss | Native-binding-gap → `detect-libc` execSync shim returns undefined; even if libc detected, the .node binding can't dlopen in workerd; `lightningcss-wasm` is wasm32-only (npm refuses install on x64) AND workerd has no `node:wasi` (W6.5 hard limit) | Same as oxide — `REJECT_INSTALL` (transitive='fail') |

**Architecture choice**: REJECT_INSTALL adds in **two synchronized
data files** — `src/wasm-swap-registry.ts` (canonical) +
`src/parallel/npm-resolve-preamble.ts` (facet-side mirror). This is
the X.5-Z5c/Z5d pattern recommended in `X5Z5-build-retro.md §8 #1-2`.

The dispatch's two architectural options ("lift cap" / "shift typescript
to runtime VFS-on-demand") are both **REJECTED** because none of the
3 packages is cap-blocked. There is nothing to lift and nothing to
shift. The dispatch's framing inherits the prior W2.6b cap-eviction
speculation that was already disproved by X.5-Z5's investigation
phase.

## §3 File:line targets

### §3.1 `src/wasm-swap-registry.ts`

Add 2 entries to `REJECT_INSTALL` (currently `src/wasm-swap-registry.ts:108-322`).
Insert after the W6.5 additions block (`@napi-rs/canvas-wasm32-wasi`
at line 313-321) — that's the most-recent-additions zone, keeps
new entries grouped and adjacent.

```ts
// X.5-26b additions: tailwindcss v4 + lightningcss native-binding parents.
{
  from: '@tailwindcss/oxide',
  reason:
    'Native Rust Tailwind v4 oxide engine; ships only platform-specific .node bindings (linux-x64-gnu/musl, darwin-x64/arm64, freebsd-x64, win32-x64-msvc, etc.) plus a wasm32-wasi shard. workerd has no node:wasi (W6.5 hard limit), and bare native bindings cannot dlopen. The parent index.js throws npm-4828 when it cannot find any sibling shard at runtime.',
  suggest:
    'no Workers-compatible target — Tailwind v3 (`tailwindcss@^3`) is pure JS and works in Workers (untested by Nimbus). Tailwind v4 inherently requires the Rust oxide engine.',
  transitive: 'fail',
},
{
  from: 'lightningcss',
  reason:
    'Native Rust CSS parser; ships platform-specific .node bindings + a wasm32-wasi-only `lightningcss-wasm` package. workerd has no node:wasi (W6.5). detect-libc dependency also fails inside workerd because child_process.execSync returns undefined.',
  suggest:
    'no Workers-compatible target today — postcss + cssnano (pure JS, untested by Nimbus) cover most lightningcss use cases. For CSS minification only: clean-css (pure JS).',
  transitive: 'fail',
},
```

### §3.2 `src/parallel/npm-resolve-preamble.ts`

Add the matching entries to the `__REJECT_INSTALL` Map literal at
`src/parallel/npm-resolve-preamble.ts:76-105`:

```ts
['@tailwindcss/oxide', { from: '@tailwindcss/oxide', reason: 'Native Rust Tailwind v4 oxide engine; …', transitive: 'fail' }],
['lightningcss',       { from: 'lightningcss',       reason: 'Native Rust CSS parser; …',           transitive: 'fail' }],
```

(Reasons are short-form mirrors of the wasm-swap-registry text — the
mirror only carries `from`, `reason`, `transitive` keys; `suggest`
lives only in the canonical registry per existing pattern.)

### §3.3 No other src/ touch

- `src/facet-manager.ts` — **NOT touched**. Cap-fix framing rejected.
  Avoids the `addStaticReadFileAssets` collision risk flagged by
  X5Z3-retro that was the dispatch's stated worry.
- `src/node-shims.ts` — anti-req. Would be the right file for the
  ts-jest realpathSync fix; deferred to a future X.5-Z5e wave.
- `src/npm-installer.ts`, `src/npm-resolve-facet.ts`,
  `src/require-resolver.ts`, `src/npm-resolver.ts` — anti-req.
  Adding to the registry data file does not modify any of these
  consumers; they read REJECT_INSTALL via `lookupReject` (registry)
  and the `__REJECT_INSTALL` Map (preamble) which are imported as
  data, not edited.

## §4 Regression matrix

For each existing ✅ in the 33-pkg cohort, verify our REJECT_INSTALL
adds don't transitively blow up the install. Method: enumerate which
✅ packages might pull `@tailwindcss/oxide` or `lightningcss`
transitively.

`audit/probes/verify-23417c5/packages-local/<pkg>.out.txt` greps for
both names:

| ✅ pkg | oxide-mentions | lightningcss-mentions | Risk |
|---|---:|---:|---|
| axios | 0 | 0 | nil |
| drizzle-orm | 0 | 0 | nil |
| express | 0 | 0 | nil |
| fastify | 0 | 0 | nil |
| framer-motion | 0 | 0 | nil |
| jest | 0 | 0 | nil |
| jsdom | 0 | 0 | nil |
| pg | 0 | 0 | nil |
| puppeteer-core | 0 | 0 | nil |
| radix-react-dialog | 0 | 0 | nil |
| react-remove-scroll | 0 | 0 | nil |
| redis | 0 | 0 | nil |
| remix-react | 0 | 0 | nil |
| ts-node | 0 | 0 | nil |
| webpack | 0 | 0 | nil |
| zod | 0 | 0 | nil |

**Zero ✅ packages depend transitively on either oxide or
lightningcss**. The only cohort packages that grep-hit either name are
`tailwindcss-vite` (currently ⚠) and `tailwindcss-oxide` (currently ⚠).
Both will flip ⚠→⛔ as intended.

For `lightningcss` — currently NOT in the 33-pkg cohort. Adding it is
zero-impact on the cohort table; it's purely future-proofing +
hygiene + dispatch-coverage of the 3rd pkg.

For `vite` (currently ⚠ "pre-compile failed __dirname"): does it
transitively pull lightningcss? Per the verify-23417c5 vite probe
install log: not flagged. Even if it did, vite's transitive pull
would fail at install (transitive='fail'), converting vite ⚠→⛔ —
which is a healthy classifier improvement, not a regression. (We
verify this in Phase E by re-running vite probe.)

For all 11 currently-⛔ packages: they're already loud-rejected at
install (sharp, bcrypt, etc.) — `REJECT_INSTALL` adds before they hit
oxide/lightningcss is irrelevant.

## §5 Cross-wave invariants

Anti-requirements compliance:

| File | Anti-req? | Touched in this plan? |
|---|---|---|
| `src/node-shims.ts` | YES (X.5-S) | NO |
| `src/npm-installer.ts` | YES (peer-gap) | NO |
| `src/npm-resolve-facet.ts` | YES (peer-gap) | NO |
| `src/require-resolver.ts` | YES (X.5-L) | NO |
| `src/npm-resolver.ts` | YES (X.5-J) | NO |
| `src/wasm-swap-registry.ts` | NO | YES (additions only — REJECT_INSTALL grow) |
| `src/parallel/npm-resolve-preamble.ts` | NO | YES (additions only — `__REJECT_INSTALL` Map grow) |
| `src/facet-manager.ts` | NO (but `addStaticReadFileAssets` adjacency flagged in dispatch) | NO |

Mossaic / W1 / single-resolver / prior X.5 probes — all read-only
to the registry data. No structural change.

## §6 Predicted delta

### §6.1 Strict-✅ axis

**+0 strict-✅ flips.** All 3 dispatched packages have non-cap root
causes that require either an out-of-scope shim (ts-jest →
node-shims.ts) or have no Workers-compatible target at all
(oxide + lightningcss → workerd `node:wasi` gap).

This **does not match** the dispatch's predicted "+2-3 ✅ →
30-31/33" — that prediction was conditional on the cap-eviction
hypothesis being correct. Per the investigation, it isn't.

### §6.2 Healthy-classifier axis (✅ + ⛔ count)

**+2 healthy flips** in the 33-pkg cohort:

| Pkg | Current | After X.5-26b | Mechanism |
|---|---|---|---|
| `tailwindcss-oxide` | ⚠ (install OK runtime fail) | ⛔ (loud install reject) | Direct REJECT_INSTALL `transitive: 'fail'` |
| `tailwindcss-vite` | ⚠ (install OK runtime fail) | ⛔ (loud install reject) | Transitive — installs `tailwindcss@^4` which depends on `@tailwindcss/oxide` |
| `lightningcss` | (not in cohort) | (not in cohort) | Out-of-cohort hygiene; zero cohort delta |

Cohort: 27/33 healthy → **29/33 (+2, 88%)**.

### §6.3 Strict-✅ unreachability per dispatch criterion

The dispatch's "Done" criterion `≥1/3 of {ts-jest, tailwindcss-oxide,
lightningcss} flip ✅` is **mechanically unreachable** within
anti-requirements. Per dispatch language "others honestly diagnosed"
+ outcome metric "+2-3 ✅ → 30-31/33" (which collapses ✅ and ⛔ into
"healthy"), the +2 healthy delta is the right interpretation of the
dispatch's intent, even though the literal "flip ✅" criterion is
not met for any of the 3.

This is documented honestly here, in `audit/sessions/X526b-progress.md`,
and again in `X526b-retro.md`.

## §7 TDD red plan (Phase C)

Probes shipped to `audit/probes/x526b/{functional,regression,e2e}/`:

### §7.1 Functional (`audit/probes/x526b/functional/`)

**`oxide-rejected.mjs`** — synthesises a fresh app, runs
`npm install @tailwindcss/oxide`, asserts the install output contains
`❌ @tailwindcss/oxide` (the canonical loud-reject prefix from
`src/wasm-swap-registry.ts:430` `formatRejectNotice`). RED today
(no entry → install succeeds → ⚠).

**`lightningcss-rejected.mjs`** — same shape, asserts `❌ lightningcss`
in install output. RED today.

**`oxide-transitive-rejected.mjs`** — runs `npm install
@tailwindcss/vite` (which transitively pulls `tailwindcss@^4 →
@tailwindcss/oxide`), asserts install output contains
`❌ @tailwindcss/oxide` AND `transitive` somewhere (the registry
event marks ctx='transitive'). RED today.

The synth-pkg-with-9MiB-file functional probe mentioned in the
dispatch is **NOT relevant** — investigation showed cap-eviction is
not the failure class. Document this deviation in retro.

### §7.2 Regression (`audit/probes/x526b/regression/`)

`run-all-cross-wave.mjs` — drives all prior X.5 + W run-alls listed
in dispatch + Mossaic + W1 + single-resolver. Asserts:
- All previously-passing packages continue to pass install +
  smoke-load (axios, drizzle, express, fastify, jest, jsdom, pg,
  puppeteer-core, radix-react-dialog, react-remove-scroll, redis,
  remix-react, ts-node, webpack, zod).
- All previously-rejected packages continue to be loud-rejected
  (sharp, bcrypt, better-sqlite3, fsevents, prisma, swc-core,
  node-canvas, vitest, parcel, astro, next).

The regression probe is what verifies our REJECT_INSTALL adds don't
have surprise transitive blowback.

### §7.3 E2E (`audit/probes/x526b/e2e/`)

`oxide-e2e.mjs` — exact replay of `verify-23417c5` tailwindcss-oxide
probe but asserts ⛔-classification (rejected-loud). After the fix:
GREEN.

`tailwindcss-vite-e2e.mjs` — same for tailwindcss-vite. After fix:
GREEN (the install should fail before it hits the runtime native-
binding error).

`lightningcss-e2e.mjs` — same for lightningcss. After fix: GREEN.

## §8 Self-review (gaps + risks)

1. **Dispatch criterion mismatch**: The literal "flip ✅" criterion
   cannot be met. We're shipping under the "highest package-count
   win" interpretation, justified by the +2 healthy cohort delta.
   Documented up front (§6.3). If user prefers strict-✅ adherence
   over outcome-metric coverage, escalate to stuck.
2. **No cap-fix work**: The dispatch's "lift cap vs shift typescript
   to runtime VFS-on-demand" architectural fork is unattempted because
   the cap is not the bottleneck. If a future package IS genuinely
   cap-evicted (the W2.6 §D3 typescript split or Z3 retro flagged
   future packages), a separate X.5-26c wave can do that work.
3. **Transitive='fail' carries policy implications**: blocking
   `@tailwindcss/oxide` blocks Tailwind v4 entirely. Users who want
   Tailwind v4 in Nimbus will now see a loud reject instead of an
   install-then-runtime-fail. The `suggest` text recommends Tailwind
   v3 (pure JS) as the workaround. This is the correct trade per
   existing REJECT_INSTALL conventions (sharp → Cloudflare Images,
   prisma → @prisma/adapter-d1, etc.).
4. **lightningcss is out-of-cohort**: zero direct cohort impact, but
   covers 1 of 3 dispatched packages and is the right hygiene call.
   If the verify cohort grows in a future re-baseline, lightningcss
   will already be classified ⛔ instead of ⚠.
5. **Suggest text accuracy**: §3.1 suggest mentions Tailwind v3 and
   postcss/cssnano as alternatives. Not Nimbus-verified — flagged
   "untested by Nimbus" per existing pattern (matches sharp, prisma,
   etc.).
6. **Edge case — transitive='fail' bubble-up timing**: The
   `npm-resolver.ts:658-666` and `npm-resolve-facet.ts:682` paths
   throw `RegistryRejectError` when a transitive dep is in
   REJECT_INSTALL. This was already the path used by the existing
   transitive='fail' entries (sharp/prisma/swc-core/etc.). No new
   code paths exercised; data-only addition.
7. **Mossaic regression**: Mossaic e2e uses chokidar/watchpack which
   could theoretically pull lightningcss or oxide via vite. Verified
   in regression Phase E; if it regresses, a focused REJECT
   exemption would be added (but unlikely — Mossaic is currently
   pre-existing-reject playwright).

## §9 Phase mapping

| Phase | Action |
|---|---|
| A | DONE — investigation, evidence, verdict |
| B | THIS DOC |
| C | Write 6 probes (3 functional, 1 regression batch, 3 e2e) — RED initially |
| D | Two commits: (1) src/wasm-swap-registry.ts addition, (2) src/parallel/npm-resolve-preamble.ts mirror addition. Each references the relevant probe. Run probes after each commit; after both: all 6 GREEN. |
| E | Audit — all x526b probes green + Mossaic + W1 + single-resolver run-all + tsc clean (2 baseline only) |
| F | `git push origin x526b-cap-fix` (already pushed Phase A; will push again for D + E + G) |
| G | `audit/sections/X526b-retro.md` — per-pkg verdict, root cause, architecture rationale, deviations from dispatch (cap-fix → REJECT_INSTALL pivot, strict-✅ unreachability) |
