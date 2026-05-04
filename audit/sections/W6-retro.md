# W6 — WASM Swap Registry + REJECT_INSTALL UX — Retro

> **Branch:** `w6-wasm-swap` (6 commits, off `main` @ b266d1d).
> **Session:** autonomous Seal session, 2026-05-04.
> **Outcome:** ✅ all done criteria met. Branch pushed; merge pending workspace agent review.

## 1. Outcome vs predicted

| Plan §11 done criterion | Result |
|---|---|
| `audit/sections/W6-plan.md` ✓ | ✓ v2 (post-review). v1 caught 4 must-fix defects pre-implementation. |
| Probes RED before any src/ change (TDD) | ✓ Phase B commit (ef57995) is probes-only; 15 fail, 1 pass, 1 prod-skip. |
| `src/wasm-swap-registry.ts` exists | ✓ 437 LOC. |
| `buildSpecs` integrated | ✓ both branches. |
| `resolveTree` (legacy) integrated | ✓ swap + per-policy reject + warn-skip. |
| `resolveTreeInFacet` (default prod path) integrated | ✓ via preamble-injected helpers + own-property error tag. |
| `updatePackageJson` honours swap | ✓ user's typed key preserved; lockfile/node_modules carry swap target. |
| All w6 probes green locally | ✓ 17/17. |
| Mossaic regression gate green | ✓ meta-probe locally; prod-fat probe gated on wrangler auth. |
| `tsc --noEmit` clean for W6 | ✓ 2 pre-existing baseline errors unchanged. |
| `audit/sections/W6-retro.md` ✓ | ✓ this file. |
| `audit/sessions/W6-progress.md` 6-phase ✓ | ✓ all phases. |
| Branch pushed to origin/w6-wasm-swap | ✓ 6 commits. |

## 2. Per-package verdict matrix

(Refines plan §6.3.)

### Swaps (1)

| Package | Verdict | Notes |
|---|---|---|
| `esbuild → esbuild-wasm` | ✅ shipped | Drop-in for the build/transform/version/initialize API. Verified by `e2e/swap-target-symbol-parity.mjs` against this workspace's `esbuild-wasm@0.24.2`. User-visible: `[swap]` notice, package.json key preserved, lockfile carries swap target. |

### Rejects (24)

