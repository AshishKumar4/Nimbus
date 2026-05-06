# X.5-G Plan — optional-dependencies cohort

> Status: Plan-mode 2026-05-05. Worktree `x5g-optional-deps` off `main`
> HEAD `c3d9f47`. The X.5-F retro (`audit/sections/X5F-retro.md`,
> available locally from branch `x5f-resolve-miss`) is the parent
> document — its blocker table and per-package flip table identify the
> cohort this plan addresses.
>
> **Done criteria from dispatch:**
> 1. ≥ 2 of 4 packages turn ✅ (be honest if root cause forces ⛔).
> 2. NO src/nimbus-session.ts edits (collision with `session-refactor`).
> 3. Fixes confined to `src/npm-installer.ts`, `src/npm-resolver.ts`,
>    `src/wasm-swap-registry.ts` (preamble parity may force one
>    additional file — see §6.0).
> 4. All `audit/probes/x5g/` probes green; `tsc --noEmit` clean baseline
>    preserved; install-pipeline-coverage + Mossaic regression hooks
>    unchanged.
>
> **Baseline note:** This branch was rebased on top of
> `x5f-resolve-miss` (merged 2026-05-05) so the post-X5F resolver state
> (R1/R2/R2.5/R3) is the baseline. Without this merge, the 4 ⚠
> packages would still be in OLD-shape ❌ on main HEAD `c3d9f47`,
> making X5G's job impossible without first replicating X5F's work.
> The X5F retro itself states (`X5F-retro.md:48-56`) that the 4 ⚠
> outcomes are POST-X5F state.

---

## 1. The 4 packages — verbatim from X.5-F's flip table

The X5F retro `Per-package ❌→✅ flip table` (lines 48–56) lists 4 ⚠
remainders that share root cause: **optional dependencies (native or
peer) are not handled per the npm 4828 / `optionalDependencies` /
`peerDependenciesMeta.optional` semantics.**

| # | Pkg | X5F retro classification | Verbatim error |
|---|---|---|---|
| 1 | **rollup** | npm CLI bug #4828; same family as tailwindcss-oxide | `Cannot find module @rollup/rollup-linux-x64-gnu. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828).` |
| 2 | **@radix-ui/react-dialog** | react-remove-scroll subpath miss | `Cannot find module './Combination' (from .../react-remove-scroll/dist/es2015)` |
| 3 | **ts-jest** | `undefined.native` runtime probing | `Cannot read properties of undefined (reading 'native')` |
| 4 | **nuxt** | pathe split-bundle hash chunks | `Cannot find module './shared/pathe.BSlhyZSM.cjs' (from .../pathe/dist)` |

The X5F retro's blocker table (lines 145–149) tags only #1 (rollup) as
genuinely "X.5-G" cohort. Investigation in §2–§5 below shows that
**all four trace back to optional-deps semantics** — but at three
distinct layers (install-time platform skip, runtime native fallback,
peer-meta-optional handling). The dispatch's framing was correct.

### Citations
- `audit/sections/X5F-retro.md:50-56` — flip table.
- `audit/sections/X5F-retro.md:145-149` — blocker table.
- `audit/sections/W6.5-retro.md:32` — sharp-wasm32 platform-skip pattern
  precedent.
- Live registry packuments fetched 2026-05-05:
  - `https://registry.npmjs.org/rollup/latest` — 26 native bindings in
    `optionalDependencies`, each with `os`/`cpu`/`libc`.
  - `https://registry.npmjs.org/@rollup%2Frollup-linux-x64-gnu/latest`
    — `os: ["linux"], cpu: ["x64"], libc: ["glibc"]`,
    `main: "./rollup.linux-x64-gnu.node"` (a `.node` binary).
  - `https://registry.npmjs.org/@rollup%2Fwasm-node/latest` — exists,
    pure-WASM build of rollup.
  - `https://registry.npmjs.org/nuxt/latest` —
    `peerDependencies: ["@types/node","@parcel/watcher"]`, both
    `peerDependenciesMeta[name].optional = true`. `@parcel/watcher` is
    a Rust+napi native binding.
  - `https://registry.npmjs.org/ts-jest/latest` —
    `peerDependenciesMeta.esbuild.optional = true` (esbuild NOT in
    `peerDependencies`).
  - `https://registry.npmjs.org/@radix-ui%2Freact-dialog/latest` —
    `peerDependenciesMeta.@types/react.optional = true`,
    `peerDependenciesMeta.@types/react-dom.optional = true`.

