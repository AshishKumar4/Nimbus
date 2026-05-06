# X.5-peer-gap Progress Log

> Branch: `x5peer-gap` off `origin/main` HEAD `23417c5`.
> Audit-only investigation per VERIFY-23417C5.md §4 #3.
> NO src/ commits. Probes + plan + retro only.

---

## Phase A — Reproduction probes ✓

### Setup
- Worktree created at `/workspace/worktrees/x5peer-gap` from `origin/main` `23417c5`.
- `bun install` succeeded (184 packages, 9.17s).
- Probes directory: `audit/probes/x5peer-gap-investigation/`.
- Reference probes pulled from `verify-23417c5` branch (not on main):
  - `nuxt.out.txt:164` → `Cannot find module '../dist/defu.cjs' (from home/user/app/node_modules/defu/lib)` at `__requireFrom (runner.js:2910:24)`
  - `tailwindcss-vite.out.txt:135` → `Cannot find module 'tailwindcss' (from home/user/app/node_modules/@tailwindcss/node/dist)` at `__requireFrom (runner.js:2910:24)`

### Probes shipped (3)

| Probe | Question answered | Outcome |
|---|---|---|
| `p1-defu-shim-shape.mjs` | What is defu's main + does dist/defu.cjs exist in tarball? | meta.main = `./lib/defu.cjs` (278 B shim that `require("../dist/defu.cjs")`); dist/defu.cjs IS in tarball (2203 B). Both files present after install. |
| `p2-tailwindcss-skip.mjs` | Is `tailwindcss` in SKIP_PACKAGES? Is it a regular dep of @tailwindcss/node? | YES — present in `src/npm-resolver.ts:887` and `src/parallel/npm-resolve-preamble.ts:42`. NOT exempted by FRAMEWORK_REQUIRED_PACKAGES (only vite is). `@tailwindcss/node@4.2.4`'s `dependencies` has `tailwindcss: "4.2.4"` (regular dep, not peer/optional). dist/index.js literal `require("tailwindcss")`. |
| `p3-greedy-no-recurse.mjs` | Does `greedyAddMainEntries` walk the main entry's own requires? | **NO** — 0 calls to `parseAndResolve` / `prefetchForRequire` inside `greedyAddMainEntries` body (`src/facet-manager.ts:598-747`). Contrast `prefetchForRequire`'s `addFile` (`src/require-resolver.ts:441-488`) which DOES recurse on every added file. |

### Comparison vs real npm install
Local `bun install` of `nuxt` (227 MB node_modules, 6892 JS files, 31.5 MiB
JS bytes) yields both `node_modules/defu/lib/defu.cjs` (278 B) AND
`node_modules/defu/dist/defu.cjs` (2203 B). The Nimbus install pipeline
extracts whole tarballs (no `package.json#files` filtering — see
`src/npm-tarball.ts:65` `extractTarballFromResponse` — it iterates every
tar entry without filter), so `dist/` IS on VFS-disk after install. The
gap is in the **prefetch bundle** (what gets shipped into the facet's
`__vfsBundle`), not on disk.

---

## Phase B — Root-cause hypothesis ranking ✓

### nuxt — H1: greedy oversample doesn't recurse (CONFIRMED)

**Root cause class:** prefetch-bundle gap at the runtime `__vfsBundle`
boundary.

| H | Description | Evidence | Verdict |
|---|---|---|---|
| H1 | greedyAddMainEntries lands `defu/lib/defu.cjs` (a 278 B shim) without recursing into its `require("../dist/defu.cjs")`. The require-walker `prefetchForRequire` only reaches defu via nuxt's ESM `import { defu } from 'defu'` chain, which routes through `pkg.exports.import.default = ./dist/defu.mjs` (ESM, NOT the CJS shim). At runtime, `__resolvePkgSubpath` honours `pkg.exports.require.default = ./lib/defu.cjs`, the shim runs, requires `../dist/defu.cjs`, but `__fileExists` (bundle-only at `node-shims.ts:2045-2056`) returns false → `Cannot find module`. | p3 probe shows 0 recursive calls in greedyAddMainEntries; p1 shows shim shape; `node-shims.ts:2045-2056` bundle-only file existence; `src/require-resolver.ts:441-488` recurses, vs `src/facet-manager.ts:611-626` doesn't | **CONFIRMED root cause** |
| H2 | Cap eviction (W2.6b territory): `dist/defu.cjs` was added but evicted by the JSON-encoded-size guard at `facet-manager.ts:1095-1104`. | dist/defu.cjs is 2203 B — far below any plausible eviction threshold; eviction sorts by largest-first and would never pop a 2 KB file. | RULED OUT |
| H3 | `package.json#files` filter excludes `dist/`. | defu's `package.json` has no `files` field (probe p1 shows `files: undefined`). Tarball ships dist/ unconditionally. | RULED OUT |
| H4 | Optional/peer-dep skip in resolver. | defu is a regular dependency of nuxt's transitive graph (no peer/optional metadata involved). | RULED OUT |
| H5 | NEW install-time class. | All paths covered by H1 + existing X.5-C/L pattern; no new install-time code path needed. | RULED OUT |

