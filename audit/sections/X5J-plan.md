# X.5-J Plan — R2.5 ↔ REJECT_INSTALL reconciliation (P0 REGRESSION FIX)

> Status: Plan-mode 2026-05-05. Worktree `x5j-r25-reject` off `main`
> HEAD `eb316dc`. The verification document
> `audit/sections/VERIFY-EB316DC.md` (local from branch
> `verify-eb316dc`) is the parent — its §6 #1 + §8 identify two
> regressions with a single shared root cause.
>
> **Done criteria from dispatch:**
> 1. `drizzle-orm` and `ts-node` both ✅ post-fix (returning to baseline).
> 2. Fix confined to `src/npm-resolve-facet.ts` + `src/npm-resolver.ts`
>    (no edits to `src/require-resolver.ts` — X.5-L territory; no edits
>    to `src/node-shims.ts` — X.5-M territory).
> 3. All `audit/probes/x5j/` probes green; `tsc --noEmit` clean
>    baseline preserved (2 pre-existing errors); Mossaic regression
>    unchanged; **REQUIRED-peer-in-REJECT_INSTALL still hard-fails**
>    (we do not weaken the loud-reject contract).
> 4. Single-resolver invariant preserved: supervisor and facet paths
>    keep parity (the carve-out is implemented in BOTH).

---

## 1. The two regressed packages

### 1.1 drizzle-orm

**Baseline (f4357a04):** ✅ `keys: [...]` from `require('drizzle-orm')`.
**eb316dc:** ⛔ `npm install rejected: sql.js — Installs but fails at runtime: ENOENT on dist/sql-wasm.wasm — loader gap (W6.5.x).`

Probe artifact (`verify-eb316dc:audit/probes/verify-eb316dc/packages-local/drizzle-orm.out.txt:27-28`):

```
[npm]   resolver-facet failed: npm install rejected: sql.js — Installs but fails at runtime: ENOENT on dist/sql-wasm.wasm — loader gap (W6.5.x).
npm install failed: resolver-facet failed: npm install rejected: sql.js — Installs but fails at runtime: ENOENT on dist/sql-wasm.wasm — loader gap (W6.5.x).
```

**Why drizzle-orm hits this:** drizzle-orm declares `sql.js` in
`peerDependencies` with `peerDependenciesMeta.sql.js.optional = true`
(it's one of ~10 driver-flavour optional peers — d1, libsql, mysql,
postgres, sqlite, etc., the user picks one). The user's typical
`npm install drizzle-orm` does NOT need sql.js — they pick a different
driver. But X.5-F R2.5 (in npm CLI's `--include=peer` default spirit)
auto-installs ALL peer-deps including the optional ones, and `sql.js`
is in W6's `REJECT_INSTALL` with `transitive='fail'` (W6.5.x loader
gap, see `audit/probes/w6.5/spike/sql-js.verdict.md`).

The reject inside the BFS walker throws `RegistryRejectError` →
propagates through `Promise.all` → `resolveTree` rejects → install
aborts at the resolver phase, before any tarball lands. drizzle-orm's
own tarball is never even fetched.

### 1.2 ts-node

**Baseline (f4357a04):** ✅ `typeof: object`.
**eb316dc:** ⛔ `npm install rejected: @swc/core — Native Rust SWC.`

Probe artifact (`verify-eb316dc:audit/probes/verify-eb316dc/packages-local/ts-node.out.txt:27-28`):

```
[npm]   resolver-facet failed: npm install rejected: @swc/core — Native Rust SWC.
npm install failed: resolver-facet failed: npm install rejected: @swc/core — Native Rust SWC.
```

