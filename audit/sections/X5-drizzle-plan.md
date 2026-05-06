# X.5-drizzle — Plan

> **Branch:** `x5-drizzle` (off `origin/main` @ `9d4b61d`)
> **Mission:** Recover `drizzle-orm` from the strict regression caught by
> VERIFY-9D4B61D §6 (✅ at `23417c5` → ⛔ at `9d4b61d`) without regressing
> any of W11's 5 frameworks.
> **Predicted delta:** +1 strict ✅; cohort 15/33 → 16/33; healthy unchanged.

## TL;DR

The `[npm] Framework detected — installing framework-required packages
(vite, …)` install banner fires whenever `detectFramework({ pkg, files })`
on the project's `package.json` returns ANY non-unknown framework — including
the **generic-vite** verdict from step 8 of `framework-detect.ts`. The
seeded starter (`src/seed-project.ts:44-67`) declares `vite ^5.4.0` in
`devDependencies`, so every `npm install <pkg>` from the starter inherits
`frameworkAware=true` regardless of `<pkg>`. Pre-X.5-26b this was a
cosmetic banner; post-X.5-26b's `lightningcss` REJECT_INSTALL with
`transitive: 'fail'`, the speculative vite pull-in (whose transitive deps
include `lightningcss`) is loud-rejected → drizzle-orm (and any pkg in
the cohort that doesn't explicitly need vite) regresses to ⛔.

**Refinement (Option 1, recommended):** narrow the install-time
`detectFrameworkAware()` decision in `src/npm-installer.ts:875` to treat
generic-vite as **NOT** framework-aware. Real frameworks
(next/astro/nuxt/remix/sveltekit/wrangler) keep frameworkAware=true so
their dev binaries can `import 'vite'` from node_modules. Generic vite +
React projects (the starter, Mossaic, etc.) get frameworkAware=false,
which restores 23417c5-era transitive-skip semantics for vite — and
therefore for vite's lightningcss subtree.

## 1. Investigation summary (Phase A)

| Probe | Verdict |
|---|---|
| `01-detect-on-starter.mjs` | starter `package.json` triggers `framework='vite', confidence=0.7, devCommand='vite-real'` (step 8) — current `detectFrameworkAware()` returns true. |
| `02-detect-on-frameworks.mjs` | 9/9 PASS under proposed post-fix semantic `frameworkAware = (framework !== 'unknown' && framework !== 'vite')`; W11 frameworks + wrangler-on-framework + wrangler-standalone all keep `frameworkAware=true`; only generic-vite + unknown flip to false. |
| `03-call-site-survey.mjs` | `frameworkAware` is COMPUTED in exactly **one** site: `npm-installer.ts:detectFrameworkAware`. All other refs in `npm-resolver.ts`, `npm-resolve-facet.ts`, `parallel/npm-resolve-preamble.ts` are pass-through consumers. Single edit point. |

**What makes drizzle-orm match (the package.json shape that triggers
the cascade):** *not* drizzle-orm itself — the detector runs against
the **project's** `package.json`, never against the package being
installed. Any `npm install <X>` invoked from a directory whose
`package.json` has `vite` (without a real framework) inherits the
trigger. drizzle-orm's role is incidental: it's the alphabetically-first
33-pkg cohort entry whose strict-✅ at 23417c5 was load-bearing on the
fact that lightningcss's optional native bindings silent-skipped (vs.
the parent `lightningcss` js package being install-rejectable).

**Most surgical refinement:** modify a single boolean condition in
`detectFrameworkAware()`. No type changes; no signature changes; no
consumer changes. ~1 added clause + a 4-line comment update.

## 2. Refinement options

### Option 1 — Narrow `detectFrameworkAware()` to exclude generic-vite (RECOMMENDED)

**File:line:** `src/npm-installer.ts:898` (inside the body of
`detectFrameworkAware`, the `return result.framework !== 'unknown';` line).

**Diff shape:**

```ts
// BEFORE
return result.framework !== 'unknown';

// AFTER
// X.5-drizzle: exclude generic-vite (step 8 of framework-detect). The
// starter app + Mossaic-shaped projects (vite + React, no framework)
// don't have a framework CLI that needs to import 'vite' from
// node_modules — real-vite is bundled in the supervisor (cirrus-real).
// Without this guard, the X.5-26b lightningcss `transitive: 'fail'`
// REJECT cascades through every `npm install <pkg>` from the starter.
return result.framework !== 'unknown' && result.framework !== 'vite';
```