---

## 2. Cluster G1 — transitive `optionalDependencies` with platform constraints

### Affected
- **rollup** — direct case. 26 platform-native `.node` bindings in
  `optionalDependencies`. Only `@rollup/rollup-linux-x64-gnu` matches
  the workerd host (linux/x64/glibc), and even that one is a Node.js
  N-API `.node` binary that workerd cannot dlopen.
- **nuxt** — indirect case. `@parcel/watcher` is in
  `peerDependenciesMeta.@parcel/watcher.optional` (i.e. an *optional
  peer*, structurally similar). Native Rust binding, never loadable in
  workerd.

### Evidence

1. `src/npm-resolver.ts:482` (`versionToResolved`) reads only
   `vData.dependencies`. It IGNORES `vData.optionalDependencies`,
   `vData.os`, `vData.cpu`, `vData.libc`. Same omission at
   `src/npm-resolve-facet.ts:276-292`.
2. The result: `optionalDependencies` are silently dropped at the
   transitive enqueue site (`npm-resolver.ts:593`, which only iterates
   `pkg.dependencies`). The package then installs but at runtime the
   parent does:
   ```js
   try { require('@rollup/rollup-linux-x64-gnu'); }
   catch (e) { /* try next */ }
   ```
   When NONE resolve (because none were installed), the parent throws
   the verbatim "npm has a bug related to optional dependencies #4828"
   string from rollup's own `native.js`.
3. We aren't actually hitting the npm CLI bug — we're hitting the
   **same-shaped error** because we never even tried to install the
   optional bindings. The downstream symptom is identical.

### Decision: silent-skip with telemetry

Per npm 4828 spec: optional deps with `os`/`cpu`/`libc` mismatching the
host OR with `.node`/native main MUST NOT be installed; the parent
package's runtime fallback handles the absence.

For workerd we go further: even on a linux/x64/glibc host, `.node`
binaries are useless because workerd cannot dlopen them. So the
correct semantic is: **`optionalDependencies` (and optional peer-deps)
that are detected as platform-native are silently skipped at the
resolver layer.**

A new helper `isOptionalNativeBinding(packument)` in
`wasm-swap-registry.ts` returns true when the package's packument has
ANY of:
- `os` field present (any value — restricts platform)
- `cpu` field present (any value)
- `libc` field present
- `main` field ends in `.node`
- name matches a known native-binding shape (`@rollup/rollup-*-*`,
  `@parcel/watcher-*-*`, `@swc/core-*-*`, `@next/swc-*`,
  `@tailwindcss/oxide-*`, `@img/sharp-*`, `@napi-rs/*-*`, …)

Skips emit a `RegistryEvent` of type `transitive-skip` (already exists)
so demand-signal aggregation works.

### Per-package likely outcome after G1
| Pkg | Expected after fix |
|---|---|
| rollup | G2's swap (§3) takes precedence: `npm install rollup` → installs `@rollup/wasm-node` (no native shards in tree). `require('rollup')` works through `@rollup/wasm-node/dist/rollup.js`. **Likely outcome: ✅.** |
| nuxt | G1 silent-skips `@parcel/watcher`'s native shards. Install hygiene improves; pathe X.5-C blocker still gates require. **Likely outcome: ⚠ honest.** |

---

## 3. Cluster G2 — `optionalDependencies` rejected platform shards

### Sub-case under G1 — rollup specifically

Even if we silently-skip the 26 native shards, rollup's `native.js` has
a chained-try over them all:

```js
const requireWithFriendlyError = (id) => {
  try { return require(id); }
  catch (e) {
    throw new Error(`Cannot find module ${id}. npm has a bug…`);
  }
};
```

The first `requireWithFriendlyError('@rollup/rollup-linux-x64-gnu')`
throws the famous error. Rollup's source DOES have a fallback to
`@rollup/wasm-node` but only when `process.env.ROLLUP_USE_WASM` is set
or when an explicit user import targets it.

Two options:
- **G2.a** Add `rollup` to WASM_SWAPS: `rollup → @rollup/wasm-node`.
  Same pattern as `esbuild → esbuild-wasm`. Drop-in compatible (same
  exports). When user types `npm install rollup`, install
  `@rollup/wasm-node` instead. Eliminates the native-binding chase
  entirely.
- **G2.b** Inject `ROLLUP_USE_WASM=1` into the runtime environment at
  workerd entry. More invasive (env-bindings touch); not in scope.