**Specific src/ file:line evidence for H1:**

- `src/facet-manager.ts:611-626` — `addOne()` adds file to bundle; no recursion call.
- `src/facet-manager.ts:644-728` — `addPkgEntry()` walks main/module/exports leaves + hash-chunk siblings + shared/ subdir; no `parseAndResolve` / require-walker dispatch.
- `src/require-resolver.ts:441-488` — `addFile()` calls `parseAndResolve(content, fromDir)` on every `.js/.mjs/.cjs` add (line 484-487).
- `src/require-resolver.ts:490-518` — `parseAndResolve` runs both `REQUIRE_RE` and `IMPORT_RE`, calling `resolveRequireEx` + `addFile` recursively. THIS is what greedy lacks.
- `src/node-shims.ts:2045-2056` — `__fileExists` consults only `__vfsBundle / __vfsWrites / __vfsDirs`; never falls through to `__fsMod`. So if the file isn't in the bundle, runtime resolution fails even though the file is on VFS-disk.

### tailwindcss-vite — H1': SKIP_PACKAGES false-positive (CONFIRMED)

**Root cause class:** install-time skip-list false-positive.

| H | Description | Evidence | Verdict |
|---|---|---|---|
| H1' | `tailwindcss` is in SKIP_PACKAGES (was a build-only CSS CLI in v3). Tailwind v4 split: `tailwindcss` package is now the runtime engine, required at runtime by `@tailwindcss/node@4.x`. Skip is a stale false-positive. | p2 probe: present in `src/npm-resolver.ts:887` + `src/parallel/npm-resolve-preamble.ts:42`; NOT exempted by FRAMEWORK_REQUIRED_PACKAGES (line 902-904 has only vite); `@tailwindcss/node@4.2.4` has `tailwindcss` in `dependencies` (not peer/optional); `dist/index.js` literal `require("tailwindcss")` line 1. | **CONFIRMED root cause** |
| H2' | Cap eviction. | `tailwindcss` is never *resolved* at all (silent-skip in resolver), so it's never installed. Not an eviction case. | RULED OUT |
| H3' | Files-field filter on @tailwindcss/node tarball. | Probe shows `dist/index.js` is in the tarball + literal require pattern present. The MISSING package is `tailwindcss` (sibling), not a sub-file. | RULED OUT (different class) |
| H4' | Peer-dep handling gap. | Probe: `peerDependencies: undefined` on `@tailwindcss/node@4.2.4`. Regular `dependencies`. The X.5-F R2 peer-walker handles real peers; this isn't one. | RULED OUT |
| H5' | NEW install-time class. | The fix is a one-line skip-list edit. No new mechanism. | RULED OUT |

**Specific src/ file:line evidence for H1':**

- `src/npm-resolver.ts:884-896` — SKIP_PACKAGES Set defines build-tool blocklist. Line 887 includes 'tailwindcss'.
- `src/npm-resolver.ts:898-904` — FRAMEWORK_REQUIRED_PACKAGES has only `'vite'` — no exemption for tailwindcss.
- `src/npm-resolver.ts:919-922` — `shouldSkipPackage(name)` returns true for any SKIP_PACKAGES member.
- `src/parallel/npm-resolve-preamble.ts:39-50` — preamble mirror with same blocklist + same FRAMEWORK_REQUIRED set.
- `src/parallel/npm-resolve-preamble.ts:58-63` — `SHOULD_SKIP_PACKAGE(name, frameworkAware)` used at the facet-resolver path (`src/npm-resolve-facet.ts:483, 663`).

### Cross-cutting

The two failures share *no* mechanism. They are independent root causes
that happen to surface with the same `__requireFrom` error shape. Neither
folds into X.5-26b (W2.6b cap-eviction territory) — both are
**install/prefetch-pipeline gaps**, not memory-cap evictions.

---

## Phase C — Fix architecture sketch ✓

See `audit/sections/X5peer-gap-plan.md`.

---

## Phase D — Backlog readiness + dispatch order ✓

See `audit/sections/X5peer-gap-plan.md` §4.

---

## Phase E — Push ✓

`git push origin x5peer-gap` (after writing plan + retro).

---

## Phase F — Retro ✓

See `audit/sections/X5peer-gap-investigation-retro.md`.
