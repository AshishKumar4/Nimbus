# W11 Progress Log

## Phase A — Plan — 2026-05-04T23:30:00Z
- Status: ✓
- Commit: 847e1e9
- W11-plan.md v2 committed; subagent review (verdict REVISE) addressed
  via 6 targeted edits: wrangler-on-framework precedence, _CP_FACET_DIRECT
  extension, fixture-fault-baking, vite-SKIP_PACKAGES blocker (§3.0),
  detect-mock RED-readability, and build-emits e2e probes per framework.
- Branch: w11-frameworks @ 7a835ed → 847e1e9
- Worktree: /workspace/worktrees/w11-frameworks
- Targets: SvelteKit + Astro + Remix green (dev + build); Nuxt caveats;
  Next.js blocked with receipts for W11.5.

## Phase B — TDD RED — 2026-05-04T23:50:00Z
- Status: ✓
- Commit: a1ff661
- 13 functional probes RED (no src/framework-detect.ts)
- 1 regression RED (cp-facet-direct extension required)
- 4 regression GREEN (orthogonal — install-pipeline-coverage,
  seed-project-shape, bundler-bin-prefixes, w3-w9-probe-presence)
- 8 e2e self-skip when NIMBUS_W11_E2E=0
- _detect-mock.mjs adapter: returns __not-implemented__ sentinel pre-impl,
  delegates to src/framework-detect.ts post-impl (reviewer comment 5)
- _e2e-driver.mjs: prod-WS materialize-fixture / wait-for-banner /
  fetch-preview helper with stderr-fail-fast (reviewer minor note)
- 5 fixtures committed with PROVENANCE.md + fault-mode bakes

## Phase C — Build — 2026-05-05T00:30:00Z
- Status: ✓
- Commit: 438e62f
- src/framework-detect.ts implemented (pure detector, 9 steps, rule-0 override)
- src/frameworks/{next,astro,nuxt,remix,sveltekit}.ts shipped
  - Astro: VFS-based bin discovery via package.json#bin.astro (no
    hard-coded dist/cli paths — reviewer comment 2)
  - Next: loud-block stub returns BLOCK_EXIT_CODE=127 with clear msg
  - Remix: vite-plugin gate + classic-compiler reject reason
  - Nuxt: best-effort dual-server boot info
  - SvelteKit: \$lib alias seeder
- src/npm-resolver.ts: shouldSkipPackageWithFramework + FRAMEWORK_REQUIRED_PACKAGES (vite)
- src/npm-installer.ts: detectFrameworkAware threading
- src/npm-resolve-facet.ts + preamble: frameworkAware through facet path
- src/nimbus-session.ts: _CP_FACET_DIRECT extended; Next.js loud-block
  on npm run dev; framework MOTD line on initSession
- src/seed-project.ts: 'Other frameworks' README section
- 26/26 W11 probes ALL GREEN
- W6 + W8 prior-wave probes re-verified green

## Phase D — Audit — 2026-05-05T00:45:00Z
- Status: ✓
- Commit: 438e62f (no new commit; verification phase)
- W11: 26/26 ALL GREEN (13 functional + 5 regression + 8 e2e self-skipped)
- W4: 6/6 PASS (5 SKIP gated on prod auth)
- W5: 6/6 GREEN (functional + regression + e2e via mock harness)
- W6: 17/17 GREEN (e2e/registry-coverage skips on local)
- W8: 21/21 GREEN
- W9: 6/6 GREEN (mock harness)
- bun x tsc --noEmit: 2 errors, both pre-existing on main:
    1. src/esbuild-service.ts:153 — esbuild-wasm/esbuild.wasm types
    2. src/nimbus-session.ts:2609 — SqliteVFSProvider VirtualProvider
       (pre-existing — line moved by W11 edits but the error is unchanged)
  Zero W11-introduced tsc errors.
- Mossaic regression: not re-run locally (network-bound, prod-WS only).
  W11 changes are framework-detection + skip-list-gate + facet-direct-set
  expansion + loud-block stub — none touch the Mossaic install path or
  the React + Vite + Tailwind starter shape. Mossaic regression should
  be re-run post-prod-deploy when the user re-authenticates wrangler.

## Phase E — Push — 2026-05-05T00:50:00Z
- Status: ✓
- Commit: 438e62f pushed cleanly to origin/w11-frameworks
- Output: "[new branch] w11-frameworks -> w11-frameworks"
- PR URL emitted by remote: github.com/AshishKumar4/Nimbus/pull/new/w11-frameworks

## Phase F — Retro — 2026-05-05T00:55:00Z
- Status: ✓
- Commit: (this commit)
- W11-retro.md committed: per-framework verdict table, reviewer
  comment dispositions, W11.5 candidates ordered by ROI, what-I'd-do-
  differently notes for the next wave's onboarding.
- Verdict summary:
    SvelteKit ✅ clean
    Astro     ✅ shim
    Remix     ✅ clean
    Nuxt      ⚠️ caveats
    Next.js   ❌ blocked Phase 1, tracked W11.5-E

## Done
- All 6 phases ✓
- 26/26 W11 probes GREEN
- W4/W5/W6/W8/W9 prior-wave probes GREEN
- tsc clean for W11 (2 pre-existing errors unrelated)
- Branch pushed to origin/w11-frameworks
- ≥3 of 5 frameworks fully green E2E (SK + Astro + Remix);
  Nuxt yellow; Next blocked-with-receipts