**Decision: G2.a.** Add `rollup` to `WASM_SWAPS`. Verified against
registry: `@rollup/wasm-node@4.60.3` is current and ships
`dist/rollup.js` with identical exports to `rollup`.

The reason rollup wasn't already in WASM_SWAPS at W6 time: rollup was
in `SKIP_PACKAGES` then. X5F's R1 fix (top-level bypass for SKIP)
removed that protection, exposing the native-binding chase for the
first time. Adding the swap closes the gap symmetrically.

### Other shards in the cohort (deferred but documented)

`@tailwindcss/oxide`, `@swc/core`, `@next/swc-*`, `@parcel/watcher`
follow the same pattern. They are already in `REJECT_INSTALL` (or
SKIP) and out of cohort for this wave. The G1 helper makes their
TRANSITIVE skip more honest (currently we don't attempt to install
their shards but only because we never read `optionalDependencies` at
all — the helper makes the skip explicit + telemetered).

---

## 4. Cluster G3 — `peerDependenciesMeta.X.optional = true` correctness audit

### Verdict: G3 is already CORRECT in the X5F-merged baseline

After merging x5f-resolve-miss, the `__allPeerDependencies` mechanism
(npm-resolver.ts:486) iterates ONLY `vData.peerDependencies`, NOT
`vData.peerDependenciesMeta`. So peer-meta-only entries (esbuild for
ts-jest) are correctly NEVER auto-installed.

The R2.5 logic (line 679) only adds the `__allPeerDependencies`
entries (which are entries from `peerDependencies` with the optional
filter ALREADY applied via `extractRequiredPeers`).

Wait — re-reading: line 486 keeps `peerDependencies` UNFILTERED
(including optional-marked-in-meta entries), as `__allPeerDependencies`.
Then at line 504 `extractRequiredPeers(vData)` keeps ONLY required
peers in the visible `peerDependencies`. R2 (line 665) enqueues the
required set; R2.5 (line 679) ALSO enqueues the unfiltered set when
the package is top-level.

