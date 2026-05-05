# W11 — Next/Astro/Nuxt/Remix/SvelteKit Framework Completeness — Plan (v2, post-review)

> **Status:** plan v2 committed prior to any src/ change (TDD discipline).
> **Branch:** `w11-frameworks` off `main` @ `7a835ed`.
> **Author:** autonomous Seal session, 2026-05-04.
> **Review:** v1 received an explore-agent review (verdict REVISE) catching
> 6 defects. v2 incorporates all six. v1 preserved in git history.
> **Goal (per MASTER-ROADMAP §W11):** each framework's official starter
> clones, installs, dev-boots, **and builds** end-to-end inside Nimbus.

## 1. Honest scope read

Phase 4 sits *after* the runtime substrate is sound (W3-W9 merged) and
*before* multi-region polish (W12). The job is **not** to make every
framework production-perfect — it's to make `git clone <starter>` →
`npm install` → `npm run dev` → first preview render work for as many
frameworks as we can ship green, and to **document blockers honestly**
for the rest.

Realistic priors going in (from previous audits):

| FW | Prior signal | Where it lives today | Likely outcome |
|---|---|---|---|
| **SvelteKit** | Vite-based; SK plugin runs through Vite | real-vite path is already wired (W2.6+) | **CLEAN** — closest to working today |
| **Astro** | Vite-based dev server, but bundles its own dev binary; uses internal `vite` API + integrations | `astro/dist/index.js` was on the pre-bundle ⚠️ list (02-packages.md row 72) | **CLEAN-with-shim** — astro CLI dispatches to a real-vite child; we proxy that |
| **Nuxt** | Nitro + Vite; binary `nuxi` boots `nuxt dev` which forks workers + Nitro dev server | also pre-bundle ⚠️ | **CAVEATS** — Nitro is the wildcard |
| **Remix** | Vite plugin since v2; `@remix-run/dev` binary `remix vite:dev` is a thin Vite wrapper | `@remix-run/react` was pre-bundle ⚠️ | **CLEAN-with-shim** — same shape as Astro |
| **Next.js** | Custom Turbopack/webpack dev server. NOT Vite. Spawns child processes. | `next` was REJECT-style ⚠️ — `Cannot find module 'next'` post-install. | **BLOCKED on Phase 4 substrate** — needs child_process + custom server runtime. Phase 4.5 candidate. |

Ordering by likelihood of green ✅:
**SvelteKit ≥ Astro ≥ Remix > Nuxt > Next**.

Acceptance bar from spec is "≥3 of 5 fully green E2E"; we plan to land
SvelteKit + Astro + Remix as green, Nuxt with caveats, Next blocked-with-receipts.

## 2. Anti-goals (out of scope for W11)

- **Production deploy targets.** Cloudflare adapter wiring (Astro CF
  adapter, SvelteKit `@sveltejs/adapter-cloudflare`, Next CF runtime,
  Nuxt cloudflare-pages preset, Remix CF adapter) is W11.5 / W12.
- **Framework-specific edge functions.** Server-side handlers / route
  handlers that need full Node `http` semantics. We boot the dev server,
  we render the first page, we verify HMR connects. Per-route SSR
  correctness is W11.5.
- **Pre-rendering at scale / static export.** `npm run build` is stretch
  per framework — we test the build CLI registers and emits, not that
  the dist is actually deployable.
- **Turbopack.** Even when Next isn't blocked, `next dev --turbo` is
  not in scope. We attempt the webpack-based default only.
- **Fixing the 32 MiB wall.** W7 owns that. If a fixture install hits
  the wall, that's a W7 bug not a W11 one — we record it and move on.

## 3. Per-framework spec

### 3.0 Shared blocker — `vite` is in SKIP_PACKAGES

`src/npm-resolver.ts:649-661` skips `vite` during install (because real-vite
is bundled into the supervisor binary). All four green-target frameworks
(SvelteKit, Astro, Remix, Nuxt) `import` from the user's installed `vite`
package to call `createServer({...})` from their own dev binaries — that
import will fail with `Cannot find module 'vite'` because there's no
`node_modules/vite/` on the VFS.