**Why this is most surgical:**
1. Single condition change in a single file.
2. The `detectFramework()` pure function is unchanged — W11
   `detect-vite-generic.mjs` keeps passing (still returns `'vite'` /
   `'vite-real'`).
3. All `frameworkAware` consumers are pass-through — no signature
   ripple.
4. Behavior preserved for W11's 5 real frameworks + wrangler.
5. Behavior preserved for wrangler-standalone (W10).

**Regression risk: None for W11.** The W11 retro §4 #8 explicitly
documents the *intent*: "Mossaic regression on prod. ... W11 changes to
install path are gated by `frameworkAware` flag which is **`false` for
Mossaic** (it's a plain Vite + React project, not a detected framework)."
The current code makes this statement false (Mossaic IS detected, as
generic-vite). Option 1 makes the retro statement true.

### Option 2 — Whitelist explicitPackages (rejected)

**Idea:** in `npm-installer.ts:_installInner`, only set frameworkAware
when `opts?.packages` is empty (i.e., bare `npm install` against
package.json) OR contains a framework name.

**Why rejected:**
- Misses the case where the user adds a runtime dep to a real framework
  project (`npm install lodash` in a Next.js project) — would lose the
  framework-required vite materialization.
- Larger code change (needs to know which package names are frameworks,
  duplicating detector state).
- Doesn't address Mossaic-shape `npm install` (no args; reads
  package.json) which would still hit the cascade.

### Option 3 — Raise confidence threshold to 0.8 (rejected)

**Idea:** treat `result.confidence < 0.8` as `frameworkAware=false`.

**Why rejected:**
- Tightly coupled to magic numbers in the detector. Step 4 (Remix
  v2 fallback when contents not inspected) is 0.7, step 8 (generic
  vite) is also 0.7 — would also flip Remix-without-fileContents to
  not-framework-aware, regressing W11.
- Confidence numbers are documentation/UX artifacts, not behavioral
  contracts. Hooking semantics on them creates fragile coupling.

### Option 4 — Exclude packages without framework-config files (rejected)

**Idea:** require `next.config.*`/`astro.config.*`/etc. to be present
before treating the project as framework-aware.

**Why rejected:**
- The detector already does config-file gating where it matters
  (Wrangler-on-framework rule 0 reads `wrangler.{toml,jsonc,json}`;
  Remix rule 4 reads `vite.config.*`). The W11 author considered and
  rejected stricter config-file gating for the per-framework deps
  because deps are sufficient + faster. Re-litigating is out of scope.
- Doesn't fundamentally narrow generic-vite (which hits step 8 BY
  having vite in deps with no `vite.config.*` requirement).

## 3. Regression matrix — does each W11 framework still get frameworkAware=true?

Verified by `02-detect-on-frameworks.mjs` (Phase A):

| Project shape | `detectFramework()` returns | Pre-fix aware | Post-fix aware | Required by W11? |
|---|---|---|---|---|
| Next.js (`next` in deps) | `next` (conf 0.95) | true | true | ✓ (next-cli, but Next is loud-blocked Phase 1; aware harmless) |
| Astro (`astro` in deps) | `astro` (conf 0.95) | true | true | **✓ load-bearing** — astro CLI imports vite from node_modules |
| Nuxt (`nuxt` in deps) | `nuxt` (conf 0.95) | true | true | **✓ load-bearing** — nuxi CLI imports vite |
| Remix v2 (`@remix-run/dev` + vite.config has it) | `remix` (conf 0.95) | true | true | **✓ load-bearing** — remix vite:dev imports vite |
| SvelteKit (`@sveltejs/kit`) | `sveltekit` (conf 0.95) | true | true | **✓ load-bearing** — vite dev imports user vite |
| Wrangler-on-framework (e.g., SK + wrangler.jsonc) | `<underlying-fw>` via rule 0 (conf 0.85) | true | true | ✓ — routes through W10 wrangler-dev path |
| Wrangler standalone (just `wrangler.jsonc` or `wrangler` dep) | `wrangler` (conf 0.85) | true | true | ✓ (W10 territory, harmless to keep aware) |
| **Generic vite (starter / Mossaic)** | `vite` (conf 0.7) | true | **false** ← FIX | **No** — real-vite is bundled |
| Pure node lib (no fw, no vite) | `unknown` (conf 0.1-0.3) | false | false | n/a |

**Net W11 risk: 0.** Every W11 functional probe + the load-bearing
vite-import path is preserved.

