# Section 02 — Top-30 npm Package Compatibility

> Probes captured 2026-04-29 against prod `https://nimbus.ashishkmr472.workers.dev`
> at HEAD `e93b18d`. Each pkg: fresh session → `npm install <pkg>` → smoke
> `node .smoke.js` from `/home/user/app/`. Probe artifacts:
> [`audit/probes/packages/<name>.out.txt`](../probes/packages/) +
> [`<name>.probe.js`](../probes/packages/).
>
> Classifier: [`audit/probes/classify-packages.mjs`](../probes/classify-packages.mjs).
> Generated table: [`audit/probes/packages/_TABLE.md`](../probes/packages/_TABLE.md).
>
> **W2 measured (HEAD `61933c6`, prod ver `22962f4d`):** runtime resolver
> consolidated into the shared `src/_shared/exports-resolver.ts`. Re-run
> 2026-04-30, identical TARGETS list, fresh prod sessions. Post-W2
> probe artifacts: [`audit/probes/packages-prod-w2/<name>.out.txt`](../probes/packages-prod-w2/)
> + classifier output [`packages-prod-w2/_DELTA.json`](../probes/packages-prod-w2/_DELTA.json).

## Status counts (33 packages)

| Status | Pre-W2 (HEAD `e93b18d`) | Post-W2 (HEAD `61933c6` / prod `22962f4d`) | Post-W2.5b (HEAD `6a128f5` / prod `edc98e62`) | Post-W2.6a (HEAD `bebeaee` / prod `3d7b6ff7`) |
|---|---|---|---|---|
| ✅ install + runtime works | **1** (`jest`) | **4** (`jest`, `pg`, `zod`, `better-sqlite3`) | **4** (same) | **5** (+ `drizzle-orm`) |
| ⚠️ installs but breaks at runtime | 28 | 25 | 25 | **25** (mix shifted — most ⚠️→ failures advanced one layer deeper) |
| ❌ install silently skipped / unresolvable | 4 | 4 | 4 | **3** (`next`/`nuxt`/`prisma`) |

**Net W2.6a delta: +1 ✅ (`drizzle-orm`). 0 regressions. 0 ✅→⚠️ flips.**

**Predicted W2.6a delta (per audit/sections/W2.6-plan.md §3):** +3 (`fastify`,
`redis`, `drizzle-orm`). **Realized: +1.** The shortfall is NOT a W2.6a bug —
W2.6a's bundling fix advanced the require chain deeper for fastify/redis et
al., uncovering a *next layer* of unrelated walls (missing `node:diagnostics_channel`
shim, content-cap eviction in `@redis/client/dist/lib/client`, etc.). See
[`W2.6a-retro.md`](W2.6a-retro.md) §3 for the failure-mode shift table.

The audit predicted 18 packages would turn ✅. Measured was 4 ✅. The shortfall
is **NOT** a resolver bug (synthetic-VFS testing, [W2-retro.md](W2-retro.md)
verifies the resolver works correctly against in-memory VFS). The shortfall is
a separate **install-pipeline issue** that drops files for many transitive
packages (W2 unmasked it; pre-W2 the broken resolver failed earlier on the same
packages with different error signatures). 12 of the 15 "advanced past prior
error" probes now fail with `Cannot find module 'X'` for an X whose tarball
was extracted to an empty directory in the VFS.

See "Install-pipeline systemic gap" section below for evidence and the
follow-up wave dispatch.

(Classifier groups silent-skip under ⚠️ because the install did "complete";
the runtime then can't find the package because it was never written. See
the `_TABLE.md` artifact for the raw classification.)

**Real ✅ count: 1/33 = 3%.** This is HEAD `e93b18d` post-Wave-1. The Wave 1
effort was the 100% edge contract (no third-party CDN fetches), not the
runtime resolver — which is why ⚠️ counts haven't moved since the prior
audit at `78bc817`.

## Full table (probe-verified, measured pre/post-W2)

Legend for **Post-W2 measured**:

  - ✅ = `Process N exited with code 0` (smoke imported and ran successfully)
  - ⚠️ = same surface error as pre-W2 (resolver fix did not advance)
  - ⚠️→ = advanced past prior error to a NEW downstream error
  - ❌ = regression (none observed)