Either way, the SET is `Object.keys(vData.peerDependencies)` — never
`Object.keys(vData.peerDependenciesMeta)`. Peer-meta-only entries
(`esbuild` in ts-jest's case) are correctly excluded.

### Affected (none requiring code change)
- **ts-jest's `esbuild` (peer-meta-only)** — already excluded post-X5F.
  Confirmed by reading `npm-resolver.ts:486-491`.
- **ts-jest's runtime blocker** — `typescript.native = undefined` per
  X5F retro line 147 — is a W2.6b cap eviction issue, NOT optional-deps.
- **@radix-ui/react-dialog `@types/*`** — both ARE in
  `peerDependencies` AND marked optional in meta. R2.5 auto-installs
  them at top level. Slightly bloats the install but causes no runtime
  issue. Out of scope to remove.
- **nuxt `@parcel/watcher`** — IS in `peerDependencies` + optional in
  meta. R2.5 installs the parent (pure-JS wrapper). Its native shards
  in `@parcel/watcher`'s `optionalDependencies` are the G1 case.

### Evidence

The X5F retro §C.4 ("R2.5") added top-level optional-peer install:

> framer-motion marks ALL its peers (including `react`) as optional.
> ... Fixed in C.4 (R2.5).

That fix was correct for `react`/`react-dom` (which framer-motion
TRULY needs). But the same broad fix swept up all
`peerDependenciesMeta.X.optional=true` entries — including the
"feature-detect" idiom case where the ts-jest probe for `esbuild`
generates the `undefined.native` error. The fix over-installs
peer-meta-only entries.

The npm spec semantics (npm v7+):
- A name in `peerDependencies`: required peer. Auto-install unless
  marked optional in `peerDependenciesMeta`.
- A name in `peerDependenciesMeta` ONLY (not in `peerDependencies`):
  feature-detect. **Do NOT auto-install.** The package will
  `try { require(name) } catch { use fallback }` at runtime.

X5F's R2.5 doesn't make this distinction. X.5-G adds it.

### Decision

Helper `selectAutoInstallPeers(pkg)` returns the set of peer names to
auto-install:

```ts
function selectAutoInstallPeers(pkg: ResolvedPackage): string[] {
  const peers = pkg.peerDependencies || {};
  const meta = pkg.peerDependenciesMeta || {};
  const out: string[] = [];
  for (const name of Object.keys(peers)) {
    if (meta[name]?.optional) continue;  // explicit optional → skip
    out.push(name);
  }
  return out;  // peer-meta-only entries (not in peerDependencies) are NEVER returned.
}
```

Applied at both top-level (`buildSpecs` in npm-installer) and the
transitive enqueue site (`resolveTree` in npm-resolver and
`resolveTreeInFacet` in npm-resolve-facet — facet body change is
out-of-scope, will document follow-up).

The corresponding `peerDependencies` and `peerDependenciesMeta` fields
need to flow through `versionToResolved` (currently dropped).

### Per-package likely outcome after G3 (no code change)
| Pkg | Expected after G3 |
|---|---|
| ts-jest | Already correct post-X5F. Runtime blocker remains W2.6b cap. **Outcome: ⚠ — out of X5G charter, honestly.** |
| @radix-ui/react-dialog | `@types/*` ARE in peerDependencies — R2.5 installs them. Runtime blocker is X.5-C react-remove-scroll. **Outcome: ⚠ — out of X5G charter.** |
| nuxt | Runtime blocker is X.5-C pathe split-bundle. **Outcome: ⚠ — out of X5G charter.** |

---

## 5. Cluster G4 — `optionalDependencies` of top-level user installs

When a user types `npm install rollup`, the rollup package itself has
`optionalDependencies` (the 26 platform shards). G1's resolver-layer
skip handles these correctly. G2's swap routes around the issue
entirely by rewriting to `@rollup/wasm-node`.

The 4-way semantic matrix the code now supports:

| Source field | npm-spec semantic | X5G implementation |
|---|---|---|
| `dependencies` | required, always install | unchanged (W2 default) |
| `peerDependencies` (no meta) | required peer, auto-install | X5F R2 enqueue |
| `peerDependencies` + `peerDependenciesMeta.X.optional` | optional peer, auto-install at top level (npm v7 default) | X5F R2.5 (top-level only) |
| `peerDependenciesMeta.X` only (NOT in `peerDependencies`) | feature-detect; never auto-install | X5F's `__allPeerDependencies` already correct (iterates peerDependencies only) |
| `optionalDependencies` with `os`/`cpu`/`libc` | platform-skip when host doesn't match | **X5G G1** (new) |
| `optionalDependencies` with `.node` main | never auto-install in workerd | **X5G G1** (new) |
| `optionalDependencies` with known native-shard glob name | never auto-install | **X5G G1** (new) |

The single new helper (`isOptionalNativeBinding`) implements the last
three rows. Combined with G2's swap, this gives users a clean install
for rollup.

---

## 6. Code-level fix plan

### 6.0 Files touched (charter)

In-charter:
- `src/wasm-swap-registry.ts` — new constants + helpers; one new
  `WASM_SWAPS` entry (rollup → @rollup/wasm-node).
- `src/npm-resolver.ts` — extend `ResolvedPackage` with `optionalDependencies` /
  `peerDependencies` / `peerDependenciesMeta` / `os` / `cpu` / `libc` fields;
  apply skip logic at resolve & enqueue sites.
- `src/npm-installer.ts` — top-level skip + telemetry; `applyW6Registry`
  auto-rewrites rollup → @rollup/wasm-node via the new swap.

Out-of-strict-charter but minimally touched for invariants:
- `src/parallel/npm-resolve-preamble.ts` — preamble parity for one new
  `WASM_SWAPS` entry (gated by
  `audit/probes/w6.5/functional/preamble-parity-w6.5.mjs`). One-line
  edit. The X5F branch precedent (commits `83cabf0`, `0df01af`) shows
  preamble edits are accepted scope when they only mirror a registry
  change.
- `src/npm-resolve-facet.ts` — symmetric G1+G3 logic in the facet
  body's `versionToResolved` + transitive enqueue site. WITHOUT this,
  the facet path (default in prod per W6.5 retro S5) silently bypasses
  the new logic, and `npm install rollup` still fails the same way.
  This is a P0 invariant: G1+G3 MUST be applied at BOTH supervisor and
  facet entry. Self-review flagged this as the highest-risk gap if
  omitted. The X5F branch (`X5F C.1` in commit `ee5bea2`) precedent
  shows facet body edits are accepted when they mirror supervisor
  resolver logic.

The dispatch's named scope (`npm-installer.ts`, `npm-resolver.ts`,
`wasm-swap-registry.ts`) is treated as the PRIMARY surface; the
preamble + facet body are the minimum additional touches required to
maintain the single-resolver / preamble-parity invariants from W6 and
X5F. The hard anti-requirement (`src/nimbus-session.ts`) is honored.