Two options to unblock:

- **Option A (preferred):** add a resolver alias `'vite' →` the bundled
  real-vite module so framework code finds vite on disk-via-resolver
  even though no tarball was extracted. Implementation detail: the
  alias is registered in the inner Node isolate that runs the
  framework CLI, not in the supervisor's own resolution path.
- **Option B (fallback):** remove `vite` from SKIP_PACKAGES when the
  detected framework is one of {sveltekit, astro, remix, nuxt}.
  Costs ~3 MiB extra disk per framework project, but is fully transparent.

The plan ships **Option B** for W11 because it's the least invasive and
removes a class of resolver failures we already understand. We add a
`functional/vite-import-resolves-from-fixture.mjs` probe to assert
`require.resolve('vite')` from inside a fixture's tree returns a valid
VFS path. Option A migration is W11.5.

### 3.1 SvelteKit

**Detection heuristic:**
- `package.json` deps include `@sveltejs/kit` AND/OR `@sveltejs/vite-plugin-svelte`
- Config file: `svelte.config.js` exists
- `vite.config.ts` imports `@sveltejs/kit/vite`

**Boot command + port:**
- `npm run dev` → `vite dev` (SK plugin loads inside Vite). Default port `5173`.

**Known compat issues:**
- `.svelte` SFCs need a Svelte preprocessor to land in the bundle —
  the **real-vite path** runs `vite-plugin-svelte` (already a peer of
  `@sveltejs/kit`), so this works as long as the user has installed deps.
- `real-vite-fs-shim.ts` line 82 already lists `.svelte` and `.astro`
  as known SFC suffixes (they pass through the resolver) — see
  src/real-vite-fs-shim.ts:82.
- Path-alias `$lib` (default `./src/lib`) is established by the SK plugin
  via vite `resolve.alias` — should flow through our existing alias
  parsing in src/nimbus-session.ts:3022 ish (path.resolve patterns).
  ⚠️ open question: does the SK Vite plugin set the alias via a path
  computed at runtime that our regex won't catch? Probe answers it
  (functional/sveltekit-dollar-lib-alias.mjs).

**Hot reload:**
- Vite-based — same HMR transport as the existing real-vite path.
  `/@vite/client` script + WebSocket on the preview origin.

**Test fixture:** `audit/probes/w11/_fixtures/sveltekit-minimal/`
  Pinned, hand-written minimal SK app: `package.json` + `svelte.config.js`
  + `vite.config.js` + `src/routes/+page.svelte` + `src/app.html`
  + `src/lib/greet.ts` + at least one `import { greet } from '$lib/greet'`
  inside `+page.svelte` to actively exercise the `$lib` alias regression.
  PROVENANCE.md pins the upstream commit SHA we mirrored.
  We DON'T pull `create-svelte` at probe time (no network in probes).

---

### 3.2 Astro

**Detection heuristic:**
- `package.json` deps include `astro`
- Config file: `astro.config.{mjs,ts,js}` exists

**Boot command + port:**
- `npm run dev` → `astro dev` (bin: `node_modules/.bin/astro`).
  Astro under the hood spawns a Vite dev server on port `4321` by default.
- Astro's CLI `bin/astro.js` is a tiny launcher that dynamic-imports
  `dist/cli/index.js`; the `dev` subcommand instantiates Vite via
  `createServer({ ... })` from the real `vite` package the project has installed.

**Known compat issues (the audit/sections/02-packages.md ⚠️ blocker):**
- Pre-W2.6, the `astro` package itself was REJECT'd because
  `home/user/app/node_modules/astro/dist/index.js` wasn't pre-bundled
  in the cirrus shim. Cirrus is now bypassed when real-vite is on
  (NIMBUS_REAL_VITE=1 or `nimbusDevServer: 'real'`).
- The blocker post-W2.6 is **Astro's CLI invocation flow**: `astro dev`
  is called as a child via `node_modules/.bin/astro`. We need to either:
  (a) recognize the bin and route to an Astro-aware dev path, OR
  (b) treat `astro dev` exactly like `vite dev` — but pointing at Astro's
      vite config wrapper.