Column **Reasoning** shows the post-W2 error class — `resolver-class`
means the W2 resolver still couldn't find the module (suspected install
pipeline gap; see below); `pre-bundle`, `native`, `vm-builtin`,
`skip-package` are downstream wave classes per the audit roadmap.

| Package | Pre-W2 | Post-W2 measured | Post-W2 evidence (verbatim) | Reasoning | Pre / Post probe |
|---|---|---|---|---|---|
| `astro` | ⚠️ | ⚠️ same | `Cannot load module 'home/user/app/node_modules/astro/dist/index.js': file was not pre-bundled. Add it to the VFS bundle.` | pre-bundle (W3) | [pre](../probes/packages/astro.out.txt) / [post](../probes/packages-prod-w2/astro.out.txt) |
| `axios` | ⚠️ | ⚠️→ | `Cannot find module 'http2' (from home/user/app/node_modules/axios/dist/node)` | vm-builtin (W3 — `http2` not in shim) | [pre](../probes/packages/axios.out.txt) / [post](../probes/packages-prod-w2/axios.out.txt) |
| `bcrypt` | ⚠️ | ⚠️→ | `Cannot load module 'home/user/app/node_modules/bcrypt/prebuilds/linux-x64/bcrypt.glibc.node': file was not pre-bundled` | native binding (W4 — swap to `bcryptjs`) | [pre](../probes/packages/bcrypt.out.txt) / [post](../probes/packages-prod-w2/bcrypt.out.txt) |
| `better-sqlite3` | ⚠️ | **✅** | `typeof: function` (smoke ok) | resolver-fix sufficed | [pre](../probes/packages/better-sqlite3.out.txt) / [post](../probes/packages-prod-w2/better-sqlite3.out.txt) |
| `drizzle-orm` | ⚠️ | ⚠️→ | `Cannot find module '../pg-core/columns/enum.cjs' (from home/user/app/node_modules/drizzle-orm/sql)` | install-empty (file missing in VFS — not in install pipeline output) | [pre](../probes/packages/drizzle-orm.out.txt) / [post](../probes/packages-prod-w2/drizzle-orm.out.txt) |
| `express` | ⚠️ | ⚠️→ | `Cannot find module 'es-object-atoms' (from home/user/app/node_modules/get-intrinsic)` | install-empty (verified via `fs.readdirSync` — `es-object-atoms` directory is empty) | [pre](../probes/packages/express.out.txt) / [post](../probes/packages-prod-w2/express.out.txt) |
| `fastify` | ⚠️ | ⚠️→ | `Cannot find module 'avvio' (from home/user/app/node_modules/fastify)` | install-empty (verified — avvio directory empty) | [pre](../probes/packages/fastify.out.txt) / [post](../probes/packages-prod-w2/fastify.out.txt) |
| `framer-motion` | ⚠️ | ⚠️→ | `Cannot find module './cjs/react-jsx-runtime.development.js' (from home/user/app/node_modules/react)` | install-empty (react@18.3.1's `cjs/` not populated; bare `react@latest` works) | [pre](../probes/packages/framer-motion.out.txt) / [post](../probes/packages-prod-w2/framer-motion.out.txt) |
| `fsevents` | ⚠️ | ⚠️ same | `Cannot find module 'fsevents' (from /home/user/app)` | skip-package (W6) | [pre](../probes/packages/fsevents.out.txt) / [post](../probes/packages-prod-w2/fsevents.out.txt) |
| `jest` | **✅** | ✅ | `typeof: object` | unchanged | [pre](../probes/packages/jest.out.txt) / [post](../probes/packages-prod-w2/jest.out.txt) |
| `jsdom` | ⚠️ | ⚠️ same | `Cannot find module 'vm' (from home/user/app/node_modules/jsdom/lib)` | vm-builtin (W3) | [pre](../probes/packages/jsdom.out.txt) / [post](../probes/packages-prod-w2/jsdom.out.txt) |
| `next` | ⚠️ | ⚠️ same | `Cannot find module 'next' (from /home/user/app)` | skip-package (W6) | [pre](../probes/packages/next.out.txt) / [post](../probes/packages-prod-w2/next.out.txt) |
| `node-canvas` | ⚠️ | ⚠️→ | `Cannot find module '../build/Release/canvas.node' (from home/user/app/node_modules/canvas/lib)` | native binding (W4) | [pre](../probes/packages/node-canvas.out.txt) / [post](../probes/packages-prod-w2/node-canvas.out.txt) |
| `nuxt` | ⚠️ | ⚠️→ | `Cannot find module 'nuxt' (from /home/user/app)` | skip-package (W6) (was pre-bundle pre-W2) | [pre](../probes/packages/nuxt.out.txt) / [post](../probes/packages-prod-w2/nuxt.out.txt) |
| `parcel` | ⚠️ | ⚠️ same | `Cannot find module 'parcel' (from /home/user/app)` | skip-package (W6) | [pre](../probes/packages/parcel.out.txt) / [post](../probes/packages-prod-w2/parcel.out.txt) |
| `pg` | ⚠️ | **✅** | `keys: [Client, Pool, ...]` | resolver-fix sufficed | [pre](../probes/packages/pg.out.txt) / [post](../probes/packages-prod-w2/pg.out.txt) |
| `prisma` | ⚠️ | ⚠️ same | `Cannot find module 'prisma' (from /home/user/app)` | skip-package / CLI-only | [pre](../probes/packages/prisma.out.txt) / [post](../probes/packages-prod-w2/prisma.out.txt) |
| `puppeteer-core` | ⚠️ | ⚠️→ | `Cannot find module './api/api.js' (from home/user/app/node_modules/puppeteer-core/lib/cjs/puppeteer)` | install-empty (verified — `lib/cjs/puppeteer/api/` directory empty) | [pre](../probes/packages/puppeteer-core.out.txt) / [post](../probes/packages-prod-w2/puppeteer-core.out.txt) |
| `@radix-ui/react-dialog` | ⚠️ | ⚠️→ | `Cannot find module '@radix-ui/react-use-layout-effect' (from home/user/app/node_modules/@radix-ui/react-id/dist)` | install-empty (transitive @radix-ui pkg directory empty) | [pre](../probes/packages/radix-react-dialog.out.txt) / [post](../probes/packages-prod-w2/radix-react-dialog.out.txt) |
| `react-remove-scroll` | ⚠️ | ⚠️→ | `Cannot load module 'home/user/app/node_modules/react-remove-scroll/dist/es2015/index.js': file was not pre-bundled` | pre-bundle (W3) | [pre](../probes/packages/react-remove-scroll.out.txt) / [post](../probes/packages-prod-w2/react-remove-scroll.out.txt) |
| `redis` | ⚠️ | ⚠️ same | `Cannot find module './lib/RESP/decoder' (from home/user/app/node_modules/@redis/client/dist)` | install-empty (verified — `@redis/client/dist` directory empty) | [pre](../probes/packages/redis.out.txt) / [post](../probes/packages-prod-w2/redis.out.txt) |
| `@remix-run/react` | ⚠️ | ⚠️→ | `Cannot load module 'home/user/app/node_modules/@remix-run/react/dist/esm/index.js': file was not pre-bundled` | pre-bundle (W3) | [pre](../probes/packages/remix-react.out.txt) / [post](../probes/packages-prod-w2/remix-react.out.txt) |
| `rollup` | ⚠️ | ⚠️ same | `Cannot find module 'rollup' (from /home/user/app)` | skip-package (W6) | [pre](../probes/packages/rollup.out.txt) / [post](../probes/packages-prod-w2/rollup.out.txt) |
| `sharp` | ⚠️ | ⚠️→ | `Cannot find module '../src/build/Release/sharp-linuxnull-x64.node' (from home/user/app/node_modules/sharp/lib)` | native binding (W4 — swap to `wasm-vips`) | [pre](../probes/packages/sharp.out.txt) / [post](../probes/packages-prod-w2/sharp.out.txt) |
| `@swc/core` | ⚠️ | ⚠️→ | `Error: Failed to load native binding` | native binding (W4 — swap to `@swc/wasm`) | [pre](../probes/packages/swc-core.out.txt) / [post](../probes/packages-prod-w2/swc-core.out.txt) |
| `@tailwindcss/oxide` | ⚠️ | ⚠️ same | `Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828)` | native binding / npm 4828 (W5) | [pre](../probes/packages/tailwindcss-oxide.out.txt) / [post](../probes/packages-prod-w2/tailwindcss-oxide.out.txt) |
| `@tailwindcss/vite` | ⚠️ | ⚠️ same | `Cannot load module 'home/user/app/node_modules/@tailwindcss/vite/dist/index.mjs': file was not pre-bundled` | pre-bundle (W3) | [pre](../probes/packages/tailwindcss-vite.out.txt) / [post](../probes/packages-prod-w2/tailwindcss-vite.out.txt) |
| `ts-jest` | ⚠️ | ⚠️→ | `Cannot find module 'typescript' (from home/user/app/node_modules/ts-jest/dist/legacy)` | install-empty (typescript directory empty) | [pre](../probes/packages/ts-jest.out.txt) / [post](../probes/packages-prod-w2/ts-jest.out.txt) |
| `ts-node` | ⚠️ | ⚠️→ | `Cannot find module 'repl' (from home/user/app/node_modules/ts-node/dist)` | vm-builtin (W3 — `repl` not in shim) | [pre](../probes/packages/ts-node.out.txt) / [post](../probes/packages-prod-w2/ts-node.out.txt) |
| `vite` | ⚠️ | ⚠️ same | `Cannot find module 'vite' (from /home/user/app)` | skip-package (W6) | [pre](../probes/packages/vite.out.txt) / [post](../probes/packages-prod-w2/vite.out.txt) |
| `vitest` | ⚠️ | ⚠️→ | `Error: Vitest cannot be imported in a CommonJS module using require(). Please use "import" instead.` | NEW — surface advanced past pre-bundle gap; ESM-only package | [pre](../probes/packages/vitest.out.txt) / [post](../probes/packages-prod-w2/vitest.out.txt) |
| `webpack` | ⚠️ | ⚠️ same | `Cannot find module 'webpack' (from /home/user/app)` | skip-package (W6) | [pre](../probes/packages/webpack.out.txt) / [post](../probes/packages-prod-w2/webpack.out.txt) |
| `zod` | ⚠️ | **✅** | `parse: hi` | resolver-fix sufficed | [pre](../probes/packages/zod.out.txt) / [post](../probes/packages-prod-w2/zod.out.txt) |

### Measured post-W2: 4 ✅ / 33 (12.1%)

Net delta: **3 packages** flipped ❌→✅ (`pg`, `zod`, `better-sqlite3`).
**0 regressions.** **15 packages** advanced past their pre-W2 surface error
to a new downstream error (the resolver fix advanced execution but a
downstream issue then surfaced).

Audit prediction was 18 ✅. The shortfall is the **install-pipeline systemic
gap** documented below. The resolver itself works correctly when files are
present (verified via synthetic-VFS test in [W2-retro.md](W2-retro.md)).

## Install-pipeline systemic gap (uncovered by W2 — DISPATCH SEPARATELY)

W2 unmasked an install-pipeline issue that pre-existed but was hidden by the
broken resolver. Verified via direct `fs.readdirSync` on prod sessions
post-`npm install <pkg>`:

| Probe                    | Empty directory observed                                    |
|---|---|
| express install         | `node_modules/get-intrinsic` is empty (no `package.json`); `node_modules/es-object-atoms` is empty |
| fastify install         | `node_modules/avvio` is empty; `node_modules/fastq` is empty; `node_modules/pino` is empty; `node_modules/semver` is empty (but `node_modules/@fastify/error` is fully populated) |
| ts-jest install         | `node_modules/typescript` is empty                          |
| drizzle-orm install     | `node_modules/drizzle-orm/pg-core/columns` is empty         |
| puppeteer-core install  | `node_modules/puppeteer-core/lib/cjs/puppeteer/api` is empty |
| redis install           | `node_modules/@redis/client/dist` is empty (entire dist subdirectory) |
| framer-motion + react@18.3.1 install | `node_modules/react/cjs` is empty BUT bare `npm install react` (latest) populates `react/cjs` correctly |

Install-time evidence: `npm install fastify` reports "added 46 packages
(1928 files)" — same file count pre and post W2 — but **the per-package
file distribution is uneven**. Some packages get all their files; others
get only a few or none. The directory is created but the tarball entries
aren't fully extracted to it.

**This is NOT a W2 regression.** The pre-W2 baseline had the same install
issue, but the broken resolver was failing earlier on different signatures
(e.g. `'./lib/express'` for express because the resolver couldn't honour
`exports`). Post-W2, the resolver correctly attempts to load the package
and the install-pipeline emptyness becomes the new visible failure.

**Likely root cause hypotheses (for separate dispatch — NOT W2 scope):**

1. Tarball-stream extraction in `src/parallel/generated-workers.ts`
   (`streamTarEntries`) may be racing or dropping entries on certain
   tarball layouts (notably ones with many small files).
2. `parseTarHeader` parser may fail on USTAR-extension entries used by
   newer npm packages; failures could be silent and skip the rest of
   the entry.
3. Batch-facet's per-package pLimit=3 internal concurrency may be
   interleaving writes such that earlier-finished packages clobber
   later-arriving entries when names collide on hoist.
4. The npm hoisting/dedupe logic in `npm-installer.ts:resolvePackageEntryPath`
   may be deduplicating into a target that's then partially overwritten.

Suggested first investigation step: a probe that runs `npm install fastify`
then dumps `fs.readdirSync` and SHA-256 of every file in
`node_modules/avvio/` against the upstream tarball's manifest. If file
count matches but content differs → write-time corruption. If file count
< tarball entry count → extraction is dropping entries.

This issue is the **single highest-leverage** follow-up; the audit's
W2-target packages that depend on transitive deps (`express`, `fastify`,
`ts-jest`, `puppeteer-core`, `radix-react-dialog`, `drizzle-orm`, `redis`,
`framer-motion@18.3.1-pin`) all unblock once this lands.

## Failure-mode taxonomy (post-W2)

Of the 29 ⚠️/❌ packages post-W2:

| Class | Count | Wave | Examples |
|---|---|---|---|
| install-empty (transitive pkg files dropped) | 8 | W2.5 (new) | express, fastify, ts-jest, drizzle-orm, redis, puppeteer-core, radix-react-dialog, framer-motion |
| pre-bundle (file not in `__vfsBundle`) | 4 | W3 | astro, tailwindcss-vite, react-remove-scroll, remix-react |
| native binding (`.node` dlopen / WASM swap) | 4 | W4 | bcrypt, sharp, node-canvas, swc-core, tailwindcss-oxide |
| vm-builtin (`vm`/`http2`/`repl` not in shim) | 3 | W3 | jsdom, axios, ts-node |
| skip-package (silent SKIP_PACKAGES) | 6 | W6 | vite, webpack, rollup, parcel, fsevents, next, nuxt, prisma |
| ESM-only / require-blocked | 1 | W3 | vitest |
| native (npm 4828 optDep) | 1 | W5 | tailwindcss-oxide |

## Failure-mode taxonomy (frequency-sorted)

### P1 — Resolver doesn't honour `package.json#exports` / subpaths (≈18 pkgs) 🔴

**Single dominant root cause.** The runtime CJS resolver in
`src/node-shims.ts:880-913 __resolvePkgEntry` only honours the trivial cases:
```js
if (typeof entry === 'object') entry = entry.require || entry.default || entry.import;
```
No conditions other than `require`/`default`/`import`. No subpath patterns.
No nested condition recursion. No `imports` field (`#name`). No null-target
enforcement. No multi-condition selection.

Affected packages (all error verbatim from probe):
- **`react`** (transitive): `Cannot find module './cjs/react.development.js'` — `react`'s `main` does `module.exports = require('./cjs/react.development.js')` but `__resolveFile` exts list at `:881` doesn't try resolution properly.
- **`@radix-ui/react-dialog`**: same react chain failure.
- **`@remix-run/react`**: same `react-router-dom` UMD-vs-ESM chain.
- **`zod`**: `'./v4/classic/external.cjs'` — `.cjs` extension + `exports` map.
- **`drizzle-orm`**: `'./alias.cjs'` — same.
- **`express`**: `'./lib/express'` — directory-with-package.json fallback missing.
- **`pg`**: `'./client'`.
- **`mocha`/`mysql2`/`ioredis`/`redis`/`@libsql/client`/`puppeteer-core`/`react-remove-scroll`/`react-remove-scroll-bar`** (Mossaic case): all subpath/condition.
- **`framer-motion`/`react-remove-scroll`**: bare `framer-motion` doesn't resolve at root because `dist/es/index.mjs` (per `exports`) is what `__resolvePkgEntry` fails to find.
- **`axios`**: cascades to `'./db.json'` (mime-db) — `.json` extension probe.
- **`fastify`**: `Cannot find module 'fastq' (from .../avvio)` — bare-from-nested doesn't walk up properly.
- **`ts-jest`**: `'./legacy/ts-jest-transformer'` — extension probing.
- **`ts-node`**: `'./util'` — extension probing.

**One bug fix lifts ~18 packages.** Same finding as prior audit; nothing
shipped to address it yet.

### P2 — Native bindings can't dlopen `.node` (≈8 pkgs) 🔴

| Package | Specific failure |
|---|---|
| `sharp` | `'./constructor'` — exports gap before native dlopen even tries |
| `bcrypt` | `'./node-gyp-build.js'` — postinstall didn't run |
| `better-sqlite3` | `'./database'` — exports gap |
| `node-canvas` | `'./lib/canvas'` — exports gap |
| `@swc/core` | `'./binding'` — npm 4828 (optDep platform pkg not selected) |
| `@tailwindcss/oxide` | explicit `Cannot find native binding. npm has a bug...` |
| `prisma` | `Cannot find module 'prisma' (from /home/user/app)` — CLI-shaped, no library entry |
| `puppeteer-core` | `'./index.js'` — node condition not honoured |

Several blur into P1 (the exports-gap surfaces first; native dlopen would
still fail after). All ultimately need WASM swap or hard refusal — see
Section 04.

### P3 — `__vfsBundle` doesn't include the package code at runtime (4 pkgs) 🟠

`Cannot load module 'X': file was not pre-bundled. Add it to the VFS bundle.`

- `astro`
- `nuxt`
- `vitest`
- `@tailwindcss/vite`

The pre-bundle path exists but doesn't propagate to user-shell `node` runner
for these large packages. Either too big for slice cap, or framework-shaped
entry not detected.

### P4 — `SKIP_PACKAGES` silent-success (4 pkgs) 🟡

`vite`, `webpack`, `rollup`, `parcel` install with `added 0 packages` — the
CLI prints success, the directory is absent, runtime says `Cannot find`. UX
trap. (Source: `src/npm-resolver.ts:754-776`.)

### P5 — Missing builtin (1 pkg, wide blast radius) 🟠

- **`jsdom`**: `Cannot find module 'vm' (from home/user/app/node_modules/jsdom/lib)` — verified via probe ([jsdom.out.txt:](../probes/packages/jsdom.out.txt) line near `Process 2 ... exited with code 1`).

`vm` shim missing in `src/node-shims.ts:771-849 builtins` table.
Same shim missing blocks any package that does `vm.runInNewContext`
(jsdom, jiti, ts-node-internal-vm, mock-require, source-map-support).

### P6 — Peer dependencies not installed (≈2 pkgs explicit, many implicit) 🟠

- `@remix-run/react` → needs `react-router-dom` peer
- `@radix-ui/react-dialog` → needs `react`/`react-dom` (probe explicitly added them, error survived → root cause is P1 not P6)

The codebase has **2 src/ refs to `peerDeps`** total (per the user's prompt
hint). Verified: `grep "peerDep" src/` — Section 03 will quote exactly.

### P7 — Bare specifier doesn't walk-up (1 pkg) 🟢

- `fastify`: `Cannot find module 'fastq' (from home/user/app/node_modules/avvio)` — `avvio` does `require('fastq')` but resolver doesn't walk from `avvio/` back up to root `node_modules/fastq`.

This is `__resolveNodeModule` at `src/node-shims.ts:920-960` — the walk-up
loop should find root-level `node_modules/fastq` but doesn't, suggesting
fromDir handling or visited-set bug. Worth a separate dive in W2.

## Top-5 highest-leverage mitigations

| Rank | Mitigation | Pkgs unblocked | Wave |
|---|---|---|---|
| **1** | Implement `package.json#exports` (subpath patterns + conditions) and `imports` (`#name`) in `src/node-shims.ts:__resolvePkgEntry` | ~18 | W2 |
| **2** | Add `vm` builtin shim using `Function`-based `runInNewContext` at module-eval time | ~3 (jsdom + ts-node + jiti family) | W2 |
| **3** | Share pre-bundle cache with user-shell `node` runner | 4 (astro/nuxt/vitest/@tailwindcss/vite) | W3 |
| **4** | WASM swap layer (`bcrypt → bcryptjs` etc.) + REJECT-INSTALL list (`better-sqlite3`, `prisma`, `node-pty`) | ~6 | W4 |
| **5** | Auto-install `peerDependencies` (currently entirely absent — see Section 03) | ~2 explicit, many transitive | W3 |

Mitigation #1 is the **single most impactful unblock**: ~150 LOC fix lifts
~18/33 from ⚠️ to ✅ — moves coverage from 3% → 57% on this set.

## Notable deltas vs prior audit @ `78bc817`

Prior audit (`memory/`-stored, may not survive sandbox reset) found the
same root causes. **Nothing in W1's 6 commits addresses them** — W1 was
the edge-contract effort (Tailwind vendoring, jsdelivr removal,
synthetic-entry barrels, stub-module for transitives, scoped slice). All
P1-P7 above are still open.

## Post-W2.6a measured (HEAD `bebeaee` / prod `3d7b6ff7`)

W2.6a replaced `buildVfsBundle` (whole-tree-with-cap walk) with
`buildPrefetchBundle` (static reachable-set via `require-resolver.ts` +
greedy oversample of every pkg's `package.json` + main entry, gated on
JSON-encoded UTF-8 byte size). Resolver unification (D6) folded the
`npm-resolver.ts` thin wrappers into the shared
`src/_shared/exports-resolver.ts`. D2 missing-target fallback added in
`__resolvePkgSubpath`.

Probe artifacts: [`audit/probes/packages-prod-w26a/<name>.out.txt`](../probes/packages-prod-w26a/) +
[`run-w26a-resolver-fallback.mjs`](../probes/run-w26a-resolver-fallback.mjs)
(focused D2 fallback regression — synthesizes a fixture pkg with
declared-but-missing entry; asserts require returns the index sentinel).

| Suite | Result |
|---|---|
| install-pipeline-coverage (4 scenarios) | **3/4 PASS** (fastify, express, redis ✅; ts-jest still missing typescript per D3 deferral) |
| 33-pkg smoke | **5/33 ✅** (predicted +3 → realized +1) |
| Mossaic regression | **PASS** (status=200, external=0, vite running) |
| Wave 1 contract (`/preview/` external host count) | **0** (preserved) |
| D2 fallback regression | **PASS** (fixture pkg returns index sentinel via fallback path) |

**Failure-mode shift on the W2.6a-target-but-still-⚠️ packages:**

| Pkg | W2.5b error | W2.6a error | Layer |
|---|---|---|---|
| fastify | `Cannot find module 'fastq'` | `Cannot find module 'node:diagnostics_channel'` | **deeper** — fastq now resolves; new wall = missing builtin shim (W3) |
| redis | `Cannot find './lib/RESP/decoder'` | `Cannot read module: @redis/client/dist/lib/client` | partial — manifest sees the file; content evicted by encoded-size cap |
| express | `Object prototype may only be Object or null` | (same) | unchanged — W2.6a thesis didn't catch this |
| puppeteer-core | `Cannot find './locators/locators.js'` | `Cannot find module 'node:fs/promises'` | **deeper** — locators resolved; new wall = missing builtin (W3) |
| framer-motion | `Cannot find module 'framer-motion'` | `Cannot find module 'react/jsx-runtime'` | **deeper** — pkg now resolves; smoke probe missing peer dep |
| radix-react-dialog | `Cannot find module 'react-remove-scroll/dist/es2015/index.js'` | `Cannot find module 'react'` | **deeper** — peer dep |
| ts-jest | `Cannot find module 'typescript'` | (same) | unchanged — typescript pkg drops out of install (D3 deferred) |

The pattern is consistent: W2.6a's prefetch + greedy oversample pushed
the require chain past the W2.5b walls for fastify/puppeteer/redis/etc.,
but each hit a NEW wall one layer deeper — typically a missing builtin
shim (W3 territory) or a peer-dependency-not-installed-by-smoke
(test-harness gap, not a Nimbus bug).

## Citations

- `SKIP_PACKAGES`: `src/npm-resolver.ts:754-776`
- Resolver: `src/node-shims.ts:880-913 __resolvePkgEntry`, `:920-960 __resolveNodeModule`, `:881 exts list`
- Builtins table: `src/node-shims.ts:771-849`
- Prebundle gap: `src/pre-bundle-facet.ts:467-562`, `src/cirrus-real.ts:642`
- npm bug 4828 (optDep platform pkg): https://github.com/npm/cli/issues/4828
- W2.6a code: `src/facet-manager.ts:487-666 buildPrefetchBundle`, `src/require-resolver.ts:109-303`, `src/node-shims.ts:982-1019 __resolvePkgSubpath` (D2 fallback)