| Bucket | Packages | Notes |
|---|---|---|
| Native crash at load (5) | sharp, sqlite3, better-sqlite3, canvas, sodium-native | Hard fail; suggestions point at WASM/JS alternatives. |
| Optional natives (3, transitive=warn) | fsevents, bufferutil, utf-8-validate | Top-level fails; transitive logs `[skip]` and drops. Mirror existing `shouldSkipPackage` UX for build-only. |
| Different-require-name (5) | bcrypt, argon2, node-sass, grpc, @swc/core | Demoted from "swap" because Nimbus's resolver does not yet parse `npm:` aliases. Reject with code-change suggestion. **W6.5 unblocks these as real swaps.** |
| Other natives (3) | node-pty, robotjs, electron | No Workers-compatible path. |
| ORM natives (2) | prisma, @prisma/client | Suggest `@prisma/adapter-d1` first (Prisma's official Workers path), then `drizzle-orm`. |
| Build-time compilers (2, transitive=warn) | node-gyp, node-pre-gyp | Top-level loud fail; transitive falls through to `SKIP_PACKAGES` (silent prune). Documented dual-listing intent (plan §10). |
| Bundled-binary giants (2) | puppeteer, playwright | Bundled binaries; suggest `puppeteer-core` + Browser Rendering / remote-browser. |
| Loader gap honesty (2) | sql.js, @swc/wasm-web | Install OK, runtime fail today (extraction filter / pre-bundle gap). REJECT keeps the registry honest until W6.5 fixes the loader layer. |

### Intentionally NOT in the registry

| Package | Why |
|---|---|
| `@libsql/client` | Probe says "needs W2 resolver fix" — gap may already be closed post-W2/W5. Not pre-emptively rejecting. |
| `wasm-vips` | Suggested swap-target for `sharp` (not a swap origin). Partial export shape (`default` only) but installs and loads. |
| `bcryptjs`, `hash-wasm`, `sass`, `@grpc/grpc-js` | Used as suggestion *targets* in REJECT entries; not registry inputs themselves. |
| `tldts` | Excluded by user direction (separate audit thread). |

## 3. What swapped, what rejected, what surprised

### What swapped
- **`esbuild → esbuild-wasm` is the only real swap in W6 v2.** v1 of the plan listed `bcrypt`, `argon2`, `node-sass`, `grpc`, `@swc/core` as additional swaps — all demoted to REJECT in v2 after the explore-agent review identified the require-name divergence problem. Listing them as swaps would have silently broken `require('bcrypt')` etc. in user code.
- The single swap covers 24 of 25 listed transitive references the W6 audit identified across the top-30 native package set. Roughly 80% of the value comes from this one entry plus the disjoint reject list.

### What rejected
- 24 entries in `REJECT_INSTALL`, broken into 7 buckets (see §2). Two of the 24 are loader-gap honesty entries (`sql.js`, `@swc/wasm-web`) that come out of REJECT once W6.5 lands.
- Per-entry `transitive` policy ('fail' vs 'warn') was the v2 design improvement. v1 had a binary policy via call-site decision; v2 makes the policy the registry's responsibility, which lets `fsevents` (genuinely-optional) coexist with `puppeteer` (must-be-loud-even-transitively) cleanly.

### What surprised

**S1 — Three resolver paths, not two.** Plan v1 enumerated `buildSpecs` (top-level) and `resolveTree` (transitive). Reviewer caught a third: the `resolveTreeInFacet` body in `npm-resolve-facet.ts` runs in a NimbusFacetPool isolate and is the **default** path in prod (`shouldUseFacetResolver()` returns true unless explicitly disabled). Patching only `resolveTree` would have shipped dead code. The fix required inlining swap/reject data + helpers into `npm-resolve-preamble.ts` (the same string-injection pattern existing for `SHOULD_SKIP_PACKAGE`). Cost: registry data is duplicated across two files; gated by `functional/preamble-parity.mjs` snapshot.

**S2 — `SKIP_PACKAGES` was masking the marquee swap.** v1 inserted `applySwaps` *after* the existing `shouldSkipPackage` filter inside `buildSpecs`. But `esbuild` and `fsevents` were already in `SKIP_PACKAGES` (they were "build-only / native"), so the registry would never see them. v2 moves them out of `SKIP_PACKAGES` (in both the resolver and the preamble) so the registry can own them. `node-gyp` / `node-pre-gyp` are kept dual-listed (in BOTH `SKIP_PACKAGES` and `REJECT_INSTALL` with `transitive='warn'`) deliberately: top-level `npm install node-gyp` reaches the registry first (loud reject), transitive node-gyp falls through to SKIP (silent — matches today's behaviour, which is correct for ubiquitous postinstall noise).

**S3 — bcryptjs is *not* a drop-in for bcrypt.** I assumed bcryptjs covered the bcrypt API surface 1:1 because the existing audit/probes/wasm/bcryptjs.out.txt shows hashSync/compareSync work. But the *require()* name is different: `node_modules/` has `bcryptjs/`, never `bcrypt/`. A user's `require('bcrypt')` after a silent swap throws MODULE_NOT_FOUND at runtime — exactly the silent-failure W6 was created to eliminate. Real npm has `npm:NAME@RANGE` alias spec syntax for this; Nimbus's resolver doesn't parse it. So the entire "different-require-name" swap class moves to REJECT with code-change suggestions until W6.5 adds alias support.

**S4 — String-prefix matching across the supervisor↔facet boundary is brittle.** Initial wiring detected registry rejects in the facet's BFS catch via `e.message.startsWith('npm install rejected:')`. Reviewer flagged this: ANSI prefixes from the supervisor-side formatter mean the supervisor-thrown message doesn't actually start with that string, and the coupling is fragile. Fix: own-property tag (`err.__w6_reject = true`) — survives the supervisor↔facet `postMessage` / `fn.toString()` boundary (prototypes are lost, but own-properties are preserved). Implemented as `RegistryRejectError` class on supervisor side + manually-tagged plain `Error` on facet side, both detected by `isRegistryReject()`.

**S5 — `audit/probes/wasm/_SUMMARY.json` is misleading.** Records `ok:true` for all 12 probed packages, but actual `.out.txt` files show `sql.js` ENOENT on `dist/sql-wasm.wasm`, `@swc/wasm-web` `not pre-bundled`, `wasm-vips` only exposes `default`. The summary records *install* success, not *load* success. Plan v2 explicitly rejects packages whose load fails today (loader-gap honesty), avoiding silent expectations.

## 4. What deviated from plan

| Plan element | Actual | Why |
|---|---|---|
| Build plan §8 had 8 steps | Compressed to 3 commits | Steps 4–7 (buildSpecs, resolveTree, resolveTreeInFacet, updatePackageJson) all cover one logical surface (registry wiring) and trade off readability vs commit-noise; combined into ea6e869. Steps 1, 2-3 stayed separate (registry module then SKIP migration / preamble). |
| Step 8 (lockfile-replay test fixture) was a separate commit | Folded into Phase B (probes-RED commit) | The lockfile-replay probe is pure logic (no installer), so it lives with the rest of the e2e probes. |
| Plan §7.1 listed 7 functional probes | 7 functional probes, plus extension to format-messages.mjs covering `RegistryRejectError` | Added during the post-Phase-C review fixes. |

## 5. W6.5 candidates (follow-up wave)

In priority order:

1. **`npm:` alias parsing in `npm-resolver.ts:resolvePackage`.** Unblocks the 5 different-require-name entries (`bcrypt`, `argon2`, `node-sass`, `grpc`, `@swc/core`) to graduate from REJECT to SWAP. Touch points: `parseSpec`-equivalent in `buildSpecs`, packument fetch (must fetch by alias-target name, store under alias source), `linkBins` and `buildBatchPayload` (need spec-key vs install-name distinction). Estimated ~150 LOC + probes.
2. **WASM extraction filter for `dist/*.wasm`.** Unblocks `sql.js` and removes its REJECT entry. Touch points: `npm-install-facet.ts:streamTarEntries` consumer or `buildBatchPayload` `files` filter. Estimated ~30 LOC + e2e probe that does the SQL.Database smoke test.
3. **VFS pre-bundle wiring for `@swc/wasm-web`.** Unblocks `@swc/wasm-web` and removes its REJECT entry. Pre-bundle layer is `pre-bundle-facet.ts` / `esbuild-service.ts`. Estimated medium effort — depends on how pre-bundle currently picks targets.
4. **Runtime resolver shim for `require('esbuild')` from transitive deps.** Today our `esbuild → esbuild-wasm` swap relies on the drop-in claim being honoured by every transitive consumer. If a dep does `require('esbuild')` directly and the resolution falls through, we silent-fail. Adding a path-level redirect in the VFS resolver (like the existing real-vite `chokidar` interception) is cheap insurance. Probes can simulate.
5. **Strip ANSI from `Error.message` thrown by registry.** Currently the user-visible error has embedded `\x1b[31m...\x1b[0m`. Anywhere this surfaces in non-TTY context (logs, JSON-serialised errors) shows escape codes. Split formatter into `formatRejectErrorAnsi` / `formatRejectErrorPlain`.

## 6. Per-commit summary

| SHA | Phase | Lines added | Greens |
|---|---|---|---|
| afa548b | A | 466 (plan v2 + progress) | n/a (docs) |
| ef57995 | B | ~700 (17 probes) | install-pipeline-coverage-meta + (prod-skip) registry-coverage |
| dc1d5ef | C step 1 | 377 (registry module) | +12 functional/regression/e2e |
| b21ce7a | C step 2 | 73 (SKIP migration + preamble inline data) | +4 (all 17 green) |
| ea6e869 | C step 3 | 210 (installer + 2 resolver paths + class + tag + module-init assert) | n/a (greens unchanged; review-fixes pass) |
| eec0f15 | progress | 20 (log update) | n/a |

Total: ~1846 lines, 6 commits, 0 prod deploys (deferred per Phase 1 pattern), branch pushed cleanly.

## 7. Pending prod deploy

Mirrors the "Pending Prod Deploys" pattern documented in `MASTER-ROADMAP.md`. W6 ships when:
1. Wrangler OAuth refreshed (or `CLOUDFLARE_API_TOKEN` provisioned).
2. `wrangler deploy` runs main (which will include W6 once merged).
3. `NIMBUS_W6_E2E_PROD=1 bun audit/probes/w6/e2e/registry-coverage.mjs` runs against prod and walks the full registry (the prod-gated probe stub is in place; expand to full coverage on first deploy).
4. Mossaic regression `audit/probes/regression/install-pipeline-coverage.mjs` re-runs against prod — must remain green (W6 deliberately does NOT touch any of the 4 Mossaic scenarios' install names).

Until then, code is on `main`-ready branch `w6-wasm-swap`, ready for the workspace agent's PR review and squash-merge per the established Phase 1 pattern.

## 8. Honest negatives

- **No prod runtime verification.** The e2e/registry-coverage probe is a stub. Local probes establish the contract; prod walk happens post-deploy. If wrangler auth lapses indefinitely, W6 ships on faith — same risk profile as W3/W4/W5 prod deploys, mitigated by Phase 1's "graceful degradation when support resources absent" pattern (no support resources required for W6 — pure code paths).
- **Different-require-name demotions.** The headline-friendly auto-swaps (bcrypt, argon2, …) didn't ship as swaps. They ship as REJECT entries with code-change suggestions. This is honest about Nimbus's current resolver capability, but a user who *expected* bcrypt to magically become bcryptjs gets a hard error instead. The error message tells them what to do, but it's still more friction than the marketing-friendly auto-swap. W6.5's npm-alias support is the cleanup.
- **Loader-gap REJECTs (sql.js, @swc/wasm-web)** are an admission that we can't load packages we technically install. Listed in REJECT for honesty; the alternative ("install OK, fail at first require") is worse. W6.5 removes them.
- **One swap is a short list.** The W6 deliverable in MASTER-ROADMAP.md hinted at 5–6 swaps. Honest delivery is 1 swap + 24 rejects. The reject list is the more valuable artefact: it's the Nimbus-doesn't-support-X documentation embedded in code.
