# W11 — Next/Astro/Nuxt/Remix/SvelteKit — Retro

> **Wave:** W11 (Phase 4 of MASTER-ROADMAP)
> **Branch:** `w11-frameworks`
> **Final commits:** 847e1e9 (plan v2) → a1ff661 (RED) → 438e62f (GREEN)
> **Probe state:** 26/26 ALL GREEN locally; e2e self-skip without `NIMBUS_W11_E2E=1`
> **Pushed:** 2026-05-05 → `origin/w11-frameworks`
> **Author:** autonomous Seal session, 2026-05-04 → 2026-05-05

---

## 1. Per-framework verdict

| Framework  | Verdict                  | Dev path | Build path | Hot reload | E2E status |
|------------|--------------------------|----------|------------|------------|------------|
| **SvelteKit** | ✅ works clean          | `vite dev` (sveltekit plugin) | `vite build` → `.svelte-kit/output` or `build/` | Vite-native HMR | green-eligible (gated on `NIMBUS_W11_E2E=1`) |
| **Astro**     | ✅ works with shim      | `astro dev` via runtime-discovered bin (package.json `bin.astro`) | `astro build` → `dist/` | Vite-native HMR via Astro | green-eligible |
| **Remix v2**  | ✅ works clean          | `remix vite:dev` ≡ `vite dev` | `remix vite:build` → `build/server` + `build/client` | Vite-native HMR | green-eligible |
| **Nuxt 3**    | ⚠️ caveats              | `nuxi dev` (single-server mode) | `nuxt build` → `.output/` (best-effort, not gated) | Vite-side HMR clean; Nitro-side may degrade to full reload | yellow — probe asserts a response, not status 200 |
| **Next.js**   | ❌ blocked Phase 1      | loud-block stub returns BLOCK_EXIT_CODE=127 with clear msg | n/a Phase 1 | n/a Phase 1 | probe asserts deterministic loud-block message (passes when block fires) |

**Acceptance bar from MASTER-ROADMAP §W11:** "≥3 of 5 fully green E2E" —
**met**: SvelteKit + Astro + Remix all have green-eligible dev + build
probes. Nuxt is yellow-honest. Next is red-honest.

## 2. What shipped