**Why ts-node hits this:** ts-node declares `@swc/core` in
`peerDependencies` with `peerDependenciesMeta['@swc/core'].optional = true`
(it's the optional peer for `--swc` mode). Default ts-node mode uses
the bundled TypeScript transformer, NOT swc. But R2.5 still enqueues
`@swc/core`, which is in W6 `REJECT_INSTALL` with `transitive='fail'`
(native Rust). Same chain: reject → RegistryRejectError → install
abort.

---

## 2. Single shared root cause

**File:line evidence:**

- **Versions of the optional peers are queued via the FULL peer-deps
  set** at `src/npm-resolver.ts:498-503` (supervisor):

  ```ts
  const allPeers = vData.peerDependencies && typeof vData.peerDependencies === 'object'
    ? Object.fromEntries(
        Object.entries(vData.peerDependencies)
          .filter(([, r]) => typeof r === 'string'),
      ) as Record<string, string>
    : undefined;
  ```

  And at `src/npm-resolve-facet.ts:287-300` (facet):

  ```ts
  let allPeers: Record<string, string> | undefined;
  // … gather all peers (required + optional) …
  if (Object.keys(all).length > 0) allPeers = all;
  ```

- **The R2.5 enqueue sites loop the full set without REJECT_INSTALL
  filtering.**

  Supervisor — `src/npm-resolver.ts:757-773`:
  ```ts
  // X.5-F R2.5: when the user typed THIS package at top level,
  // also enqueue optional peer-deps. …
  if (topLevelNames.has(pkg.name)) {
    const allPeers = (pkg as any).__allPeerDependencies as Record<string, string> | undefined;
    if (allPeers) {
      for (const [peerName, peerRange] of Object.entries(allPeers)) {
        if (resolved.has(peerName) || seen.has(peerName)) continue;
        topLevelNames.add(peerName);
        queue.push([peerName, peerRange as string]);
      }
    }
  }
  ```

  Facet — `src/npm-resolve-facet.ts:743-752`: byte-equivalent shape.

- **The reject fires inside resolveOne for the rejected peer.**

  Supervisor — `src/npm-resolver.ts:657-667`:
  ```ts
  const rejectFail = lookupReject(name);
  if (rejectFail && rejectFail.transitive === 'fail') {
    emitRegistryEvent({ type: 'reject', from: rejectFail.from, … });
    throw new RegistryRejectError([rejectFail]);
  }
  ```

  Facet — `src/npm-resolve-facet.ts:512-530`: throws
  `Error` with `__w6_reject = true` own-property (postMessage-survivable
  equivalent).

- **The reject propagates through `Promise.all` → resolveTree → caller.**

  Supervisor catch at `src/npm-resolver.ts:710-712`:
  ```ts
  if (cls === 'registry-reject') {
    // Re-throw — registry rejects are loud at any depth.
    throw e;
  }
  ```

  This is the **correct** behaviour for **required** peers / deps. It
  is the **wrong** behaviour for **optional** peers enqueued via R2.5
  — those should soft-skip, just like the existing optional-dep path
  (X.5-G G1) does for entries from `optionalDependencies`.

### 2.1 The pattern this generalises

The existing `@rollup/wasm-node` carve-out at
`src/npm-resolve-facet.ts:640`:

```ts
if (p.name === '@rollup/wasm-node') return false;
```

…is a one-package whitelist inside `isOptionalNativeBindingFacet`. It
ensures the swap-target survives the optional-native-binding skip. The
shape of X.5-J's fix is the **mirror image**: a generalised SKIP-rule
that says "any optional **peer** whose target is in REJECT_INSTALL
gets soft-skipped at enqueue time". Same architectural idea
(carve-out by registry consultation), different polarity (skip rather
than keep), different cohort (R2.5 peers rather than R2.5 nativs).

### 2.2 Why the regression slipped past existing probes

Per VERIFY-EB316DC.md §8:

- The X.5-F retro's `install-pipeline-coverage` regression suite
  validates a curated 3-package set (not the full 33-pkg compat list).
- The X.5-G retro's `transitive-warn-still-warns` tests transitive
  **swaps**, not transitive **rejects** under R2.5.
- The X.5-C retro's regression probes test pre-bundler invariants,
  not install-plan composition with rejected optional peers.

The 33-pkg compat harness composes all the moving parts (R2.5 +
REJECT_INSTALL fan-out) simultaneously and is the only place the
regression surfaces. **Recommended (not gated by this fix): adopt the
verification 33-pkg sweep into the dispatch criteria for any wave
that touches resolver / install-plan code.** This recommendation is
also flagged in VERIFY-EB316DC.md §8 (last paragraph).

---

## 3. Fix design

### 3.1 Surface

Two byte-equivalent edits at the R2.5 enqueue sites:

| File | Lines | Surface |
|---|---|---|
| `src/npm-resolver.ts` | 757-773 (R2.5) | supervisor BFS |
| `src/npm-resolve-facet.ts` | 743-752 (R2.5) | facet BFS |

The facet variant must use the preamble-injected
`SHOULD_REJECT_FAIL` / `SHOULD_WARN_SKIP_TRANSITIVE` accessors (the
facet body is `fn.toString()`-serialised and cannot import
`lookupReject`). The supervisor variant uses `lookupReject` directly.

### 3.2 Fix sketch — supervisor (`src/npm-resolver.ts`)

```ts
// X.5-F R2.5: when the user typed THIS package at top level,
// also enqueue optional peer-deps. Mirrors npm CLI's
// `--include=peer` default. Without this, framer-motion (whose
// peers are ALL marked optional including react) installs but
// its compiled CJS still imports react/jsx-runtime and fails.
// For TRANSITIVE packages we keep optionals filtered out — only
// top-level requests get this generous treatment.
//
// X.5-J: optional peers whose target is in REJECT_INSTALL get
// SOFT-SKIPPED at enqueue time. Without this, drizzle-orm
// (optional peer sql.js) and ts-node (optional peer @swc/core)
// regress to ⛔ because R2.5 enqueues the rejected peer and the
// resolveOne reject-throw propagates through Promise.all,
// killing the parent install. The parent's runtime fallback
// handles the absence of the rejected optional peer.
// REQUIRED peers in REJECT_INSTALL still hard-fail (R2 path at
// line 750 uses peerDependencies which excludes optionals).
if (topLevelNames.has(pkg.name)) {
  const allPeers = (pkg as any).__allPeerDependencies as Record<string, string> | undefined;
  if (allPeers) {
    for (const [peerName, peerRange] of Object.entries(allPeers)) {
      if (resolved.has(peerName) || seen.has(peerName)) continue;
      // X.5-J: filter optional peers through REJECT_INSTALL.
      const peerReject = lookupReject(peerName);
      if (peerReject) {
        const reason = `optional peer in REJECT_INSTALL: ${peerName} — ${peerReject.reason}`;
        onProgress?.(`[npm] [skip] ${peerName} (${reason})`);
        emitRegistryEvent({
          type: 'transitive-skip',
          from: peerName,
          reason,
        });
        seen.add(peerName); // prevent re-enqueue from another path
        continue;
      }
      topLevelNames.add(peerName);
      queue.push([peerName, peerRange as string]);
    }
  }
}
```

### 3.3 Fix sketch — facet (`src/npm-resolve-facet.ts`)

```ts
// X.5-F R2.5: when THIS pkg is the user's top-level request,
// also enqueue OPTIONAL peer-deps (npm CLI's --include=peer
// default). Without this, framer-motion installs but its
// compiled CJS still imports react/jsx-runtime.
//
// X.5-J: optional peers whose target is in REJECT_INSTALL get
// SOFT-SKIPPED at enqueue time. Mirrors npm-resolver.ts:R2.5.
// Uses preamble-injected SHOULD_REJECT_FAIL +
// SHOULD_WARN_SKIP_TRANSITIVE rather than imports.
if (topLevelNames.has(pkg.name)) {
  const allPeers = (pkg as any).__allPeerDependencies as Record<string, string> | undefined;
  if (allPeers) {
    for (const [peerName, peerRange] of Object.entries(allPeers)) {
      if (resolved.has(peerName) || seen.has(peerName)) continue;
      // X.5-J: filter optional peers through REJECT_INSTALL.
      // @ts-ignore — preamble.
      const __peerFail = SHOULD_REJECT_FAIL(peerName);
      // @ts-ignore — preamble.
      const __peerWarn = SHOULD_WARN_SKIP_TRANSITIVE(peerName);
      const __peerReject = __peerFail || __peerWarn;
      if (__peerReject) {
        const reason = `optional peer in REJECT_INSTALL: ${peerName} — ${__peerReject.reason}`;
        messages.push(`[resolve-facet] [skip] ${peerName} — ${reason}`);
        // @ts-ignore — preamble.
        __EMIT_EVENT({ type: 'transitive-skip', from: peerName, reason });
        seen.add(peerName);
        continue;
      }
      topLevelNames.add(peerName);
      queue2.push([peerName, peerRange as string]);
    }
  }
}
```

### 3.4 Why filter at ENQUEUE, not at CATCH

Two equally-correct fix families:

- **Enqueue-time filter (chosen):** consult REJECT_INSTALL before
  pushing into the queue. Cheaper (no fetch, no resolveOne, no
  `RegistryRejectError` allocation), explicit (the soft-skip event
  carries the "optional peer" semantic clearly), and symmetric with
  the existing X.5-G `optionalNames` machinery.
- **Catch-time conversion:** let resolveOne throw `RegistryRejectError`
  for the optional peer, catch it in the BFS, classify by "this name
  was added via R2.5 (track in `optionalPeerNames`)", convert to
  soft-skip. Requires an additional `optionalPeerNames` set + a touch
  in the catch block + a touch in `classifyInstallError`.

Both work. Enqueue-time is smaller-diff, has fewer moving parts, and
is more discoverable (the REJECT_INSTALL consultation lives next to
the enqueue, where someone reading R2.5 will naturally see it). The
catch-time variant would force a future reader to chase the soft-skip
across two files. Picking enqueue-time.

### 3.5 What we explicitly DO NOT change

- **Required peers (R2 path).** `peerDependencies` is the
  required-only subset filtered by `extractRequiredPeers` at
  npm-resolver.ts:526 / facet equivalent. R2 enqueues this set at
  npm-resolver.ts:750 / facet:732. We leave R2 alone — a required
  peer in REJECT_INSTALL legitimately blocks the parent
  install (the parent fundamentally cannot run without it).
- **Transitive `dependencies` walks.** Lines 726-730 (supervisor) /
  712-716 (facet) enqueue required transitive deps. Same policy as
  R2 — required deps in REJECT_INSTALL are loud, by design.
- **Top-level user requests.** If the user runs `npm install sql.js`
  directly, the **top-level** path at npm-installer.ts:980+ (calling
  `applyW6Registry`) fires REJECT_INSTALL with `ctx: 'top'` BEFORE
  resolution starts. That contract is unchanged.
- **Optional `optionalDependencies` (X.5-G G1).** Already correctly
  silent-skips native bindings via `optionalNames` at
  npm-resolver.ts:739 and facet:724. The X.5-G path is orthogonal —
  it covers entries from `optionalDependencies`, not optional peers
  from `peerDependencies` + `peerDependenciesMeta.optional`.

### 3.6 What about `transitive='warn'` peers?

REJECT_INSTALL has two `transitive` levels:
- `'fail'` — sharp, sql.js, @swc/core, prisma, etc. Throws.
- `'warn'` — fsevents, bufferutil, utf-8-validate, node-gyp,
  node-pre-gyp. These already silent-skip via the `warnSkip` branch at
  npm-resolver.ts:651-656. So they're NOT part of this regression
  cluster — but for symmetry, X.5-J's enqueue-time filter handles BOTH
  by checking `lookupReject` (which returns either kind) and treating
  both as "soft-skip at enqueue". This avoids a redundant resolveOne
  call for warn peers too.

Verify against probe data: VERIFY-EB316DC.md §1 X.5-G section confirms
`fsevents` (a 'warn' peer of chokidar etc.) is correctly silent-skipped
today — not regressed. So for 'warn' peers there's no behaviour change
to user-visible output, just a small efficiency win (skipping a
roundtrip).

---

## 4. Test plan (Phase B — TDD red)

Layout: `audit/probes/x5j/{functional,regression,e2e}/`. Mirrors
X5G/X5F shape. `run-all.mjs` orchestrator.

### 4.1 Functional (source-level invariants, fast, no network)

| Probe | Asserts |
|---|---|
| `r25-rejects-optional-peer-supervisor.mjs` | npm-resolver.ts R2.5 site contains a `lookupReject` consultation BEFORE the `topLevelNames.add` / `queue.push`; the consult's "skip" branch emits `transitive-skip`. Source-grep + AST-shape. |
| `r25-rejects-optional-peer-facet.mjs` | npm-resolve-facet.ts R2.5 site contains a `SHOULD_REJECT_FAIL` (or `SHOULD_WARN_SKIP_TRANSITIVE`) consultation BEFORE `queue2.push`; the skip branch emits `transitive-skip` + pushes a `[skip]` message. |
| `r2-required-peer-still-throws.mjs` | npm-resolver.ts R2 (required peers, line 750) and the corresponding facet R2 do NOT have the optional-peer-skip branch (we did not weaken the required-peer hard-fail invariant). |
| `synth-fixture-package-rejects-soft-skip.mjs` | A pure unit-style probe: instantiate the resolver path with a synthetic packument where pkg P has optional peer N, N is in REJECT_INSTALL. Resolve P → expect `resolved.has(P) === true`, `resolved.has(N) === false`, registry events include one `transitive-skip` for N with reason mentioning "optional peer in REJECT_INSTALL". |

### 4.2 Regression (don't-break invariants)

| Probe | Asserts |
|---|---|
| `single-resolver-source.mjs` (reuse from X5G) | Both fix-loci edited in lockstep; supervisor and facet still byte-equivalent in shape. |
| `loud-reject-still-loud-top-level.mjs` | Top-level `npm install sharp` (or any REJECT_INSTALL `transitive='fail'` entry) STILL hard-fails with `RegistryRejectError` — we didn't weaken the user-asked-for-this-package contract. |
| `loud-reject-still-loud-required-peer.mjs` | Synth package P with REQUIRED peer N, N in REJECT_INSTALL → install P STILL hard-fails (R2 path unchanged). |
| `r25-still-installs-non-rejected-peers.mjs` | Synth package P with optional peers [A, B]; A is in REJECT_INSTALL, B is not. Install P → A skipped, B installed, P installed. (Confirms we soft-skip ONLY rejected peers, not the whole optional-peer set.) |
| `tsc-baseline-preserved.mjs` | `tsc --noEmit` produces the same 2 errors at the same locations. |

### 4.3 E2E (real wrangler dev — gated behind `NIMBUS_X5J_E2E=1`)

| Probe | Smoke |
|---|---|
| `drizzle-orm.mjs` | `npm install drizzle-orm` succeeds, `require('drizzle-orm')` returns object with non-empty keys. |
| `ts-node.mjs` | `npm install ts-node` succeeds, `typeof require('ts-node') === 'object'`. |
| `framer-motion.mjs` (regression) | `npm install framer-motion` STILL ✅ — confirms R2.5 still enqueues non-rejected optional peers like `react`/`react-dom`. |
| `parcel.mjs` (loud-reject regression) | `npm install parcel` STILL ⛔ at `@swc/core` — top-level reject path unchanged. (parcel has @swc/core as a TRANSITIVE dep, not an optional peer of parcel itself; the reject still fires from the dependencies walk.) |

### 4.4 Driver / orchestrator

- `audit/probes/x5j/e2e/_x5j-driver.mjs` — copy of `_x5g-driver.mjs`
  with X5J banner. Reuses `runProbe` from `_driver.mjs`.
- `audit/probes/x5j/run-all.mjs` — copy of x5g/run-all.mjs
  parameterised for the X5J FUNCTIONAL/REGRESSION/E2E lists.

---

## 5. Risk register

| # | Risk | Mitigation |
|---|---|---|
| 1 | Carve-out is too aggressive — silently skips an OPTIONAL peer that some user actually wants. | Mitigation: skip emits an explicit `transitive-skip` registry event with reason `optional peer in REJECT_INSTALL: <name> — <reject.reason>`. The user-visible install log surfaces `[npm] [skip] sql.js (optional peer in REJECT_INSTALL …)`. If user truly wants sql.js, they `npm install sql.js` directly → top-level path fires the loud reject + suggest message. Same as existing 'warn'-tier semantics. |
| 2 | Carve-out is too narrow — there's a third regression somewhere. | Verify-eb316dc swept all 33 packages and found exactly 2 regressions, both in this cluster (VERIFY-EB316DC.md §8). The probe layer for X5J adds `framer-motion.mjs` E2E + `r25-still-installs-non-rejected-peers.mjs` synth-fixture to confirm we don't break the OTHER R2.5 targets (whose retro flips were genuine). |
| 3 | Supervisor-vs-facet drift after edit. | The functional probes assert BOTH sites have the consultation. The X5G `single-resolver-source.mjs` regression also asserts byte-equivalent shape. |
| 4 | A peer in REJECT_INSTALL is *also* an entry in `dependencies` (transitive required dep) of some other already-resolved package — does our R2.5 skip prevent its later legitimate hard-fail? | No. The `seen.add(peerName)` we set in the skip branch only prevents *re-enqueue*. If the dependencies walk at line 726-730 had ALREADY enqueued `peerName` (or does so later), the dep walk is NOT gated on `topLevelNames` and uses the full resolveOne path which includes the W6 reject. **But** transitive walks process via `seen.has(name)` at line 631 — once we mark `seen.add(peerName)` in the R2.5 skip, the dep walk would early-return null. We'd then silent-pass a required dep. **Mitigation:** examine carefully — if the optional peer is ALSO a required transitive dep of some other resolved package, that's a legitimate hard-fail signal. Solution: do NOT add to `seen` in the skip branch; only the `resolved.has` / `seen.has` check at the start of the loop is needed to prevent THIS R2.5 re-enqueue (which can only re-fire if R2.5 runs twice for the same peer name; since we iterate `pkg.__allPeerDependencies` and `topLevelNames` is monotonic, that case is `resolved.has(peerName) || seen.has(peerName)` already protected). **Plan revision (post-review): drop `seen.add(peerName)` from §3.2 and §3.3.** |
| 5 | tsc / preamble parity edge. | The facet edit references preamble-injected `SHOULD_REJECT_FAIL` and `SHOULD_WARN_SKIP_TRANSITIVE`. Both already exist in npm-resolve-preamble.ts:109-118. No preamble edit required — gated by `audit/probes/w6/functional/preamble-parity.mjs` which runs in run-all.mjs. |

### 5.1 Plan revision from §5 #4

The fix sketches in §3.2 and §3.3 originally added `seen.add(peerName)`
inside the skip branch. **Removed.** The existing
`if (resolved.has(peerName) || seen.has(peerName)) continue;` guard at
the top of the loop already protects against re-enqueue during R2.5
iteration. Adding `seen.add` would incorrectly mask a downstream
required-dep walk hitting the same name. Final fix sketch retains only:

```ts
if (peerReject) {
  emit transitive-skip event;
  log [skip];
  continue;  // do NOT add to seen — let the dep walk do its job
}
```

This is the operational version to be implemented.

---

## 6. Sub-agent review

A Task-tool sub-agent review was attempted (general agent, structured
prompt at Phase A start) but the agent provider returned
`ProviderModelNotFoundError`. Self-review performed instead via
direct re-read of:
- `src/npm-resolver.ts:485-540` (versionToResolved + extractRequiredPeers)
- `src/npm-resolver.ts:600-783` (resolveTree BFS)
- `src/npm-resolve-facet.ts:480-755` (facet BFS)
- `src/wasm-swap-registry.ts:108-300` (REJECT_INSTALL data)
- `src/wasm-swap-registry.ts:336-345` (lookup API)
- `src/wasm-swap-registry.ts:700-715` (classifyInstallError)
- `src/parallel/npm-resolve-preamble.ts:74-118` (facet REJECT mirror)

The §5 #4 risk surfaced during self-review and resulted in §5.1
revision before any code lands.

Sub-agent retry deferred to Phase D's diff review.

---

## 7. Done-criteria checklist (re-statement)

- [ ] Phase A — X5J-plan.md committed.
- [ ] Phase B — `audit/probes/x5j/{functional,regression,e2e}/`
      probes written, RUN locally, **all RED** before any src edit.
- [ ] Phase C — fix in `src/npm-resolve-facet.ts` (R2.5 site at line
      ~743) + `src/npm-resolver.ts` (R2.5 site at line ~757). Each
      commit references its turn-green test.
- [ ] Phase D — All x5j tests GREEN locally; w6 preamble-parity green;
      Mossaic regression green; `tsc --noEmit` clean baseline (2
      errors, byte-identical); sub-agent diff review attempted.
- [ ] Phase E — `git push origin x5j-r25-reject` best-effort.
- [ ] Phase F — X5J-retro.md committed: per-package verdict
      (drizzle-orm ⛔→✅, ts-node ⛔→✅), root-cause final, what
      surprised, scope deviations.

---

## 8. Anti-requirements (re-statement)

- NO src/ change without a green-turning test.
- NO files outside `/workspace/worktrees/x5j-r25-reject/`.
- NO push to main; only `x5j-r25-reject` branch.
- NO unreviewed commits.
- NO touch of `src/require-resolver.ts` (X.5-L).
- NO touch of `src/node-shims.ts` (X.5-M).
- DO NOT pause for user input.
- Stuck → `audit/sessions/X5J-stuck.md` + exit.