- W11 picks **(a)** — wrap `astro dev` and run it through our facet pool
  (W8 child_process gives us this). The user-installed `astro` package
  loads, we let `createServer()` produce a Vite server on the port,
  and we bridge that port to the supervisor's preview router.
- `@tailwindcss/vite` was on the pre-bundle ⚠️ list. Real cause: it's
  a Vite plugin authored for Vite 6+/Tailwind v4. Most starter projects
  still use Tailwind v3 via PostCSS, so this only bites users on the
  bleeding edge. Document as a known blocker and recommend `tailwindcss@^3`
  for Astro projects on Nimbus until W11.5.

**Hot reload:** Vite-based (shared infra).

**Test fixture:** `audit/probes/w11/_fixtures/astro-minimal/`
  Hand-written Astro app: `package.json` + `astro.config.mjs` (with
  `integrations: [react()]`) + `src/pages/index.astro` + a single
  `<Counter client:load />` island in a `src/components/Counter.tsx`.
  Forces the `<astro-island>` element into the rendered HTML so the
  e2e marker is exercised. Falls back to a doctype-class regex (`<!doctype html>`
  + `data-astro-cid` attr) if the island fails to hydrate. PROVENANCE.md
  pins SHA.

---

### 3.3 Remix

**Detection heuristic:**
- `package.json` deps include `@remix-run/react` AND `@remix-run/node` (or `@remix-run/cloudflare`)
- Config file: `vite.config.ts` imports `@remix-run/dev` (Remix v2 vite plugin)
  — older Remix used `remix.config.js` (classic compiler); we **only**
  support v2 vite-plugin path. Classic compiler is BLOCKED (deprecated upstream too).

**Boot command + port:**
- `npm run dev` → `remix vite:dev` or simply `vite dev`. Default port 3000.
  (The `remix` bin since v2.7 just delegates `vite:dev` to vite.)

**Known compat issues:**
- `@remix-run/react` was pre-bundle ⚠️ pre-W2.6. Same fix path as Astro:
  real-vite reads it from VFS node_modules.
- Remix's vite plugin asks `vite` for the loader/action manifest at
  build time. Should pass through unchanged.
- `react-router-dom` (peer dep) was reported missing — covered by
  the W3 react-router-dom completeness work; recheck via probe.

**Hot reload:** Vite-based.

**Test fixture:** `audit/probes/w11/_fixtures/remix-minimal/`
  Hand-written minimal Remix v2 app with vite plugin: `package.json` +
  `vite.config.ts` (importing `@remix-run/dev`) + `app/root.tsx` +
  `app/routes/_index.tsx` containing at least one `<Link to="/about">`
  to exercise the `react-router-dom` peer-dep recheck. PROVENANCE.md pins SHA.

---

### 3.4 Nuxt

**Detection heuristic:**
- `package.json` deps include `nuxt`
- Config file: `nuxt.config.{ts,js,mjs}` exists

**Boot command + port:**
- `npm run dev` → `nuxi dev` (bin: `node_modules/.bin/nuxt` or `node_modules/.bin/nuxi`).
  Nuxt boots **two** servers internally:
  1. Vite dev server (port 3000 by default; serves the Vue app)
  2. Nitro dev server (h3-based; handles server routes / API)
- The dual-server topology is the wildcard. Inside Nimbus we route a
  single preview origin per session, so we route `/` → Vite, `/api/*`
  and `/_nuxt/*` → Nitro. Or we set Nuxt to **single-server** mode
  where Nitro fronts everything (Nuxt 3.10+ supports `devServer.proxy`
  unification — verify in probe).