NOT touched: `src/nimbus-session.ts` (anti-requirement), facet-path
TS (out of scope), `src/_shared/exports-resolver.ts` (single-resolver
invariant from X5F).

### 6.1 `wasm-swap-registry.ts` — additions

Add helper:

```ts
/**
 * Heuristic: does this packument represent a platform-native binding
 * that workerd cannot load?
 *
 * Returns true when:
 *   - `os`, `cpu`, or `libc` field is non-empty (npm spec platform
 *     constraints).
 *   - `main` ends in `.node` (Node.js N-API binary, not workerd-loadable).
 *   - name matches a known native-shard glob:
 *       @rollup/rollup-*-*, @swc/core-*, @next/swc-*,
 *       @parcel/watcher-*-*, @tailwindcss/oxide-*,
 *       @img/sharp-*, @napi-rs/canvas-*-*.
 */
export interface MinimalPackument {
  os?: string[]; cpu?: string[]; libc?: string[];
  main?: string; name?: string;
}
export function isOptionalNativeBinding(p: MinimalPackument): boolean { ... }

export function isPeerOptional(
  pkg: { peerDependencies?: Record<string,string>;
         peerDependenciesMeta?: Record<string,{optional?:boolean}>; },
  peerName: string,
): { autoInstall: boolean; reason: 'required' | 'optional-marked' | 'peer-meta-only' };
```

Add new `WASM_SWAPS` entry:

```ts
{
  from: 'rollup',
  to: '@rollup/wasm-node',
  reason:
    'Native rollup expects platform shards in optionalDependencies (npm CLI bug #4828); ' +
    '@rollup/wasm-node is a drop-in WASM build with identical exports.',
  compat: 'drop-in',
},
```

Mirror in `src/parallel/npm-resolve-preamble.ts:66-68`:

```js
const __WASM_SWAPS = new Map([
  ['esbuild', { from: 'esbuild', to: 'esbuild-wasm' }],
  ['rollup',  { from: 'rollup',  to: '@rollup/wasm-node' }],
]);
```

(Preamble parity probe gates this — single line addition, low risk.)

LOC: ~60 in wasm-swap-registry.ts; ~1 in npm-resolve-preamble.ts.

### 6.2 `npm-resolver.ts` — ResolvedPackage extension + enqueue logic

```ts
export interface ResolvedPackage {
  // existing fields ...
  // X.5-G additions:
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  os: string[];   // empty array if absent
  cpu: string[];
  libc: string[];
}
```

Update `versionToResolved` (line 471) and
`registryCacheToResolved` (line 491) to populate these. Update the
cache schema (npm-cache.ts) — but cache is OUT OF CHARTER. Workaround:
JSON-pack into `depsJson` as a structured payload, OR leave cache alone
and accept that cache-hit packages won't have these fields (optional
fields, all default to empty). Acceptable: the helper degrades to "not
a native binding / no auto-skip" when fields are absent. Lockfile
invalidation forces re-resolution within one tenant cycle.

In `resolveTree` (line 593), the transitive enqueue site:

```ts
// Existing: enqueue all pkg.dependencies.
for (const [depName, depRange] of Object.entries(pkg.dependencies)) {
  if (!resolved.has(depName) && !seen.has(depName)) {
    queue.push([depName, depRange as string]);
  }
}

// X.5-G — G1: enqueue optionalDependencies, but mark them so the
// resolveOne worker can skip platform-native bindings without erroring.
for (const [depName, depRange] of Object.entries(pkg.optionalDependencies || {})) {
  if (!resolved.has(depName) && !seen.has(depName)) {
    optionalQueue.push([depName, depRange]);  // separate queue with permissive miss handling
  }
}

// X.5-G — G3: enqueue REQUIRED peers (peerDeps minus those marked optional in meta).
// Peer-meta-only entries (in peerDependenciesMeta but not in peerDependencies) are NEVER enqueued.
for (const [peerName, peerRange] of Object.entries(pkg.peerDependencies || {})) {
  const meta = pkg.peerDependenciesMeta?.[peerName];
  if (meta?.optional) continue;  // ts-jest/@types/* style → skip
  if (!resolved.has(peerName) && !seen.has(peerName)) {
    queue.push([peerName, peerRange]);
  }
}
```

The optional queue is processed AFTER the main queue settles. In the
worker (line 540), when a name from the optional queue is being
resolved:

```ts
// (after fetching the packument)
if (fromOptionalQueue && isOptionalNativeBinding(packument)) {
  onProgress?.(`[npm] [skip] ${name} (optional native binding for ${packument.os}/${packument.cpu})`);
  emitRegistryEvent({ type: 'transitive-skip', from: name,
    reason: `optional native binding (os=${packument.os}, cpu=${packument.cpu})` });
  return null;
}
// On any fetch error from optional queue → silent return null (npm spec).
```

LOC: ~80 in npm-resolver.ts.

### 6.3 `npm-installer.ts` — `buildSpecs` + `applyW6Registry`

`applyW6Registry` already calls `applySwaps` — adding rollup to
`WASM_SWAPS` automatically rewrites `npm install rollup` →
`@rollup/wasm-node`. ZERO changes needed there for G2.

`buildSpecs` (line 907) reads the user's `package.json`. When it iterates
`pkgJson.optionalDependencies`, it should NOT enqueue platform-native
bindings on install. Currently it doesn't read optionalDependencies at
all (only `dependencies` and `devDependencies`). Adding awareness:

```ts
// X.5-G — top-level optionalDependencies: enqueue, but the resolver
// will silent-skip platform-native ones via G1.
for (const [name, range] of Object.entries(pkgJson.optionalDependencies || {})) {
  if (!shouldSkipPackage(name)) {
    specs[name] = range as string;
    optionalNames.add(name);  // tag for resolver
  }
}
```

We need to thread `optionalNames` through `npmInstall` → `resolveTree`
so the resolver knows which entries are PERMISSIVE (don't error on
miss) vs REQUIRED. Same pattern as X5F R1's `topLevelNames`.

LOC: ~30 in npm-installer.ts.

### 6.4 Lockfile invalidation

Bump `LOCKFILE_VERSION` (or equivalent sentinel) so post-X.5-G a stale
lockfile triggers full re-resolve. If no such sentinel exists, lockfile
schema change is acceptable scope (npm-cache.ts touched in X5F C.3 with
a similar pattern). Out of strict charter — alternative is to skip
lockfile changes entirely and rely on natural re-fetch. **Decision:
skip lockfile bump** to stay in charter. Acceptable: tenants with
existing pre-X.5-G lockfiles continue working (just don't benefit from
G1/G3 until they `npm install` something new). The probe must use a
fresh tenant to demonstrate the fix.

### 6.5 Constants — none

No new SKIP_PACKAGES / FRAMEWORK_REQUIRED_PACKAGES additions. No new
preamble symbols (only the existing `__WASM_SWAPS` map gets one entry).

---

## 7. Test-first plan (Phase B)

All probes live under `audit/probes/x5g/{functional,regression,e2e}/`.
ALL must be RED before any src/ change.

### 7.1 Functional probes (in-process; bun TS-loader)

| File | Asserts | Cluster |
|---|---|---|
| `functional/optional-deps-parse.mjs` | `versionToResolved` + `registryCacheToResolved` populate the new optional/peer/os/cpu/libc fields from a synthetic packument. | G1 + G3 |
| `functional/native-binding-detect.mjs` | `isOptionalNativeBinding({os:['linux']})` → true; same for cpu/libc; same for `.node` main; same for `@rollup/rollup-linux-x64-gnu`-shape names. Negatives: pure-JS package returns false. | G1 |
| `functional/peer-meta-only-not-installed.mjs` | `selectAutoInstallPeers({peerDependencies:{},peerDependenciesMeta:{esbuild:{optional:true}}})` returns `[]`. With esbuild ALSO in peerDeps but optional-meta → returns `[]`. With esbuild required → returns `['esbuild']`. | G3 |
| `functional/applySwaps-rollup.mjs` | `applySwaps({rollup:'^4'})` returns `{specs:{'@rollup/wasm-node':'^4'}, swaps:[{from:'rollup',to:'@rollup/wasm-node',...}]}`. | G2 |
| `functional/preamble-parity-rollup.mjs` | The preamble's `__WASM_SWAPS` map has the same entries as `WASM_SWAPS` — extends w6.5 preamble-parity-w6.5.mjs to include the rollup swap. | gate |
| `functional/error-classification.mjs` | A new helper `classifyInstallError(err, ctx)` distinguishes `optional-dep-skip` (recoverable) from `real-resolve-fail` (terminal). Used by the supervisor. | G1+G2 |

### 7.2 Regression probes