**Mossaic risk: 0.** Mossaic was passing on `27/33 healthy` at
`23417c5` (per VERIFY-9D4B61D §3). The fix flips Mossaic-shape projects
from `aware=true` (current, which the W11 retro retroactively claimed
was false) back to `false` — restoring 23417c5-era behavior.

## 4. Probe plan (Phase C — TDD red BEFORE Phase D)

### Functional (data-only, no live wrangler)

`audit/probes/x5-drizzle/functional/`:

1. **`detect-aware-on-starter.mjs`** — RED pre-fix, GREEN post-fix.
   Imports `framework-detect.ts` and a *mock* `detectFrameworkAware`
   helper that mirrors the current src logic, asserts that the starter
   pkg.json triggers `aware=false` (the post-fix semantic). Drives the
   src change.
2. **`detect-aware-preserves-frameworks.mjs`** — green at all times.
   Same 9 fixtures as `02-detect-on-frameworks` but as a pass/fail
   probe; locks in the W11 invariants.
3. **`installer-detect-source-shape.mjs`** — verifies
   `npm-installer.ts:detectFrameworkAware` source contains the
   `&& result.framework !== 'vite'` clause. Plain-text source assertion;
   RED pre-fix, GREEN post-fix.

### Regression (cross-wave guards — must stay GREEN through src change)

`audit/probes/x5-drizzle/regression/`:

1. **`single-resolver-source.mjs`** — delegates to
   `audit/probes/x5f/regression/single-resolver-source.mjs` (8-wave
   compose-without-fork ledger).
2. **`install-pipeline-coverage-shim.mjs`** — delegates to
   `audit/probes/regression/install-pipeline-coverage.mjs` shape probe
   (canonical scenario list unchanged).
3. **`w11-frameworks-still-detect.mjs`** — runs each of W11's 5
   `detect-*.mjs` functional probes; PASSES iff all 5 still return
   their respective framework IDs. Direct W11 anti-regression guard.
4. **`w11-vite-generic-still-detects-as-vite.mjs`** — locks in that
   `detect-vite-generic.mjs` keeps returning `framework='vite'` and
   `devCommand='vite-real'` (the *detector* is unchanged; only the
   *aware-flag* derived from it narrows).