**Known compat issues:**
- The shared `vite` SKIP_PACKAGES blocker (§3.0) bites Nuxt the hardest
  because Nuxt also imports `vite` at multiple layers (vite, h3, nitropack,
  unimport). Option B (don't skip when framework is detected) covers it.
- Reviewer note correction: `nuxt` was **not** in SKIP_PACKAGES at any
  point — `vite` and `wrangler` were. The risk for Nuxt is the dual
  Vite + Nitro topology, not a resolver skip.
- `unimport`, `unhead`, `nitropack`, `h3` are key transitive deps. None
  flagged in 02-packages.md but probe needs to verify each resolves.
- Nitro uses `unenv` to swap Node builtins for Workers-compatible ones —
  ironic intersection with our own shim layer. Probe answers whether
  unenv shims fight or harmonize with our `node-shims.ts`.
- `npm run build` (= `nuxi build`) emits a `.output/` Nitro server bundle.
  Stretch goal; document if it works but don't gate on it.

**Hot reload:** Vite for client, Nitro custom-WS for server. We support the
  Vite half cleanly; Nitro server-HMR may degrade to full reload (acceptable).

**Test fixture:** `audit/probes/w11/_fixtures/nuxt-minimal/`
  Hand-written minimal Nuxt 3 app.

---

### 3.5 Next.js

**Detection heuristic:**
- `package.json` deps include `next`
- Config file: `next.config.{js,mjs,ts}` exists

**Boot command + port:**
- `npm run dev` → `next dev` → **custom server** (NOT Vite, NOT esbuild-
  built). Spawns child workers via `child_process.fork`, builds via
  webpack/Turbopack in-process, listens on port 3000.

**Known blockers (we expect this to be RED-with-receipts in W11):**
1. `next` package post-install — entry path resolution. Pre-W2 it was
   "Cannot find module 'next' (from /home/user/app)". Real cause is
   Next's package.json `exports` map (`./package.json`, `./dist/lib/...`)
   that our resolver may handle now (W3) but the CLI bin
   (`node_modules/.bin/next`) may not.
2. `child_process.fork` with IPC. W8 ships `fork` IPC with JSON projection
   — Next uses BSON-ish raw structured data on the IPC channel (via
   v8 serializer). We expect protocol mismatch. Document as Next-blocker A.
3. webpack/Turbopack as the bundler. Webpack works fine inside Node but
   Nimbus's pre-bundle pipeline doesn't know how to feed it; Turbopack
   is a Rust binary, no chance.
4. Server runtime expects long-lived `http.Server.listen()` with
   per-connection `req.socket.setKeepAlive` etc. Our W8 facet child process
   can't fully emulate that — it expects user code to drive the http
   layer, not the framework binary itself.

W11 attempts a Next install + boot probe and **records the first failure
mode honestly** as the gating issue for W11.5. We do NOT spend the wave
hammering it green.

**Test fixture:** `audit/probes/w11/_fixtures/next-minimal/` (recorded
for W11.5 even though we don't expect it to pass).

---

## 4. `src/framework-detect.ts` — design

Single source of truth for "what kind of project is this?". Pure function,
no I/O of its own — takes a parsed `package.json` and a list of files-
present-at-root, returns a discriminated union.

```ts
// src/framework-detect.ts
export type Framework =
  | 'next'
  | 'astro'
  | 'nuxt'
  | 'remix'
  | 'sveltekit'
  | 'vite'         // generic Vite + (React|Vue|Svelte|Solid|...) project
  | 'wrangler'     // CF Workers (W10 owns the runtime path)
  | 'unknown';     // no obvious framework — let `npm run` decide

export interface DetectInput {
  pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string>; };
  files: Set<string>;  // basenames at project root, e.g. {'package.json','vite.config.ts'}
}

export interface DetectResult {
  framework: Framework;
  /** Confidence score 0..1; ≥0.7 means "act on it without asking". */
  confidence: number;
  /** Human-readable reason for the decision (logged to terminal). */
  reason: string;
  /** What the supervisor should treat `npm run dev` as. */
  devCommand: 'vite-real' | 'astro-cli' | 'nuxt-cli' | 'remix-cli' | 'sveltekit-vite' | 'next-cli' | 'wrangler-dev' | 'generic';
}

export function detectFramework(input: DetectInput): DetectResult;
```

**Resolution order (first match wins):**

0. **Wrangler-on-framework override:** if `wrangler.{toml,jsonc,json}`
   at root AND any framework dep present → `framework: <fw>, devCommand: 'wrangler-dev'`.
   The framework's CF adapter is loaded by W10's wrangler-dev path.
   This MUST come first — Remix-on-CF and SvelteKit-on-CF projects have
   both a framework dep AND a wrangler config; without this rule W10's
   path never sees them.
1. `next` in deps → Next
2. `astro` in deps → Astro
3. `nuxt` in deps → Nuxt
4. **Remix gate:** `@remix-run/dev` in deps AND a `vite.config.*` whose
   contents reference `@remix-run/dev` → Remix. Bare `@remix-run/react`
   without `@remix-run/dev` = a React SPA depending on the runtime —
   falls through to step 7. Bare `remix.config.js` = classic compiler
   (deprecated upstream) — falls through with a soft warning.
5. `@sveltejs/kit` in deps → SvelteKit
6. *(rule moved to step 0)*
7. `vite` in deps → generic Vite
8. else → unknown

We deliberately do NOT inspect script bodies for the framework name
(too noisy: `"build": "vite build && astro telemetry disable"` would
mis-detect). Deps are the contract; the Remix vite-config check is the
one exception, motivated by its dual-mode history.

## 5. Per-framework shim modules

Where a framework's CLI needs intervention, place it under `src/frameworks/<name>.ts`:

**Required src change (across all framework shims):** extend
`_CP_FACET_DIRECT` in `nimbus-session.ts:413` with `astro, nuxt, nuxi,
remix, svelte-kit, next` so the W8 child_process classifier routes
their bin invocations to facet-direct mode. Without this, `npm run dev`
calling `astro` (bare name) returns `_CP_FACET_DIRECT` lookup miss and
exits 127. The reviewer caught this — risk-row 1 in v1 was wrong.

- `src/frameworks/astro.ts` — `astro dev` entry. Discovers the right
  CLI launcher *at runtime* by `require.resolve('astro/package.json')`
  and reading the `bin.astro` field rather than hard-coding
  `dist/cli/index.js` (the latter is internal and changes between
  Astro majors). Calls Astro's documented `dev()` API where the
  installed version exposes one (Astro 4.x +); else shells out via
  W8 child_process. Bridges Astro's Vite server port (default 4321)
  to our preview router.
- `src/frameworks/sveltekit.ts` — alias hint registration:
  the SK Vite plugin already does the heavy lifting; this module just
  asserts the alias map made it into our `viteConfig.alias` and
  emits a warning if it didn't.
- `src/frameworks/remix.ts` — same as Astro: `remix vite:dev` is just
  vite, but with a config-injection step.
- `src/frameworks/nuxt.ts` — best-effort Nitro+Vite bridge. Documents
  caveats inline if dual-server unification fails.
- `src/frameworks/next.ts` — stub that emits a clear "Next.js dev server
  is BLOCKED in Phase 1; tracked in W11.5" message and exit 127. Better
  than a silent hang.

Each module is **lazy-loaded**: importing them is opt-in by `framework-detect`'s
`devCommand`, so the supervisor's hot path doesn't pay for unused frameworks.

## 6. `src/seed-project.ts` update

The starter README mentions Vite + React + Tailwind today. Add a short
"Supported frameworks" section pointing users at `nimbus framework new <name>`
(post-W11.5) or hand-cloning a starter. No template churn.

## 7. Test fixtures — strategy

The probe `_fixtures/` directory holds **hand-written, minimal** fixtures
per framework. Probes:

1. Boot a fresh prod session (or use a mock harness locally for offline-CI).
2. Materialize the fixture into `/home/user/app` via WS commands.
3. Run `npm install`. Capture pass/fail.
4. Run `npm run dev`. Wait for the dev server's "ready" line on stdout
   (each framework has a recognizable banner — `VITE ready`, `astro v4.x ready`,
   `Local: http://localhost:3000`, etc.).
5. `GET <preview-url>/` — expect 200 + a framework-specific marker:
   - **SvelteKit:** HTML body contains `<div data-sveltekit-` OR
     `<script type="module" src="/.svelte-kit/`. (One of these is always present.)
   - **Astro:** HTML body contains `<astro-island` element or
     `data-astro-cid` attr.
   - **Remix:** HTML body contains a `window.__remixContext` script or
     `data-remix-` attr.
   - **Nuxt:** HTML body contains `window.__NUXT__` script or `data-nuxt-` attr.
   - **Next.js:** HTML body references `_next/static` URL.

We use **offline fixtures** (committed to the repo) instead of `create-X@latest`
to keep probes deterministic and runnable without network.

## 8. TDD test layout

```
audit/probes/w11/
├── _fixtures/
│   ├── sveltekit-minimal/   # pkg.json + svelte.config.js + $lib import
│   ├── astro-minimal/       # pkg.json + astro.config.mjs + react island
│   ├── remix-minimal/       # pkg.json + vite.config.ts + <Link> usage
│   ├── nuxt-minimal/        # pkg.json + nuxt.config.ts + minimal page
│   └── next-minimal/        # pkg.json + next.config.js + pages/index.tsx
├── functional/
│   ├── detect-next.mjs           # detectFramework on Next pkg
│   ├── detect-astro.mjs
│   ├── detect-nuxt.mjs
│   ├── detect-remix.mjs
│   ├── detect-remix-bare-react.mjs           # @remix-run/react alone → 'vite' fallthrough
│   ├── detect-sveltekit.mjs
│   ├── detect-vite-generic.mjs   # plain vite + react → 'vite'
│   ├── detect-wrangler.mjs       # wrangler.toml present → 'wrangler'
│   ├── detect-wrangler-on-framework.mjs   # rule 0 — sk + wrangler.jsonc → 'sveltekit'+'wrangler-dev'
│   ├── detect-unknown.mjs        # empty pkg → 'unknown'
│   ├── detect-precedence.mjs     # next + vite both present → 'next' wins
│   ├── shim-modules-loadable.mjs # each frameworks/<x>.ts imports cleanly
│   └── vite-import-resolves-from-fixture.mjs  # SK fixture + node_modules/vite present
├── regression/
│   ├── install-pipeline-coverage.mjs    # references existing W2.5 probe (unchanged)
│   ├── seed-project-shape.mjs           # seed-project.ts surface unchanged
│   ├── bundler-bin-prefixes-include-frameworks.mjs   # next/nuxt/astro/remix in BUNDLER_BIN_PREFIXES
│   ├── cp-facet-direct-includes-frameworks.mjs       # _CP_FACET_DIRECT extended
│   └── w3-w9-probe-presence.mjs          # all prior probe runners still discoverable
├── e2e/
│   ├── sveltekit-dev-200.mjs    # NIMBUS_W11_E2E=1 — full prod cycle
│   ├── sveltekit-build-emits.mjs   # vite build emits .svelte-kit/output
│   ├── astro-dev-200.mjs
│   ├── astro-build-emits.mjs       # astro build emits dist/
│   ├── remix-dev-200.mjs
│   ├── remix-build-emits.mjs       # remix vite:build emits build/
│   ├── nuxt-dev-200.mjs
│   └── next-dev-200.mjs         # expected to fail on Phase 1; records mode
├── _tap.mjs                # local TAP runner (copy from w8/w9)
├── _detect-mock.mjs        # adapter — wraps src/framework-detect import; if
│                           # the file doesn't exist (RED phase), returns a
│                           # sentinel { framework:'__not-implemented__' } so
│                           # probes go RED with readable assertion failures
│                           # rather than crashing on ERR_MODULE_NOT_FOUND
└── run-all.mjs             # orchestrator
```

E2E probes self-skip when `NIMBUS_W11_E2E` is unset (mirrors W5/W6/W9
convention). Functional + regression run unconditionally. Each e2e
dev probe also has a stderr-watcher that fails fast on `Error:` lines
so a crashed dev server doesn't burn the full 30s wait-for-banner.

## 9. Build phases (per master roadmap workflow)

1. **Plan** ← this doc.
2. **TDD red** — commit all probes + fixtures + run-all.mjs that fail
   on current main (no `framework-detect.ts`, no `frameworks/*.ts`).
3. **Build** — implement
   - `src/framework-detect.ts` (the detector)
   - `src/frameworks/sveltekit.ts` (verify alias)
   - `src/frameworks/astro.ts` (CLI bridge)
   - `src/frameworks/remix.ts` (CLI bridge)
   - `src/frameworks/nuxt.ts` (best-effort)
   - `src/frameworks/next.ts` (loud-block stub)
   - Wire detection into `nimbus-session.ts:initSession` (one log line on
     boot: "[nimbus] detected framework: <X>") — purely informational,
     does not change behavior except the next-cli stub.
   - Update `seed-project.ts` README only.
4. **Audit** — local probe run all-green; tsc clean; Mossaic regression
   re-run unchanged.
5. **Push** — `git push origin w11-frameworks` (best-effort).
6. **Retro** — per-framework verdicts in W11-retro.md.

## 10. Risk matrix

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Astro CLI invoked through `node_modules/.bin/astro` shell-launcher fails inside our shell | High | Medium | We extend `_CP_FACET_DIRECT` (nimbus-session.ts:413) with `astro/nuxt/nuxi/remix/svelte-kit/next` (see §5 required src change). If the bin shim still crashes, the framework module discovers the right entry from the package's `bin.astro` field at runtime rather than hard-coding internal paths. |
| SvelteKit `$lib` alias regex miss | Med | Low | Functional probe asserts; `detect-sveltekit.mjs` prints the parsed alias map. If miss, add a hand-coded alias seeding inside `frameworks/sveltekit.ts`. |
| Nuxt dual-server topology (Vite + Nitro) doesn't fit single preview origin | High | Med-High | Document; route `/` → Vite, `/api` → Nitro via path-prefix in the supervisor router. If still broken, mark Nuxt CAVEATS in retro and unblock the other 4. |
| Next.js install itself succeeds (deps install) but binary won't run | Near-certain | Acceptable | This is the **expected** Phase 1 outcome. The next-cli stub gives a clear error so users aren't left holding a hang. |
| Probe E2E races on dev-server startup | Med | Low | Each e2e probe has a 30s wait-for-banner with `setInterval` poll; logs whatever stdout we got at timeout for debug. |
| Real-vite mode is OFF by default; SK/Astro/Remix all need it | High | Low | `frameworks/*.ts` modules force `NIMBUS_REAL_VITE=1` semantics for their code path. Cirrus shim is left untouched for plain Vite + React projects. |
| Test fixtures drift from upstream defaults | Low | Low | Document fixture provenance (which upstream version they mirror) inside each `_fixtures/<name>/README.md`. Refresh in W11.5. |

## 11. Definition of done

- W11-plan.md (this file) v2 ✓ committed
- W11 probe directory committed with all functional + regression + e2e
  probes RED on tip of main; reproducible via `bun audit/probes/w11/run-all.mjs`
- `src/framework-detect.ts` + all 5 `src/frameworks/*.ts` shims committed
- `_CP_FACET_DIRECT` (nimbus-session.ts:413) extended for framework bins
- `vite` removed from SKIP_PACKAGES when framework detected (§3.0 Option B)
- All functional + regression probes GREEN locally
- ≥3 of 5 e2e *dev* probes GREEN against a deployed prod (or mock harness
  if prod auth lapses) — SvelteKit, Astro, Remix targets
- For each green-dev framework, the matching *build-emits* e2e probe also
  GREEN — the spec's "dev, build" line in MASTER-ROADMAP §W11 is honored
- Nuxt + Next status documented honestly in retro with first-failure-mode
- `bunx tsc --noEmit` clean
- Mossaic regression unchanged
- Branch pushed to `origin/w11-frameworks`
- W11-retro.md committed
- W11-progress.md has all 6 phases marked