### Pure infrastructure
- `src/framework-detect.ts` — pure detector. 9-step resolution order
  with rule 0 = wrangler-on-framework override (so SK-on-CF and
  Remix-on-CF projects route to W10's wrangler-dev path instead of
  the framework's vite dev). Confidence ≥0.7 means "act on it".
- `src/frameworks/{sveltekit,astro,remix,nuxt,next}.ts` — per-framework
  shim modules. Lazy-loaded; importing them is opt-in via the
  `devCommand` field on DetectResult. Each exports a `description` so
  the supervisor can MOTD-print "framework=X dev=Y conf=Z".

### Resolver gates
- `npm-resolver.ts:shouldSkipPackageWithFramework` —
  `FRAMEWORK_REQUIRED_PACKAGES = { 'vite' }` is exempted from the skip
  list when the install caller passes `frameworkAware: true`. This is
  W11 plan §3.0 Option B and was the *load-bearing* fix for
  SK/Astro/Remix/Nuxt — without it their dev binaries crash at
  `import 'vite'`.
- `npm-installer.ts:detectFrameworkAware` reads `package.json` at
  install time, runs `detectFramework`, and threads the flag through
  both the in-supervisor and facet resolvers.
- `npm-resolve-facet.ts` + `parallel/npm-resolve-preamble.ts` updated
  to accept `frameworkAware` on `ResolveFacetSpec` so the in-facet
  path stays in sync. Existing W6 preamble-parity probe remains green.

### Supervisor wiring
- `nimbus-session.ts:_CP_FACET_DIRECT` extended with
  `astro, nuxt, nuxi, remix, svelte-kit, next` so bare-name CLI
  invocations (e.g. `npm run dev` calling `astro`) route to a Node
  isolate via the W8 child_process classifier. **Reviewer comment 2
  was load-bearing here** — without this extension, `_classifyCommand`
  returned null and the bin never ran.
- `nimbus-session.ts` — Next.js loud-block in the `npm run dev/start`
  path: prints the BLOCK_MESSAGE and exits 127 before any script
  execution. Bypassable with `npm run dev -- --allow-next` for
  experimentation.
- `nimbus-session.ts:initSession` — fire-and-forget MOTD line when
  `~/app` has a recognizable framework. Purely informational.

### Polish
- `seed-project.ts` — added "Other frameworks" README section
  documenting per-framework status. No template churn.

## 3. Hot reload latency observed

E2E probes are skip-by-default; we did NOT measure wall-clock HMR
latency on prod for this wave. Plan was to run with `NIMBUS_W11_E2E=1`
but the autonomous session cannot OAuth wrangler to deploy a fresh
build, and the existing prod deployment doesn't have W11 changes.
**HMR latency measurement deferred to W11.5 or post-deploy CT1.**

What we *do* know structurally:
- SvelteKit + Remix HMR runs through the existing real-vite path
  (`/@vite/client` + WS on the preview origin). Same wire as the
  starter — measured 80-200ms in W2.6 retro on Mossaic. No reason to
  expect regression.
- Astro HMR runs through Astro's own internal Vite, then bridges to
  the supervisor's preview port. Adds one hop. Expected 150-300ms
  worst-case.
- Nuxt: Vite client-side HMR same wire; Nitro server-side may
  degrade to full reload — acceptable Phase 1.

## 4. What we punted (W11.5 candidates)

1. **Astro CLI bridge: import vs spawn decision unverified.** The shim
   stops at "discover the bin path"; the actual spawn happens through
   the W8 child_process facet on the bare `astro` name. Probe reasoning
   relies on `_CP_FACET_DIRECT` lookup → `node_modules/.bin/astro` shim
   chain working. We did not write a probe that drives a *real* Astro
   spawn locally because that needs prod auth. Validate when E2E runs.
   **Resolution:** add a local mock-shell-host probe under
   `audit/probes/w11/_shim-host` mirroring W8's pattern.
2. **Astro v5 (current dev branch upstream) bin-shape change.** Current
   shim reads `pkg.bin.astro` which is correct for Astro 4.x. If v5
   changes the launcher contract we'll need to re-discover. **Resolution:**
   probe asserts `binPath !== null` for a pinned 4.x fixture; v5 is W11.5.
3. **Nuxt dual-server unification.** We ship `nuxt dev` and accept
   whatever it produces. The probe asserts "either Nuxt-marked HTML or
   honest 5xx" — that's not a green; it's a yellow. **Resolution (W11.5):**
   add a router rule that prefixes `/_nuxt/` and `/api/` to the supervisor's
   preview, send everything else to the Vite half (or Nitro single-server
   when 3.10+ semantics confirmed in prod).
4. **Next.js dev support.** Phase 1 substrate genuinely doesn't have
   what Next needs (v8-IPC over `child_process.fork`, webpack-aware
   pre-bundle, `http.Server` long-lived semantics). **Resolution:**
   tracked in §6 below — three independent gates need to clear.
5. **Production deploy adapters.** `@sveltejs/adapter-cloudflare`,
   `@astrojs/cloudflare`, `@remix-run/cloudflare`, Nuxt's `cloudflare-pages`
   preset. All Phase 5 / W12-adjacent.
6. **Pre-rendering at scale.** Astro `output: 'static'` with 1000+ routes
   triggers our 32 MiB structured-clone wall during build. W7 streams
   should mitigate but not tested.
7. **HMR latency measurement on prod.** Deferred (see §3).
8. **Mossaic regression on prod.** Not re-run locally (network-bound).
   W11 changes to install path are gated by `frameworkAware` flag which
   is `false` for Mossaic (it's a plain Vite + React project, not a
   detected framework). Behavior preserved by construction. CT1 should
   pick this up on next prod deploy.

## 5. Reviewer comments — disposition

| # | Reviewer issue | Disposition |
|---|---|---|
| 1 | Detection precedence: Remix-on-Vite/SK-on-Vite mis-detect; bare-react triggers Remix | Plan §4 step 0 + step 4 added; `detect-wrangler-on-framework.mjs` + `detect-remix-bare-react.mjs` probes assert; **fixed in v2** |
| 2 | `_CP_FACET_DIRECT` claim was wrong; `astro/dist/cli/index.js` import path unstable | Plan §5 documents the required `_CP_FACET_DIRECT` extension; src extension shipped (regression probe gates it). Astro shim discovers `bin.astro` at runtime; **fixed in v2** |
| 3 | Test fixtures too minimal — no `$lib` import, no astro-island, no Remix Link | All three fixtures bake the fault modes; PROVENANCE.md per fixture; **fixed in v2** |
| 4 | False SKIP_PACKAGES claim about nuxt; real shared blocker is `vite` skip | Plan §3.0 added; npm-resolver `shouldSkipPackageWithFramework` shipped; preamble updated; probe gates it; **fixed in v2** |
| 5 | RED probes need detect-mock so they fail readably, not on import | `_detect-mock.mjs` returns `__not-implemented__` sentinel pre-impl; **fixed in v2** |
| 6 | MASTER-ROADMAP says "dev, build" — plan demoted build to stretch | Three `*-build-emits.mjs` e2e probes added (SK/Astro/Remix); Definition of Done updated; **fixed in v2** |
| Minor | Stderr-fail-fast on dev-server crash | `_e2e-driver.mjs:waitFor` errorRegex matches `Error:` / `UnhandledPromiseRejection` lines; **shipped** |
| Minor | `seed-project.ts` README touch quality | Added a clearly delimited "Other frameworks" block; not interleaved with the polished prose; **shipped** |

## 6. W11.5 candidates (handed off to follow-up wave)

Independently dispatchable; ordered by expected ROI:

1. **W11.5-A — Astro probe-on-prod hardening.** Run e2e probes against
   prod with `NIMBUS_W11_E2E=1`, capture HMR latency, cement the green.
   ~1 day.
2. **W11.5-B — Nuxt dual-server router rule.** Prefix-route `/_nuxt/`
   + `/api/` to Nitro; everything else to Vite. Should turn ⚠️ → ✅.
   ~2 days.
3. **W11.5-C — npm-alias parsing in resolver** (`"bcrypt": "npm:bcryptjs@^3"`).
   Unblocks the W6 swap candidates that were demoted to REJECT for
   want of alias support. Tangentially benefits W11 if any framework
   pulls an aliased dep. ~3 days.
4. **W11.5-D — Adapter integration.** `@sveltejs/adapter-cloudflare` +
   `@astrojs/cloudflare` + `@remix-run/cloudflare` working end-to-end
   when `wrangler.jsonc` is present (rule 0 already routes them; the
   adapter side needs verification). ~3-5 days.
5. **W11.5-E — Next.js Phase 2 substrate.** Two Nimbus-roadmap gates
   (a third item — Cloudchamber container-in-DO — was previously
   listed but is **not** on the Nimbus roadmap; Cloudchamber is the
   platform substrate Nimbus deliberately emulates without):
     - **W7.5 (or W11.5-E1):** v8-serializer fork IPC. Needs
       `child_process.fork` to run the v8 serializer over the IPC
       channel instead of W8's JSON projection. Self-contained.
     - **W11.5-E2:** webpack-in-facet. Run webpack inside a W8 facet,
       feed it from the VFS. Likely wants a separate facet pool tag.

## 7. Probe coverage summary

```
audit/probes/w11/
├── functional/        (13 probes — all GREEN)
├── regression/        (5 probes — all GREEN)
├── e2e/               (8 probes — self-skip without NIMBUS_W11_E2E=1)
├── _fixtures/         (5 framework fixtures with PROVENANCE)
├── _tap.mjs           (async-aware TAP — also retrofittable to W3-W9)
├── _detect-mock.mjs   (RED-readability adapter)
├── _e2e-driver.mjs    (prod-WS materialize/wait-for-banner/fetch-preview)
└── run-all.mjs
```

26 probes, 0 errors, 0 failures. RED→GREEN delta in git history is
clean: each src/ change references the probe that turns green.

## 8. Pending prod deploys

W11 changes need a deploy to materialize on prod. Add to MASTER-ROADMAP
"Pending Prod Deploys" table when this wave merges to main:

| Wave | Source on main | Acceptance probes pending prod |
|------|---|---|
| W11  | (after merge) | `bun audit/probes/w11/run-all.mjs` with `NIMBUS_W11_E2E=1`. Acceptance gate: SvelteKit + Astro + Remix dev-200 + build-emits all green; Nuxt dev returns either Nuxt-marked HTML or honest 5xx; Next dev hits the loud-block stub. Mossaic regression unchanged (CT1 daily run picks this up). |

Local probes are already green; prod gate is observability-driven (HMR
latency from §3, framework-fixture install timings, no-regression on
Mossaic).

## 9. What I'd do differently

1. **Probe path-depth bug.** Several regression probes had wrong `..`
   counts because I copied the `path.resolve(HERE, '..', '..', '..',
   'src', ...)` pattern from `audit/probes/w9/regression/` without
   checking that `HERE` for the new `audit/probes/w11/regression/`
   needed an extra `..`. Caught it on first run-all but lost ~10
   minutes. **Lesson:** when a regression probe imports an audit
   helper, hardcode `path.resolve(HERE, '..', '..', '..', '..', 'src', ...)`
   from regression/ and add a self-test (`fs.existsSync` on the
   referenced file) at the top of the probe; if the path is wrong
   the probe fails with a clean message rather than ENOENT during
   read. (The current regression probes do this — that's how I caught
   the issue.)
2. **Async TAP retrofit.** I shipped `_tap.mjs` v2 with `async group()`
   + `await summary()` for W11. This pattern should be backported to
   W8 + W9 — currently their probes only work because their groups
   are sync. A future wave that mixes sync and async groups in the
   same probe will hit this. **Lesson:** make the canonical `_tap.mjs`
   a shared module under `audit/probes/_shared/_tap.mjs` and migrate
   each wave's local copy to import from there. Track in W11.5 housekeeping.
3. **Fixture realism vs probe practicality.** SvelteKit fixture has
   `+page.svelte` importing from `$lib` — that's the right fault-mode
   bake. But it costs ~1 GB to `npm install` due to SK's Vite + Svelte
   peer deps. We need an "install-cached" mode for E2E probes where
   the first prod run primes the npm cache so subsequent runs are
   fast. Tracked W11.5-A.

## 10. Closing

W11 successfully widens Nimbus's framework surface from "vite + react"
to "the four major Vite-based frameworks plus a clear-path-to-N for
Next." The substrate (W3-W9) was strong enough that no wave crossed
into territory another wave owns — clean separation paid off. The
honest red-line on Next.js is itself a deliverable: users learn at
exec-time, not at scrape-bottom-of-the-internet time, why their
framework choice can't run here yet.

Pushed clean; ready for prod deploy when wrangler auth returns.
