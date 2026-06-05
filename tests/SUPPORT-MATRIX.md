# Project Type Support Matrix

This matrix is cross-checked against the current code and probe tree. Run the
listed probes against prod for the current live verdict:

```bash
BASE=https://nimbus.ashishkumarsingh.com bun test:behavioral
```

The current runner discovers 305 probes recursively. It skips helper files
whose basename starts with `_` and any `run-all.mjs` sub-runner.

Status legend:

- ✅ supported contract: there is a black-box probe for the user flow and the
  README may claim support when that probe is green.
- ⚠️ partial / active: there is meaningful probe coverage, but the framework
  surface is still changing or the claim is narrower than "everything works".
- ❌ unsupported by design/current code: no current runtime path owns this
  workflow.
- ❓ unverified: no dedicated probe exists.

## Matrix

| Project type | Status | Probe coverage | Claim boundary |
|---|:---:|---|---|
| Vite SPA, no CF plugin | ✅ | `tests/behavioral/end-to-end-workflow.mjs`, `tests/behavioral/frameworks/markflow-real.mjs`, `tests/behavioral/frameworks/markflow-clickthrough.mjs` | Starter app / Vite dev server / preview iframe flow. |
| Pure Workers via `wrangler dev` | ✅ | `tests/behavioral/wrangler-dev-clone.mjs`, `tests/behavioral/frameworks/cloudflare-pages-real.mjs` | Single-file / C3 hello-world Worker. Note: despite the filename, `cloudflare-pages-real.mjs` drives a C3 Worker, not `wrangler pages dev`. |
| Workers + Static Assets | ✅ | `tests/behavioral/support-matrix.mjs` row `workers-static-assets` | Wrangler config with `assets:` and Worker fetch handler. |
| Vite + `@cloudflare/vite-plugin` | ⚠️ | `tests/behavioral/frameworks/cf-vite-plugin-real.mjs` | React/Vite home hydration path with the plugin installed. Worker-style plugin API routes are not a broad contract yet. |
| Cloudflare Pages | ❌ | No `wrangler pages dev` probe | `wrangler pages dev` is not wired as a shell/runtime path. |
| Astro | ⚠️ | `tests/behavioral/frameworks/astro-real.mjs`, `tests/behavioral/npm-create/new/create-astro-esbuild-diagnostic.mjs` | Real create/install/dev/render probe exists; keep README wording partial until prod cohort is green. |
| Next.js | ⚠️ | `tests/behavioral/frameworks/nextjs-real.mjs`, `tests/behavioral/npm-create/new/create-nextjs-node-constants.mjs` | Real create-next-app/dev/render probe exists; heap/runtime constraints still make this a partial claim. |
| Nuxt | ⚠️ | `tests/behavioral/frameworks/nuxt-real.mjs`, module-format Nuxt regressions | Real create/dev/render coverage exists, plus import/meta/process regression probes. |
| Remix v2 | ⚠️ | `tests/behavioral/frameworks/remix-real.mjs`, `tests/behavioral/npm-create/new/create-remix-no-rejection-noise.mjs` | Vite-based Remix paths are probed; non-Vite Remix scripts are not a broad contract. |
| SvelteKit | ⚠️ | `tests/behavioral/frameworks/sveltekit-real.mjs` | Vite-based dev path is probed; adapter-specific behavior remains partial. |
| npm create / npx scaffolding | ⚠️ | `tests/behavioral/npm-create/*`, `tests/behavioral/runtime-pkg/npx-parity.mjs` | Specific scaffolders and npx parity paths, not every npm initializer. |
| Multi-tab concurrent terminal sessions | ⚠️ | `tests/behavioral/multi-tab.mjs`, `tests/behavioral/parallel-installs.mjs` | There are probes for concurrent attach/install behavior, but README still should avoid claiming mature multi-tab UX. |
| WASI preview1 / wasm runner | ✅ | `tests/behavioral/wasi/*`, `tests/behavioral/wasi-paths/*`, `tests/behavioral/wasm-runner/*` | Preview1 functions implemented except `sock_accept`; outbound TCP and poll paths are probed. |
| wasi-threads / `-pthread` | ❌ | `docs/wasi-threads.md` | Refused by design; thread-like shared-memory semantics cannot be implemented correctly in workerd isolates today. |

## Probe Coverage Notes

The old 12-probe list is obsolete. The suite now spans auth, assets-fetch,
binary-fs, cache-observability, clang, clang-includes, clang-state,
clang-stdio, console-facet, file-tree, frameworks, heap-correctness, install,
module-format, editor/monaco, npm-create, pkg-manager, preview, REPL,
runtime-pkg, shell, WASI, wasm-runner, session-lifecycle, and install-performance cohorts.

To inspect discovery without running all probes, read
`tests/behavioral/run-all.mjs`; the runner prints the discovered count when
started with `BASE` set.

When a row's support status changes, update this matrix and the matching
README claim in the same change.