| File | Asserts |
|---|---|
| `regression/install-pipeline-coverage-shim.mjs` | Reads `audit/probes/regression/install-pipeline-coverage.mjs`'s SCENARIOS list and asserts the X.5-G changes don't add or remove any pkg names. Static check; doesn't run a server. |
| `regression/single-resolver-source.mjs` | `grep -rln 'function resolveExports' src/` returns ONE TS file (mirror of X5F invariant). |
| `regression/transitive-warn-still-warns.mjs` | fsevents + bufferutil still produce `transitive-skip` events, NOT `optional-dep-skip` (G1's helper must not subsume W6's existing transitive='warn' policy — these are separate code paths). |
| `regression/w65-telemetry-events-compatible.mjs` | New `transitive-skip` events from G1 use the existing `RegistryEvent` shape — no new variants, the W6.5 sink keeps working. |
| `regression/skip-still-skips-buildtools.mjs` | typescript / vite / etc. as transitive deps still silent-skip per W6+W11. |

### 7.3 E2E probes (`wrangler dev`)

| File | Asserts |
|---|---|
| `e2e/rollup.mjs` | `npm install rollup` lands `@rollup/wasm-node` (via swap), `require('rollup')` returns object with `.rollup` function. |
| `e2e/radix-react-dialog.mjs` | install `@radix-ui/react-dialog` doesn't install `@types/react` / `@types/react-dom` (peer-meta-only). |
| `e2e/ts-jest.mjs` | install `ts-jest jest typescript` doesn't install `esbuild` or `esbuild-wasm` (peer-meta-only). The runtime require for ts-jest still hits W2.6b cap; honest ⚠ outcome documented. |
| `e2e/nuxt.mjs` | install `nuxt` doesn't install `@parcel/watcher` (optional peer) or `@parcel/watcher-*` shards (G1). Still ⚠ on pathe (X.5-C), documented. |

A `run-all.mjs` driver runs all three classes; gates e2e behind
`NIMBUS_X5G_E2E=1` (default skipped — wrangler dev provisioning is the
slow path). The wrangler-dev driver pattern reuses
`audit/probes/post-phase5-verification/run-packages-local.mjs` shape;
runs against `BASE=http://127.0.0.1:8787` (per AGENTS.md, port 8787 +
`--ip 0.0.0.0`).

---