5. **`mossaic-regression-coverage.mjs`** — invariant: Mossaic-shape
   project (vite + React) gets `aware=false` post-fix. (Direct codification
   of W11 retro §4 #8's intent.)
6. **`prior-x5-runalls-shim.mjs`** — runs each of the 13 prior X.5
   `run-all.mjs` files (without live wrangler) and asserts each exits 0
   (or, if it requires BASE, asserts the data-only subset exits 0).

### E2E

`audit/probes/x5-drizzle/e2e/`:

1. **`drizzle-orm-installs.mjs`** — drives a live wrangler and runs
   `cd app && npm install drizzle-orm`, asserts exit-code 0 + the
   "added N packages" line. RED pre-fix (REJECT), GREEN post-fix.
2. **`drizzle-orm-smoke.mjs`** — after install, runs `node -e
   "require('drizzle-orm')..."` and asserts the keys array. RED pre-fix
   (Cannot find module), GREEN post-fix.
3. **`drizzle-orm-no-vite-pulled.mjs`** — confirms post-install that
   `node_modules/vite` does NOT exist (frameworkAware=false correctly
   skipped vite). Locks in the *mechanism*, not just the outcome —
   prevents a future "fix" that re-enables the cascade by another path.

## 5. Source change preview (Phase D — single commit)

`src/npm-installer.ts` only. ~6 LOC delta (1 condition + 5 comment).

```diff
       const result = detectFramework({
         pkg: { dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, scripts: pkg.scripts },
         files,
         fileContents,
       });
-      return result.framework !== 'unknown';
+      // X.5-drizzle: generic-vite (step 8 of framework-detect) is NOT
+      // a framework-aware install. The starter + Mossaic-shape projects
+      // (vite + React, no framework CLI) don't need user-installed vite
+      // materialized — real-vite is bundled in the supervisor
+      // (cirrus-real). Treating them as aware=true triggers the
+      // X.5-26b lightningcss REJECT cascade in any `npm install <pkg>`
+      // from such a project (drizzle-orm regression in VERIFY-9D4B61D §6).
+      // Real frameworks (next/astro/nuxt/remix/sveltekit/wrangler) are
+      // unaffected — their detector verdicts stay framework-aware.
+      return result.framework !== 'unknown' && result.framework !== 'vite';
     } catch {
       return false;
     }
```

No other src/ files. No type changes. No additional imports.

## 6. Self-review TL;DR

- **Trigger fully localized to one return-statement in
  `detectFrameworkAware`.** Other waves' resolver gates intact.
- **Detector pure function untouched** — W11 `detect-vite-generic.mjs`
  still returns `'vite'`/`'vite-real'`. Only the *install-time
  aware-flag* derived from it narrows.
- **W11 frameworks unaffected** — all 5 keep aware=true (Phase A
  fixture sweep).
- **No new types, no new exports, no new files in src/.** Single
  conditional refinement. ~6 LOC including comment.
- **Anti-regression coverage in regression/** — locks in not just
  drizzle-orm-installs but also W11 detector probes + 13 prior X.5
  run-alls.
- **No coupling to X.5-T (`node-shims.ts`) or X.5-26b
  (`wasm-swap-registry.ts` / `parallel/npm-resolve-preamble.ts`)**.
  Different file, different mechanism. Parallel-merge safe.
- **Predicted measurable delta:** drizzle-orm `⛔ → ✅` in next 33-pkg
  verify (post-deploy). Cohort 15/33 → 16/33 strict. Healthy stays
  31/33.

---

## Phase D pivot — actual mechanism diverges from plan §1-§5

**Phase D first attempt** (commit reverted before push) implemented the
plan §5 framework-detect refinement. The probe `drizzle-orm-installs.mjs`
remained RED. Trace probe `audit/probes/x5-drizzle/investigation/04-trace-lightningcss-from-drizzle.mjs`
empirically established the actual chain:

```
drizzle-orm
 └ expo-sqlite (optional peer; X.5-J R2.5 enqueues at top-level)
     └ expo (peer of expo-sqlite; enqueued via the post-resolve walk)
         └ @expo/metro-config (regular dep)
             └ lightningcss (regular dep) ← X.5-26b transitive='fail' THROWS
```

Key finding: lightningcss does NOT enter the resolution tree via the
framework-detected vite pull-in (as VERIFY-9D4B61D §3 hypothesized). It
enters via `expo-sqlite`'s peer-of-peer chain. The framework-detect
refinement is therefore a no-op for drizzle-orm — it is independently
correct hygiene (matches W11-retro §4 #8 stated intent for Mossaic) but
does not address this regression.

### Refined refinement (Phase D landed)

**Files:** `src/npm-resolver.ts` + `src/npm-resolve-facet.ts` (mirror —
same X.5-J path duplicated for in-supervisor + in-facet resolvers).

**Mechanism:** introduce `bestEffortNames: Set<string>`. Mark
X.5-J optional-peer enqueues as best-effort. Propagate the flag through
the post-resolve children-enqueue (deps + optionalDependencies + peers).
In the `__w6_reject` catch path, check `bestEffortNames.has(name)`; if
true, silent-skip the offending package + emit a `transitive-skip`
event, instead of throwing.

**Net behavior:**
- The user typed `npm install drizzle-orm` (or any pkg) — required
  trees are unaffected; rejects in required trees still loud-fail.
- X.5-J's --include=peer convenience pulls in optional peers and their
  subtrees as best-effort. If a deep transitive in such a subtree hits
  REJECT_INSTALL, the offending package + descendants drop out, and the
  parent install proceeds.

**Diff size:** +46 LOC in `npm-resolve-facet.ts` (Set declaration +
inheritBestEffort propagation + catch-branch + X.5-J tag) + +41 LOC in
`npm-resolver.ts` (mirror). 0 new files; 0 type changes; 0 new exports.

### Frame-detect is reverted in this commit

The Phase B plan's framework-detect refinement was reverted. The
hygiene case it addresses (W11-retro §4 #8) is real but independent of
the drizzle-orm regression. Tracked as a candidate for a future hygiene
bucket; not load-bearing for the X.5-drizzle done condition.

### W11 invariants preserved

- `framework-detect.ts` is unchanged; W11's 12 detect probes remain GREEN.
- `frameworkAware` flag is unchanged; W11's frameworks (next/astro/nuxt/
  remix/sveltekit) still get `aware=true` and vite still materializes
  for them (load-bearing for their CLIs).
- `bestEffortNames` is a NEW orthogonal axis on top of existing
  `topLevelNames` / `optionalNames`. No existing semantics narrowed.
