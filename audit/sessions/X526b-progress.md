# X.5-26b cap-fix — progress log

> Branch: `x526b-cap-fix` off `origin/main` @ `23417c5`.
> Worktree: `/workspace/worktrees/x526b-cap-fix`.
> Mission: P0 per VERIFY-23417C5 §4 #2 — highest package-count win on
> {ts-jest, tailwindcss-oxide, lightningcss}.

## Phase A — Investigate (commit hash to be filled)

**Reproduce 3 pkgs via local wrangler dev** (port 8789, setsid-detached
to survive parent shell exits — bash subshell PID otherwise gets reaped
in the cloudchamber container; port 8787/8788 in use by sibling
worktrees x5s-dirname / x5peer-gap).

Probes shipped to `audit/probes/x526b/investigation/`:
- `run-3pkg.mjs` (harness — same install + smoke shape as
  `audit/probes/verify-23417c5/run-packages-local.mjs`, but smoke is
  wrapped in a try/catch that prints `err.stack` with full frames
  via `Error.stackTraceLimit = Infinity`, plus a disk-walk
  introspection block to disambiguate cap-eviction from native-binding
  fallthrough).
- `ts-jest.out.txt`, `ts-jest.probe.js`
- `tailwindcss-oxide.out.txt`, `tailwindcss-oxide.probe.js`
- `lightningcss.out.txt`, `lightningcss.probe.js`
- `_SUMMARY.json`

### A.1 Per-package verdict

