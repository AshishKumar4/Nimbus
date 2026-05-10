# Project Type Support Matrix

What Nimbus actually supports, verified by behavioral probes against
prod (https://nimbus.ashishkmr472.workers.dev). Rows marked ❓ are
unverified; treat README claims about them as marketing, not contract.

Status legend:
- ✅ verified — at least one probe in `tests/behavioral/` drives this
  project type end-to-end on prod and reports PASS.
- ⚠️ partial — works for some subset of inputs; documented caveat.
- ❌ broken — probe RED with evidence link or known structural failure.
- ❓ unverified — no probe; capability untested.

## Matrix

| Project type                          | Status | Probe | Notes |
|---------------------------------------|:---:|---|---|
| Vite SPA (no CF plugin)               | ✅ | `tests/behavioral/end-to-end-workflow.mjs` | Seeded starter at `~/app`; full cd → npm install → npm run dev → /preview/ flow passes |
| Pure Workers (`wrangler dev`)         | ✅ | `tests/behavioral/wrangler-dev-clone.mjs` | Small worker (single-file). Honest 60s timeout for large/heap-pressured bundles |
| Workers + Static Assets               | ✅ | `tests/behavioral/support-matrix.mjs` (row `workers-static-assets`) | wrangler.jsonc with `assets:` field bundles correctly |
| Vite + `@cloudflare/vite-plugin`      | ❓ | (none) | The CF vite plugin uses `getPlatformProxy()` and a workerd subprocess that Nimbus's facet runtime doesn't expose. Untested |
| Cloudflare Pages                      | ❌ | (none) | No `wrangler pages dev` handler; `functions/` directory layout not recognized |
| Astro                                 | ❌ | `tests/behavioral/support-matrix.mjs` (row `astro-detect`) | `astro` is NOT a registered shell command; `npm run dev` invoking `astro dev` fails with command-not-found. Detection MOTD prints but no actual dispatcher |
| Next.js                               | ❌ | `tests/behavioral/support-matrix.mjs` (row `next-detect`) | `next` is NOT a registered shell command; `next dev` fails with command-not-found. Even if dispatched, Webpack/Turbopack don't fit the supervisor's 64 MiB heap |
| Nuxt                                  | ❓ | (none) | Same shape as Astro/Next; likely ❌ |
| Remix v2 (vite-plugin)                | ❓ | (none) | Some scaffolds set `dev: vite` (would route through row 1 ✅); others set `dev: remix vite:dev` (`remix` not registered → ❌) |
| SvelteKit                             | ❓ | (none) | SvelteKit's dev script is `vite dev`; SHOULD route through row 1 with node_modules present, but vite plugin compatibility untested |

## Probe coverage

```
$ BASE=https://nimbus.ashishkmr472.workers.dev bun test:behavioral
```

The following 12 behavioral probes ship in `tests/behavioral/`:

| Probe | What it asserts |
|---|---|
| `end-to-end-workflow.mjs` | npm install + npm run dev + /preview/ for the starter Vite app |
| `git-clone.mjs` | `git clone` of small + Nimbus-sized repos completes |
| `bun.mjs` | `bun` runtime is available + executes |
| `multi-tab.mjs` | multiple terminals attached to the same DO see consistent VFS |
| `parallel-installs.mjs` | concurrent `npm install` from two tabs |
| `property-cohort.mjs` | property-based smoke over shell + node + git |
| `runtime-invocation.mjs` | `node`, `bun`, `esbuild` shell handlers invoke correctly |
| `session-recovery.mjs` | webSocketError → reconnect → state preserved |
| `large-install.mjs` | Markflow ~617 dep install (P0a regression) |
| `wrangler-dev-clone.mjs` | small Workers project + wrangler dev (P0b regression) |
| `honest-install-message.mjs` | install summary line color/suffix matches actual failed-count |
| `support-matrix.mjs` | per-row project-type checks (this matrix) |

## Last-verified versions

This file's claims are last verified against prod **wrangler version
`6f201788`** (= git `0d410b4`, install-honesty fix shipped). Re-run
the cohort against the latest deploy:

```
$ BASE=https://nimbus.ashishkmr472.workers.dev bun test:behavioral
```

When a row's status changes, update both this matrix AND the matching
README claim in the same commit.