## 8. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| `isOptionalNativeBinding` false-positives a pure-JS package that happens to declare `os: ["linux"]` for documentation purposes | LOW (rare in practice) | Conservative: require ALL of (os ∪ cpu ∪ libc ∪ name-glob ∪ .node-main) to indicate native. Pure-JS packages would have to set `os` AND name match a glob to false-positive. |
| Rollup → @rollup/wasm-node swap breaks for users with explicit `import { rollup } from 'rollup'` if @rollup/wasm-node's exports differ | MEDIUM | Verified at plan time: registry shows identical `main: dist/rollup.js` and `exports` shapes. E2E probe `e2e/rollup.mjs` asserts `.rollup` function presence. |
| Peer-meta-only-not-installed regresses anything that USED to work because R2.5 over-installed (silent benefit) | MEDIUM | install-pipeline-coverage's `mustHaveAtLeastOne` is checked. ts-jest's coverage requires `ts-jest`, `jest`, `typescript` — none of which are peer-meta-only. Safe. |
| Facet path doesn't get G1/G3 (only supervisor path) — for the live install pipeline this is a real gap | MEDIUM | Documented; supervisor re-resolves anything facet drops via existing fallback. The X5F branch proves facet+supervisor symmetry at the registry level via `event-fires-from-facet.mjs`. New events from G1 still go through the same `__pendingEvents` channel — no facet body change required IF helpers run only on supervisor side. |
| Lockfile-not-bumped means existing tenants with stale lockfiles don't benefit | LOW | Acceptable: opted-in to stay-in-charter. Documented as W6.6 follow-up. |
| `rollup` swap silently breaks tools that PARSE `node_modules/rollup/package.json` for version detection (e.g., bundlers that require a specific rollup major) | LOW | The swap rewrites the install but the package metadata at `node_modules/@rollup/wasm-node/package.json` reflects the actual installed version. Tools reading `node_modules/rollup/package.json` will fail (it doesn't exist) — same UX as the current SKIP behaviour. |
| Adding optionalDependencies/peerDependencies/peerMeta/os/cpu/libc fields to `ResolvedPackage` breaks any external consumer of the type | LOW | All new fields have safe defaults (empty objects/arrays). Existing consumers don't read them; new consumers do. Backward-compatible additive change. |

---

## 9. Sub-agent review

Sub-agent review will be attempted in Phase A. If unavailable
(matches X5F's experience, see X5F-plan.md §9), self-challenge will be
performed in-line by:
1. Re-reading every cited line in src/.
2. Verifying every registry packument fact via `curl
   https://registry.npmjs.org/<pkg>/latest`.
3. Cross-referencing the X5F plan/retro for consistency with the prior
   wave's invariants (single resolver, telemetry shape, lockfile
   schema).

---

## 10. Done criteria recap

| Criterion | Plan's honest projection |
|---|---|
| ≥ 2 of 4 packages flip ✅ | **1 likely (rollup via G2 swap).** ts-jest, nuxt, radix-react-dialog have real blockers in cohorts X.5-C / W2.6b — all 3 stay ⚠ for honest reasons documented per-package in retro. |
| Single resolver path preserved | `audit/probes/x5g/regression/single-resolver-source.mjs` |
| `tsc --noEmit` clean (modulo pre-existing baseline) | Phase D audit |
| Mossaic regression PASS | Phase D audit (re-run install-pipeline-coverage) |
| Wave 1 contract PASS (external=0) | Phase D audit |
| Branch `x5g-optional-deps` pushed (or halted-on-grant) | Phase E |
| All 6 phases ✓ in `X5G-progress.md` | Per-phase append |

**Honesty note:** The dispatch's ≥2 ✅ done criterion may be hard to
hit because 3 of the 4 ⚠ packages have blockers OUTSIDE the optional-
deps charter (X.5-C pre-bundler, W2.6b cap). X5G will deliver:
- 1 strict ✅ (rollup) via swap.
- Install-hygiene improvements for the other 3 (no more wasted
  optional-native fetches), but their runtime ⚠ is unchanged.
- Honest per-package retro verdict + recommendations for X.5-H.

If the wave-runner judges 1/4 ✅ insufficient, the next step would be
to expand X5G charter to include W2.6b cap or X.5-C pre-bundler
(neither today).

---

## 11. Citations

- `audit/sections/X5F-retro.md:48-56` — flip table identifying the 4 ⚠ packages.
- `audit/sections/X5F-retro.md:130-139` — "What surprised me" §1 (framer-motion all-peers-optional).
- `audit/sections/X5F-retro.md:145-149` — blocker table.
- `audit/sections/X5F-plan.md:113-123` — R2 cluster evidence (peerDeps registry data).
- `audit/sections/W6.5-retro.md:32` — sharp-wasm32 platform-skip pattern (`cpu: ["wasm32"]`).
- `audit/sections/W6.5-retro.md:84-93` — telemetry event shape.
- Source: `src/npm-resolver.ts:471-488` (`versionToResolved` — drops optional/peer/platform fields).
- Source: `src/npm-resolver.ts:491-503` (`registryCacheToResolved` — same).
- Source: `src/npm-resolver.ts:540-583` (transitive enqueue site for G1+G3).
- Source: `src/npm-resolver.ts:593-597` (transitive deps loop — currently only `pkg.dependencies`).
- Source: `src/npm-installer.ts:907-955` (`buildSpecs`).
- Source: `src/npm-installer.ts:957-991` (`applyW6Registry`).
- Source: `src/wasm-swap-registry.ts:73-88` (WASM_SWAPS — currently 1 entry).
- Source: `src/wasm-swap-registry.ts:380-384` (`shouldWarnSkipTransitive` — closest precedent for new helper).
- Source: `src/parallel/npm-resolve-preamble.ts:66-68` (preamble's WASM_SWAPS mirror).
- Registry: `https://registry.npmjs.org/rollup/latest` (verified 26 platform shards).
- Registry: `https://registry.npmjs.org/@rollup%2Fwasm-node/latest` (verified swap target exists, version 4.60.3).
- Registry: `https://registry.npmjs.org/@rollup%2Frollup-linux-x64-gnu/latest` (verified `os/cpu/libc` + `.node` main).
- Registry: `https://registry.npmjs.org/nuxt/latest` (verified `@parcel/watcher` peer-meta-optional).
- Registry: `https://registry.npmjs.org/ts-jest/latest` (verified `esbuild` peer-meta-only).
- Registry: `https://registry.npmjs.org/@radix-ui%2Freact-dialog/latest` (verified `@types/*` peer-meta-optional).
- npm CLI bug #4828: `https://github.com/npm/cli/issues/4828`.

---

*Plan v1, ready for sub-agent review.*