| Pkg | Cap-evicted? | Root cause | In scope? |
|---|---|---|---|
| **ts-jest** | **NO** | Missing `_fs.realpathSync.native` shim in `__fsMod` (X.5-Z5 plan §4 — already-known) | **NO** — anti-req: don't touch `src/node-shims.ts` |
| **tailwindcss-oxide** | **NO** | Native-binding fallthrough at `index.js:561` (parent throws npm-4828 message because all sibling `@tailwindcss/oxide-*` shards are correctly skipped at install and there's no JS fallback path) | **YES** — add to `REJECT_INSTALL` in `src/wasm-swap-registry.ts` |
| **lightningcss** | **NO** | `detect-libc.familySync` at `node_modules/detect-libc/.../family-sync.js:198` → `out.split is not a function` (the `child_process.execSync` shim returns `undefined`, not a string; lightningcss's `node/index.js` calls detect-libc to choose a `.node` binding which it cannot load anyway) | **YES** — add to `REJECT_INSTALL` (out-of-cohort but hygienic) |

### A.2 Definitive evidence per pkg

**ts-jest**: stack `getNodeSystem … <anonymous>:8291:43` is INSIDE the
loaded typescript module body (line ~8291 of `typescript.js`). If
typescript were cap-evicted the failure surface would be `Cannot read
module: <path>` at `src/node-shims.ts:2129`. The bare
`require('typescript')` companion probe in our smoke also fails with the
identical error → typescript fully loads, fails at FIRST `getNodeSystem`
call when it dereferences `_fs.realpathSync.native`. Confirms X.5-Z5
plan §4 hypothesis correction (which already disproved the prior
W2.6b cap-eviction speculation).

**tailwindcss-oxide**: install adds **4 files** total
(`LICENSE`, `index.d.ts`, `index.js` (24 KB), `package.json` (2.2 KB)).
Cap is 22 MiB JSON-encoded. Nowhere near the cap. Failure is at
`<anonymous>:561:11` inside the parent's own `index.js` — the parent
package's runtime native-binding loader loop walks
`@tailwindcss/oxide-{platform}` siblings, finds none (all skipped at
install per existing `isOptionalNativeBinding` carve-out), and throws
the npm-4828 message as a deliberate fallthrough.

**lightningcss**: install adds **2 packages, 22 files, 0.1 MiB** total.
Disk walk shows pure-JS surface (no `.node` files). Failure is in
`detect-libc`'s `familyFromCommand`/`familySync` — calls
`child_process.execSync('getconf', ['-a'])`-equivalent and tries to
`out.split('\\n')` the result. Our `__processMod.execSync` shim returns
`undefined` (no real exec syscall in workerd), so detect-libc's
`out.split` blows up. Even if the libc detection worked, the next step
(loading a `.node` binding) would fail.

### A.3 Architectural verdict

The dispatch's **two architectural options** (lift cap / shift typescript
to runtime VFS-on-demand) are **both irrelevant** — none of the 3
packages is cap-blocked. The dispatch's hypothesis (sourced from
VERIFY-23417C5.md §4 #2) is mechanically wrong. The X.5-Z5 plan
correctly disproved the cap-eviction theory for ts-jest at the
investigation phase; the cap-fix dispatch frame has been preserved into
this wave's brief by re-citing the (now-superseded) earlier hypothesis.

**Right architecture for X.5-26b** (within anti-requirements):

1. Add `@tailwindcss/oxide` → `REJECT_INSTALL` (`transitive: 'fail'`) in
   `src/wasm-swap-registry.ts` + mirror in `src/parallel/npm-resolve-preamble.ts`.
   - Direct effect: tailwindcss-oxide ⚠ → ⛔ (loud install reject).
   - Transitive effect: tailwindcss-vite installs `tailwindcss` v4 which
     depends on `@tailwindcss/oxide` — `transitive: 'fail'` propagates
     and tailwindcss-vite ⚠ → ⛔ as well.
   - Net cohort delta: **+2 healthy classifier flips** (oxide +
     tailwindcss-vite both convert to loud rejects).
2. Add `lightningcss` → `REJECT_INSTALL` (`transitive: 'fail'`) — same
   files. Out-of-cohort (not in 33-pkg verify set), zero direct cohort
   delta, but hygiene + protects future cohort additions.
3. ts-jest left ⚠ — honestly diagnosed in plan + retro. Strict-✅ flip
   requires the X.5-Z5 plan §4 realpathSync addition to `__fsMod` in
   `src/node-shims.ts`, which is excluded by this dispatch's
   anti-requirement (X.5-S file lock).

### A.4 Strict-✅ unreachability note

The dispatch's "Done" criterion `≥1/3 of {ts-jest, tailwindcss-oxide,
lightningcss} flip ✅` is **mechanically unreachable** within the
anti-requirement set:

- ts-jest: ✅ requires `realpathSync` shim in node-shims.ts (anti-req).
- tailwindcss-oxide: ✅ requires JS/WASM fallback that workerd can run.
  oxide ships only native `.node` bindings + a `wasm32-wasi` shard;
  workerd lacks `node:wasi` (W6.5/X.5-Z5 — upstream block, not Nimbus).
- lightningcss: same as oxide. Native bindings + `lightningcss-wasm`
  package exists but is `cpu: ["wasm32"]`-only on npm (refuses install
  on x64) AND workerd `node:wasi` gap.

**Resolution**: honor the dispatch's *measurable outcome* (highest
package-count win on the 23417c5 healthy-classifier table) by shipping
the +2 healthy flips above. The strict-✅ axis stays at 16/33 (no
regression). Healthy classifier moves 27/33 → 29/33 (+2). The dispatch's
predicted "+2-3 ✅ → 30-31/33" is partially achievable on the healthy
axis, NOT on the strict-✅ axis. This is the honest verdict per dispatch
language "others honestly diagnosed".

### A.5 Wrangler-dev gotcha (worth recording)

In this cloudchamber container, `nohup … &` + `disown` is **not
sufficient** to detach wrangler dev — the bash subshell exit (after
the agent's bash tool returns) reaps the wrangler PID via SIGHUP-or-
similar even with disown. Use `setsid -f nohup …` to fully detach.
Without setsid, wrangler appears to "die silently" (last log line is
"Ready on …", no error) ~10 seconds after the spawning bash returns.
The 5-sequential-curl-POSTs test passes only when wrangler is
actively serviced by the same bash subprocess that spawned it; the
moment subprocess exits, wrangler dies.

(Also: ports 8787 + 8788 are taken by sibling worktrees' wranglers
[x5s-dirname, x5peer-gap]. We use 8789 to avoid conflict.)


## Phase B — Plan

`audit/sections/X526b-plan.md` shipped. Architectural pivot from
dispatch's cap-fix framing to **REJECT_INSTALL adds** based on Phase A
investigation. Two synchronized data files
(`src/wasm-swap-registry.ts` + `src/parallel/npm-resolve-preamble.ts`).
Predicted +2 healthy cohort flips (oxide + transitive tailwindcss-vite),
+0 strict-✅ flips (anti-req + workerd `node:wasi` gap). Strict-✅
criterion conflict with dispatch flagged in §6.3 + §8 #1.


## Phase C — TDD red probes

Probes shipped:

**Functional** (`audit/probes/x526b/functional/`):
- `oxide-rejected.mjs` — `lookupReject('@tailwindcss/oxide')` returns
  entry with `transitive: 'fail'`, `formatRejectError` outputs
  `❌ @tailwindcss/oxide`. **RED** ✓
- `lightningcss-rejected.mjs` — same shape for lightningcss. **RED** ✓
- `preamble-mirror-sync.mjs` — both new entries present in
  `src/parallel/npm-resolve-preamble.ts:__REJECT_INSTALL` Map AND every
  prior fail-tier entry from canonical registry mirrored. The 22-prior-
  entries mirror check passes today; the 4 new (oxide+lightningcss × 2
  files) FAIL today. **RED** ✓

**Regression** (`audit/probes/x526b/regression/`):
- `single-resolver-source.mjs` — wrapper around X.5-F's invariant.
  PASS today (no src code change yet).
- `install-pipeline-coverage-shim.mjs` — wrapper around X.5-F's. PASS.
- `cross-wave-runalls.mjs` — drives all prior W3-W6 + X.5-* run-alls.
  Heavy (~10 min); included for Phase E gate, NOT for Phase C
  baseline (would not change RED/GREEN of x526b's own changes).

**E2E** (`audit/probes/x526b/e2e/`) — require live wrangler dev on $BASE:
- `oxide-e2e.mjs` — `npm install @tailwindcss/oxide` should be
  loud-rejected. **RED** ✓ (today install succeeds).
- `lightningcss-e2e.mjs` — same. **RED** ✓
- `tailwindcss-vite-transitive-e2e.mjs` — `npm install @tailwindcss/vite`
  transitive-reject via the new oxide entry. **RED** ✓

**run-all.mjs** — wires functional + regression + e2e in one driver.
Today (Phase C): 2 pass / 3 fail (functional+regression run, no
BASE) + e2e RED (all 3 fail when BASE set). Post-Phase D: all GREEN.

Synth-pkg-with-9MiB-file functional probe **NOT shipped** — Phase A
investigation showed cap-eviction is not the failure class for any of
the 3 packages. Documented as intentional deviation in plan §7.1 and
will be reiterated in retro.


## Phase D — Build

Two commits in `src/`:
1. **a7ab5f3** — `src/wasm-swap-registry.ts` adds 2 entries to
   `REJECT_INSTALL` (oxide + lightningcss, both `transitive: 'fail'`).
   28 LOC additive; zero deletions; zero edits to consumers.
2. **896c2f0** — `src/parallel/npm-resolve-preamble.ts` mirror — adds
   the matching 2 entries to the `__REJECT_INSTALL` Map literal.
   4 LOC additive.

After D2, all 8 x526b probes GREEN:
- functional: oxide-rejected (7/7), lightningcss-rejected (7/7),
  preamble-mirror-sync (30/30 — 22 prior fail-tier entries + 8 new
  asserts for the 2 new entries × 2 files × {canonical, mirror}).
- regression: single-resolver-source (PASS), install-pipeline-
  coverage-shim (PASS — BASE-unreachable SKIP path is the prior
  expected behavior).
- e2e: oxide-e2e (4/4), lightningcss-e2e (4/4),
  tailwindcss-vite-transitive-e2e (4/4 — the assertion was corrected
  during phase D from `❌ @tailwindcss/oxide` to `npm install rejected:
  @tailwindcss/oxide` because the transitive reject path in
  src/npm-resolve-facet.ts:525 throws a single-line message without
  the multi-line `❌` prefix that formatRejectError uses; the
  supervisor-side single-package-direct-reject path uses the multi-
  line format with `❌`. Both paths are loud rejects; the difference
  is purely cosmetic.)

run-all.mjs total: **8 pass, 0 fail (out of 8)**.

Wrangler dev hot-reloaded the src changes via its watch mode after
each commit (`Reloading local server… Local server updated and ready`
visible in /tmp/wrangler-x526b.log). No restart needed.


## Phase E — Audit

`audit/probes/x526b/AUDIT-SUMMARY.md` shipped. Highlights:

- **X.5-26b run-all: 8/8 PASS** (3 functional + 2 regression + 3 e2e =
  66 sub-asserts, 0 fail).
- **tsc clean: 2 baseline errors only** (esbuild-wasm, SqliteVFSProvider —
  match prior X5M3/Z5 baselines exactly).
- **Cross-wave run-alls: 13/16 PASS.** 3 failures all pre-existing
  (verified against pristine main HEAD `23417c5` from the original
  worktree). Failures: `w3` (shim gaps fixed in W3.5+ but W3's
  expectations frozen), `w3.5` (same), `x5z5-build/e2e/tailwindcss-vite`
  (in-process fixture path bypasses supervisor's REJECT_INSTALL — the
  matching real-install x526b probe is GREEN).
- **Single-resolver invariant: PASS.**
- **Install-pipeline-coverage shim: PASS** (soft-skip path; covered
  by x526b's own e2e probes which use the real install pipeline).
- **Mossaic prod: PASS** (eb316dc deploy still healthy; x526b is
  not yet deployed).
- **Anti-req compliance: 5/5** forbidden files untouched; 2 data-only
  files modified (registry + preamble mirror).
- **Net delta: +2 healthy classifier flips** (oxide direct +
  tailwindcss-vite transitive); +0 strict-✅ flips (criterion
  documented unreachable per anti-req).


## Phase F — Push

(Pushed per phase: Phase A `167f62c`, Phase B `0adbd47`, Phase C
`678afda`, Phase D commits `a7ab5f3` + `896c2f0` + `bba193b`,
Phase E `d4c611d`. Final retro commit pushed in Phase G.)

## Phase G — Retro

`audit/sections/X526b-retro.md` shipped. Captures:
  - Per-package verdict (ts-jest deferred, oxide + tailwindcss-vite
    flipped ⚠→⛔, lightningcss flipped ⚠→⛔ out-of-cohort).
  - Architecture rationale (cap-fix hypothesis disproved → REJECT_INSTALL
    pivot per X.5-Z5c/Z5d already-planned pattern).
  - Strict-✅ unreachability (3/3 dispatched pkgs structurally
    out of strict-✅ reach within anti-req).
  - Deviations from dispatch (architecture pivot, synth-9MiB probe
    skipped, lightningcss out-of-cohort honesty, e2e assertion correction
    for transitive reject single-line shape).
  - What worked (investigation-first cadence, REJECT_INSTALL data-only
    pattern, preamble-mirror invariant probe, setsid for wrangler dev,
    wrangler hot-reload across commits).
  - What didn't (criterion mismatch with anti-req, x5z5-build/e2e
    fixture-path artifact).
  - Files touched: 32 LOC src/ delta across 2 files; 13 audit files
    (probes + plan + retro + progress + audit summary).
  - Recommendations: re-baseline 33-pkg cohort, dispatch X.5-Z5e for
    ts-jest realpathSync, x5z5-build e2e cleanup, VERIFY-23417C5 §4 #2
    correction.

7 phases A-G complete.

