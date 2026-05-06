# X.5-drizzle — Retro

> **Wave:** X.5-drizzle (P0 strict regression recovery for `drizzle-orm`)
> **Branch:** `x5-drizzle` (off `origin/main` @ `9d4b61d`)
> **Final commit:** `5c3d61f` (Phase D fix; this retro adds Phase E/F/G)
> **Author:** autonomous opencode session, 2026-05-06 (~2.5 h wall, two
>   sessions: original session crashed mid-Phase-D-audit; resumed for E/F/G)
> **Mission (from prompt + VERIFY-9D4B61D §4 #1):** recover the
>   drizzle-orm strict-regression caused by X.5-26b's `lightningcss`
>   `transitive: 'fail'` REJECT_INSTALL, without regressing W11
>   framework-detect for next/astro/nuxt/remix/sveltekit.

---

## TL;DR

| Question | Answer |
|---|---|
| **Done condition: drizzle-orm ✅ at real-package install layer?** | **YES** — 3/3 e2e probes GREEN against live wrangler. `npm install drizzle-orm` adds 614+ packages cleanly; `require('drizzle-orm')` returns the expected key list. |
| **Heuristic chosen** | Best-effort optional-peer subtree soft-skip (NEW `bestEffortNames` Set in `npm-resolver.ts` + `npm-resolve-facet.ts`). NOT the framework-detect refinement the Phase B plan proposed. |
| **W11 regression status** | **0 regressions.** All 12 W11 detect probes still PASS. `framework-detect.ts` was NOT modified. `frameworkAware` flag semantics unchanged. |
| **Cohort delta (predicted)** | drizzle-orm `⛔ → ✅`; cohort 15/33 → 16/33 strict; healthy unchanged at 31/33. Cohort-level verification awaits next 33-pkg sweep. |
| **Plan-vs-actual mechanism deviation** | YES — VERIFY-9D4B61D §3 + Phase B plan misattributed the cause to framework-detect. The empirical chain is `drizzle-orm → expo-sqlite (X.5-J optpeer) → expo (peer) → @expo/metro-config (dep) → lightningcss (dep)`. Framework-detect does fire for the starter, but the lightningcss reject reaches the resolver via X.5-J's --include=peer convenience for optional peers, not via vite. |

---

## 1. drizzle-orm verdict

**✅ recovered to strict-✅.**

Evidence (Phase D audit, 2026-05-06, BASE=`http://127.0.0.1:8790`):

```
audit/probes/x5-drizzle/e2e/drizzle-orm-installs.audit.out.txt
  ok  probe ran (POST /new succeeded)
  ok  install output contains "added N packages"        ← 614+ packages
  ok  install output does NOT contain "npm install failed"
  ok  install output does NOT contain "❌ lightningcss"
  ok  drizzle-orm finished without "resolver-facet failed"
  ok  lightningcss soft-skipped (X.5-drizzle)            ← NEW [skip] line

audit/probes/x5-drizzle/e2e/drizzle-orm-smoke.audit.out.txt
  ok  install succeeded ("added N packages")
  ok  NO "Cannot find module 'drizzle-orm'"
  ok  keys output present
  ok  keys list contains ColumnAliasProxyHandler         ← matches verify-700420f baseline
  ok  keys list contains TableAliasProxyHandler

audit/probes/x5-drizzle/e2e/drizzle-orm-no-vite-pulled.audit.out.txt
  ok  node_modules/drizzle-orm exists
  ok  node_modules/vite does NOT exist
  ok  node_modules/lightningcss does NOT exist           ← mechanism check
```

Pre-fix transcripts archived for posterity at
`audit/probes/x5-drizzle/e2e/*.pre-fix.out.txt`. Diff:

```
PRE-FIX (HEAD 9d4b61d):
  [npm]   resolver-facet failed: npm install rejected: lightningcss
  npm install failed: resolver-facet failed: npm install rejected: lightningcss
  → exit 1; node_modules/drizzle-orm absent; smoke "Cannot find module 'drizzle-orm'"

POST-FIX (HEAD 5c3d61f):
  [npm] [resolve-facet] [skip] lightningcss — inside best-effort optional-peer subtree (X.5-drizzle): npm install rejected: lightningcss — Native Rust CSS parser; ...
  added 614+ packages
  → keys: ["ColumnAliasProxyHandler", "RelationTableAliasProxyHandler", ...]
```

## 2. Heuristic refinement chosen

**`bestEffortNames` Set + transitive-reject soft-skip in the resolver
BFS** — not a framework-detect refinement.

### Files & diff

```
src/npm-resolve-facet.ts | +46 LOC (3 hunks: Set decl, inheritBestEffort propagation, catch-branch + X.5-J tag)
src/npm-resolver.ts      | +41 LOC (mirror — same X.5-J path duplicated for in-supervisor + in-facet)
                            =====
Total                    | +87 LOC
```

0 new files. 0 type changes. 0 new exports. tsc baseline byte-identical.

### Mechanism

1. **Tag** the X.5-J optional-peer enqueue (R2.5, `topLevelNames.has(pkg.name)` branch): when the resolver enqueues an optional peer of a top-level package via `--include=peer`, ALSO add it to `bestEffortNames`.
2. **Propagate** during the post-resolve children-enqueue: when `pkg.name` is in `bestEffortNames`, inherit the flag onto its newly-enqueued children (deps + optionalDependencies + peerDependencies) BEFORE pushing them to the queue.
3. **Soft-skip** in the `__w6_reject` catch path: when `e.__w6_reject === true` AND `bestEffortNames.has(name)`, emit a `[skip] <name> — inside best-effort optional-peer subtree (X.5-drizzle): <reason>` notice and `return null` (drop the package), instead of throwing (which would kill the parent install).

### Rationale (why this vs the Phase B plan's framework-detect refinement)

**Phase B plan §2 chose Option 1: refine `detectFrameworkAware()` to exclude generic-vite.** That fix was implemented in a Phase D first-attempt commit, then reverted when the e2e probe stayed RED. Investigation 04 (`audit/probes/x5-drizzle/investigation/04-trace-lightningcss-from-drizzle.mjs`) statically walked the npm registry via drizzle-orm's 28 optional peers + their peers + their deps to depth 5. **One** hit:

```
expo-sqlite → expo (peer) → @expo/metro-config (dep) → lightningcss (dep)
```

`lightningcss` is NOT pulled via the framework-detected vite. It's pulled via X.5-J's optional-peer enqueue. VERIFY-9D4B61D §3 misattributed the cause — likely because the `[npm] Framework detected` banner is so visible in the install transcript that it looked load-bearing.

### Alternatives considered

| Option | File:line | Verdict | Why rejected |
|---|---|---|---|
| A. Refine `detectFrameworkAware` to exclude generic-vite (Plan §2 Option 1) | `src/npm-installer.ts:898` | **Tested, reverted** — did NOT fix drizzle-orm; lightningcss still rejected via the optional-peer chain. Independently correct hygiene per W11-retro §4 #8 stated intent (Mossaic-shape projects should have aware=false), but not load-bearing for this regression. Tracked as a future hygiene candidate. |
| B. Whitelist `expo-sqlite` (and similar mobile-only optional peers) in a SKIP set | `src/npm-resolver.ts` X.5-J check | Brittle. Every drizzle-shaped package has different problematic optional peers; an explicit list would need ongoing curation. Generic mechanism (best-effort subtree) covers this case + every future similar shape with one rule. |
| C. Speculative packument-walk at X.5-J enqueue time, skip optional peers whose subtree would reject | `src/npm-resolver.ts` X.5-J check | Async + fetches at enqueue time = significant complexity + latency, for marginal benefit over reactive soft-skip. Reactive is correct: we only swallow rejects that ACTUALLY fire. |
| D. Convert lightningcss from `transitive: 'fail'` back to `transitive: 'warn'` | `src/wasm-swap-registry.ts` | Forbidden by prompt anti-requirement. Would also undo X.5-26b's intent (loud REJECT for the 4 transitive consumers vite/vitest/drizzle-orm/nuxt). |
| E. Best-effort optional-peer subtree soft-skip (CHOSEN) | `src/npm-resolve-facet.ts` + `src/npm-resolver.ts` | **Implemented.** Generic, no curation, preserves loud REJECT for required subtrees. |

### Why this is structurally correct (not just opportunistic)

X.5-J R2.5 introduced `--include=peer` semantics: when the user types `npm install drizzle-orm`, npm CLI's default is to ALSO pull drizzle-orm's optional peers as a convenience. The user did NOT explicitly ask for `expo-sqlite` or its mobile-build-tooling subtree. Per npm's `--omit=optional` doctrine, fetch failures and unmet sub-deps in such best-effort subtrees should silent-skip, not fail the parent install. Our W6 REJECT_INSTALL with `transitive: 'fail'` was correctly designed to be loud for REQUIRED subtrees — but X.5-J's optional-peer subtrees aren't required. The fix aligns the two contracts.

`bestEffortNames` is an orthogonal third axis on top of existing `topLevelNames` / `optionalNames` — no existing semantics narrow.

## 3. Scope deviations from prompt prediction

### 3.1 Mechanism deviation

| Predicted (prompt + Plan §B) | Actual |
|---|---|
| Cause: framework-detected vite pull-in → lightningcss | Cause: X.5-J optional-peer chain (`expo-sqlite → expo → @expo/metro-config → lightningcss`) |
| Fix loc: "src/npm-resolver.ts 'Framework detected' heuristic (search literal string)" | Fix loc: `src/npm-resolver.ts` + `src/npm-resolve-facet.ts` — X.5-J optional-peer enqueue + `__w6_reject` catch path. Literal "Framework detected" lives in `src/npm-installer.ts:209` (one file off from the prompt) and is unrelated. |
| Refinement: skip speculative vite pull when not actually required | Refinement: best-effort soft-skip for optional-peer subtree rejects |

### 3.2 Diff size deviation

| Predicted | Actual |
|---|---|
| Plan §5: ~6 LOC including comment, single `&& result.framework !== 'vite'` clause | +87 LOC across 2 files (Set + propagation + catch-branch + X.5-J tag, both in-supervisor and in-facet paths) |

The Phase B plan's "single condition refinement" was ~6 LOC. The actual mechanism required a new orthogonal axis (`bestEffortNames`) propagated through the BFS + reactive catch in two parallel resolver implementations (mirror parity is a hard invariant per W11/X.5-J/X.5-26b). 87 LOC is still small absolute (no new files, no new types) but 14× the plan's prediction.

### 3.3 Probe-suite deviation

| Predicted (Plan §4) | Actual |
|---|---|
| `installer-detect-source-shape.mjs` — checks `&& result.framework !== 'vite'` clause in `npm-installer.ts:detectFrameworkAware` | `installer-detect-source-shape.mjs` — checks `bestEffortNames` declared + soft-skip branch + `inheritBestEffort` propagation in BOTH `npm-resolver.ts` and `npm-resolve-facet.ts` |
| `mossaic-regression-coverage.mjs` — asserts Mossaic-shape gets `aware=false` post-fix (codifies W11-retro §4 #8 intent) | Downgraded to detector-contract-only (since framework-detect is no longer touched). The W11-retro §4 #8 hygiene case is now a follow-up candidate, not load-bearing for x5-drizzle. |

3 functional + 5 regression + 3 e2e probes shipped (matching plan §4 count); content swapped to test the actual mechanism.

### 3.4 Forbidden files

**0 violations.** `git diff origin/main..HEAD src/` lists only `npm-resolver.ts` + `npm-resolve-facet.ts`. The 3 explicitly-forbidden files (`src/node-shims.ts`, `src/wasm-swap-registry.ts`, `src/parallel/npm-resolve-preamble.ts`) are bit-identical to origin/main.

### 3.5 Cohort prediction

| Forecast (VERIFY-9D4B61D §4 #1 + prompt) | Actual (Phase D audit) | Cohort verification |
|---|---|---|
| drizzle-orm `⛔ → ✅`; +1 strict ✅ | drizzle-orm ✅ at e2e probe layer; 6/6 install + 6/6 smoke + 6/6 no-vite-pulled GREEN | Cohort-level verification (33-pkg sweep) requires post-deploy run; same caveat as VERIFY-9D4B61D itself ("Prod deploy still gated on user OAuth return") |
| Cohort 15/33 → 16/33 strict; 31/33 healthy unchanged | 16/33 strict prediction holds: drizzle-orm flips ⛔→✅; no other cohort movement expected from the +87-LOC change | Awaits 33-pkg sweep |

### 3.6 Bonus discovery (out-of-scope but worth recording)

The X.5-J best-effort soft-skip ALSO unlocks any other 33-pkg cohort entry whose strict-regression flows through an optional-peer chain that hits a REJECT_INSTALL transitively. Candidates from VERIFY-9D4B61D §3:

- `vite` (top-level install): NOT covered — vite is itself the target; lightningcss is a REQUIRED transitive of vite, not under an optional-peer subtree. **Stays ⛔.**
- `vitest`: same — vite/lightningcss are required transitives. **Stays ⛔.**
- `nuxt`: top-level install of `nuxt` triggers vite as a peer; the vite→lightningcss chain is required for nuxt's runtime. **Stays ⛔ via lightningcss; was already ⛔ pre-X.5-drizzle.**

Per VERIFY-9D4B61D §3 the recoverable-strict candidates were drizzle-orm + vite + vitest. Our fix recovers drizzle-orm only (the targeted regression). vite + vitest stay ⛔ honest because their relationship to lightningcss is REQUIRED, not best-effort.

## 4. REGRESSED status — what we MUST NOT have broken

**Critical: W11 framework-detect for Next/Astro/Nuxt/Remix/SK.**

Direct evidence (Phase D audit):

```
$ bun audit/probes/x5-drizzle/regression/w11-frameworks-still-detect.mjs
==== W11 detect probes (run via X.5-drizzle regression shim) ====
  PASS  audit/probes/w11/functional/detect-next.mjs
  PASS  audit/probes/w11/functional/detect-astro.mjs
  PASS  audit/probes/w11/functional/detect-nuxt.mjs
  PASS  audit/probes/w11/functional/detect-remix.mjs
  PASS  audit/probes/w11/functional/detect-sveltekit.mjs
  PASS  audit/probes/w11/functional/detect-wrangler.mjs
  PASS  audit/probes/w11/functional/detect-wrangler-on-framework.mjs
  PASS  audit/probes/w11/functional/detect-vite-generic.mjs
  PASS  audit/probes/w11/functional/detect-precedence.mjs
  PASS  audit/probes/w11/functional/detect-remix-bare-react.mjs
  PASS  audit/probes/w11/functional/detect-unknown.mjs
  PASS  audit/probes/w11/functional/shim-modules-loadable.mjs
Total: 12 pass / 0 fail (out of 12)
```

**Structural argument (why this can't regress W11 even if the probe missed something):**

1. `framework-detect.ts` was NOT modified. `git diff origin/main..HEAD src/framework-detect.ts` is empty.
2. `npm-installer.ts:detectFrameworkAware` was NOT modified (the Phase D first-attempt edit was reverted before commit). `git diff origin/main..HEAD src/npm-installer.ts` is empty.
3. The `frameworkAware` flag flows from `detectFrameworkAware` → `resolveTree` / `resolveTreeViaFacet` → `SHOULD_SKIP_PACKAGE(name, frameworkAware)` exactly as in W11. Unchanged.
4. The `FRAMEWORK_REQUIRED_PACKAGES` set (containing `'vite'`) is unchanged.
5. `bestEffortNames` is a NEW orthogonal Set. It's separate from `topLevelNames` / `optionalNames`; the existing skip-decision still consults `topLevelNames` and `SHOULD_SKIP_PACKAGE(name, frameworkAware)`. W11's load-bearing semantic ("framework CLI can `import 'vite'` from node_modules when frameworkAware=true") is intact.
6. The new soft-skip branch only fires inside the `__w6_reject` catch when `bestEffortNames.has(name)`. For a real framework install (e.g., `npm install astro` in an astro project), the resolved tree's REQUIRED packages don't go into `bestEffortNames` — only optional-peer subtrees do. astro/sveltekit/nuxt/remix don't have problematic optional-peer chains in the 33-pkg cohort.

### Other regression sweeps (Phase D audit)

| Invariant | Verdict |
|---|---|
| `bunx tsc --noEmit` baseline | 2 errors (esbuild-service / nimbus-session-init) byte-identical to VERIFY-9D4B61D §2 ✓ |
| Single-resolver invariant (1 impl in `_shared/exports-resolver.ts`) | 10/10 single-resolver-source probes PASS (x5f/x5g/x5j/x5m/x5s/x5npqo/x5m3/x5z5-build/x526b/x5-drizzle) ✓ |
| Install-pipeline-coverage canonical | 4/4 PASS (fastify/express/ts-jest/redis) ✓ |
| Wave 1 contract (external-host=0) | PASS at `audit/probes/w4/regression/wave1-contract-rerun.mjs`, external=0 ✓ |
| Mossaic shape probes (data-only) | 3/3 PASS (w12 + w7 + x5-drizzle) ✓ |
| 13 X.5 wave run-alls | 12/13 PASS; x5z5-build is documented pre-existing fail (probe self-marks "out of Z5 scope") ✓ |
| x5peer-gap-investigation probes (peer-gap is plan-only) | 3/3 PASS ✓ |
| Forbidden files untouched | 0 changes to `src/node-shims.ts`, `src/wasm-swap-registry.ts`, `src/parallel/npm-resolve-preamble.ts` ✓ |

**Net: 0 cross-wave regressions.**

## 5. What we'd do differently

1. **Trust the trace probe earlier.** The Phase B plan committed to
   "framework-detect refinement" based on VERIFY-9D4B61D §3's narrative
   without independently tracing the chain. If we'd run a trace probe
   in Phase A (instead of Phase D after the first fix didn't take), we'd
   have skipped the framework-detect dead end and shipped Option E
   directly. **Lesson:** when a verify report names a specific
   mechanism, write a probe that *empirically reproduces* the
   mechanism BEFORE planning the fix, not as a Phase D post-mortem.

2. **The `transitive: 'fail'` blast-radius rule.** VERIFY-9D4B61D §7
   already flagged this: "REJECT_INSTALL adds should be measured
   against the cohort, not just the targeted package, to catch
   transitive cascades early." X.5-26b's lightningcss REJECT cascaded
   through an X.5-J optional-peer subtree — a path the X.5-J retro
   didn't cover and the X.5-26b retro didn't survey. A future
   `transitive: 'fail'` add should run a static-trace probe over the
   33-pkg cohort BEFORE merge.

3. **Mirror parity is a tax.** The X.5-J fix had to land in BOTH
   `npm-resolver.ts` (in-supervisor path, currently dead by default) AND
   `npm-resolve-facet.ts` (in-facet path, default-on). +41/+46 LOC across
   two files for a single semantic change. Future invariant probe:
   assert that any X.5-J / R2.5 logic shape is byte-identical between
   the two files. (Investigation 03's `frameworkAware` survey already
   does a 1-shot manual check.)

4. **Probe runner OOM under sequential e2e.** The single live wrangler
   couldn't survive 3 e2e probes back-to-back (workerd OOM after
   ~2 npm installs each pulling 600+ packages into the SQLite-backed
   VFS). Workaround used: run e2e individually with cooldown. Future:
   the run-all e2e mode should optionally restart wrangler between
   probes (or a shared `_e2e-driver.mjs` helper).

5. **Plan-vs-actual mismatch warning.** The original prompt was very
   specific about "src/npm-resolver.ts 'Framework detected' heuristic"
   — but the literal lives in `src/npm-installer.ts`, and the actual
   fix isn't even in that path. The autonomous-runner pattern works
   well when the prompt's mechanism diagnosis is correct; it needs an
   explicit "investigate first, plan second" cycle when the prompt
   inherits an upstream verify-report misattribution. Phase A/B did
   investigate, but Phase B's plan was over-anchored to the prompt
   instead of to investigation 02's evidence (which already showed
   that frameworkAware would only narrow the starter case, not the
   transitive lightningcss case — though admittedly we didn't trace
   the transitive lightningcss case until Phase D).

## 6. Follow-up candidates

1. **Hygiene: `detectFrameworkAware` excludes generic-vite (Plan §2
   Option 1).** The Phase B plan's framework-detect refinement is
   independently correct (matches W11-retro §4 #8 stated intent —
   Mossaic-shape projects should have aware=false). Not load-bearing
   for any current cohort regression, but eliminates a class of
   "speculative install-graph expansion" issues that could surface for
   future REJECT_INSTALL adds. ~6 LOC; well-tested by the original
   Phase D first-attempt probes (still in `audit/probes/x5-drizzle/`
   investigation/02 evidence). Suggested name: **X.5-drizzle-2**.

2. **Mirror-parity probe between `npm-resolver.ts` and
   `npm-resolve-facet.ts` X.5-J / R2.5 / bestEffort logic.** Currently
   manual; should be mechanical.

3. **Restart-between-probes e2e harness.** Either as a flag on
   `_e2e-driver.mjs` or a new `_runalls-driver.mjs`. Out of scope for
   this wave.

4. **`transitive: 'fail'` blast-radius gate.** Per VERIFY-9D4B61D §7
   recommendation. A static probe that, before merging a
   `transitive: 'fail'` REJECT_INSTALL entry, walks the registry from
   each of the 33 cohort packages + the package being added's reverse
   deps, and reports any new cohort entries that would flip ⛔.
   Out of scope; tracked.

## 7. Closing

X.5-drizzle recovers drizzle-orm cleanly via a generic mechanism
(`bestEffortNames` + transitive-reject soft-skip in optional-peer
subtrees). The Phase B plan's framework-detect refinement was
empirically falsified during Phase D and pivoted; the new fix is
strictly more correct AND aligned with the underlying
`--include=peer` semantic that X.5-J introduced.

W11 framework-detect contract is fully preserved (12/12 detect probes
PASS, framework-detect.ts and npm-installer.ts unchanged). Forbidden
files untouched. tsc baseline stable. Single-resolver invariant
preserved across all 8+ X.5 waves. 13/13 X.5 wave run-alls stable
(12 PASS + 1 documented pre-existing).

**Done.**
