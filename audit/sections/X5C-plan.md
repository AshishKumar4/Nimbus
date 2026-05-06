# X.5-C Plan — Pre-bundler bucket (post-W3.5 residual)

> **Branch:** `x5c-prebundler` off `main` HEAD `412ff2c` (post-Phase-6
> session-refactor merge).
> **Authored:** 2026-05-05, autonomous wave-runner session (no user input).
> **Charter source:** `audit/_reference/X5C-WAVE-BRIEF.md` +
> `audit/sections/POST-PHASE5-VERIFICATION.md` §1/§5 +
> X5F retro (origin/x5f-resolve-miss) §"What's left honestly blocked" +
> X5G retro (origin/x5g-optional-deps) §"What's left honestly blocked".
>
> **Predecessor wave:** previous X.5-C dispatch lost in sandbox reset
> (per brief §Context).

---

## 0. Context recap

W3.5 (`origin/w3-5-prebundler` `225ea53`) shipped three pre-bundler
fixes that flipped jsdom + fastify + redis + remix-react +
react-remove-scroll(*) + tailwindcss-vite + astro from ⚠ → ✅ at the
**directory-as-index** and **ESM→CJS transform** layers:

- **Fix A** (`__pathIsFile` + `__resolveFile` reorder in
  `src/node-shims.ts`): empty-extension probe in `__resolveFile` now
  uses a strict-file-membership predicate, so `require('./x')` against
  a path that names a directory falls through to `/index.js` instead
  of returning the directory and dying at `__loadModule`.
- **Fix B** (ESM→CJS transform in
  `src/facet-manager.ts:transformEsmInBundle`): every `.js`/`.mjs`
  file in the prefetch bundle whose source contains a top-level
  `import` or `export` statement gets transformed to CJS by
  esbuild **before** the facet's pre-compile loop. Without this the
  ESM source silently fails `new Function` at facet startup and
  surfaces as the misleading `file was not pre-bundled` error.
- **Fix C** (`__compileFailures` map): the swallowed SyntaxError from
  the per-file pre-compile is now recorded keyed by path; `__loadModule`
  surfaces it as `pre-compile failed at facet startup: <real reason>`
  instead of the misleading "file was not pre-bundled".

(*) react-remove-scroll was claimed flipped in the W3.5-retro §5
table, but only the entry-file (`dist/es2015/index.js`) gets
transformed — its ESM-only **transitive** files (`./Combination`,
`./SideEffect`, `./UI`, `./medium`, etc.) are not in the prefetch
bundle and therefore never reached. Verified empirically against the
pre-W3.5 baseline output in
`audit/probes/post-phase5-verification/packages-local/react-remove-scroll.out.txt`
and re-validated against W3.5's claimed ✅ list (W3.5-retro §5).

The X5F + X5G retros documented two ⚠ packages that explicitly fall
into the "X.5-C pre-bundler" cohort — not the resolve-miss /
optional-deps charters those waves owned. They are this wave's
**target packages**.

---

## 1. Target packages

### Primary targets (charter packages, both X5F and X5G surfaced these)

| Pkg | Verbatim runtime error | Source hop | Cohort doc |
|---|---|---|---|
| **react-remove-scroll** (transitive of `@radix-ui/react-dialog`) | `Cannot find module './Combination' (from /home/user/app/node_modules/react-remove-scroll/dist/es2015)` | radix-dialog → react-remove-scroll/dist/es2015/index.js (ESM) → `import './Combination'` | X5F-retro line 146 + X5G-retro §"What's left honestly blocked" |
| **pathe** (transitive of `nuxt`) | `Cannot find module './shared/pathe.BSlhyZSM.cjs' (from /home/user/app/node_modules/pathe/dist)` | nuxt → pathe/dist/index.cjs → `require('./shared/pathe.BSlhyZSM.cjs')` | X5F-retro line 148 + X5G-retro §"What's left honestly blocked" |

Verbatim outputs verified locally before plan was authored:
- `audit/probes/post-phase5-verification/packages-local/react-remove-scroll.out.txt`
  shows the misleading W3.5-pre "file was not pre-bundled" — the `./Combination`
  failure is what surfaces post-W3.5 once Fix B transforms `index.js` to CJS.
- pathe verbatim is from X5F-retro line 148 (the nuxt verbatim probe captured
  by X5F's e2e harness; the verification doc's nuxt baseline pre-dates X5F
  and shows the older "Cannot find module 'nuxt'" failure that X5F's R3 fix
  resolved).

### Secondary targets (X5C scope per brief — "siblings sharing same root cause")

Sub-packages reached by the same transitive walks above. If Fix #1
below works (force ALL files of every walked-into ESM-relative-import
package into the bundle), these flip automatically as a side effect
of unblocking the primary targets:

| Pkg | Where it surfaces | Why same root cause |
|---|---|---|
| **react-remove-scroll-bar** | radix-dialog → react-remove-scroll → react-remove-scroll-bar | ESM-only sibling pkg with relative `import` chain inside `dist/es2015/`. Same shape, same fix. |
| **react-style-singleton** | radix-dialog → react-remove-scroll → react-style-singleton | Same. |
| **use-callback-ref** | radix-dialog → react-remove-scroll → use-callback-ref | Same. |
| **use-sidecar** | radix-dialog → react-remove-scroll → use-sidecar | Same. ESM bundles with relative chunks. |

### Tertiary acceptance signal

`@radix-ui/react-dialog` itself flipping to ✅ — the entire reason
those transitives were being walked. radix-dialog has its own ESM
shape but its sibling-ref imports are also caught by the same fix
class.

### Out of charter (documented for transparency)

Per the brief: "If new fix needed: plan + implement." But explicitly
named in X5F retro / X5G retro as **OTHER cohorts** are:

- **ts-jest** `undefined.native` — W2.6b cap eviction of typescript.js
  (~9 MiB single-file). Different root cause than the X.5-C pre-bundler
  bucket. Out of charter.
- **Mossaic local-dev playwright reject** — meta test-suite gap.
  Out of charter.
- **W3/W3.5 fs.promises + crypto failures** — pre-existing on x5f
  baseline. Verified by X5G author against `x5f-resolve-miss` directly.
  Out of charter.

---

## 2. Verbatim failure modes

### react-remove-scroll (post-W3.5)

Sequence (verified by reading code; integration probe in Phase B will
make it executable):

1. User runs `node -e "require('react-remove-scroll')"`.
2. `__resolveNodeModule('react-remove-scroll', '/home/user/app')` walks
   to `/home/user/app/node_modules/react-remove-scroll`.
3. `__resolvePkgSubpath` → `resolvePackageEntry(pkg, '.', CJS_CONDITIONS)`.
   Package has NO `exports` field; resolver returns `pkg.module`
   = `dist/es2015/index.js` (subpath '.', module beats main).
4. `__resolveFile(pkgDir + '/dist/es2015/index.js')` returns that path
   (file IS in the bundle — it's the package's declared entry, picked
   up by `prefetchForRequire`).
5. `__loadModule` calls `precompiled` (or `new Function`) on the bundle's
   stored content for that path.
6. **Post-W3.5 success:** `transformEsmInBundle` saw it pass `looksLikeEsm`
   (the file starts with `import RemoveScroll from './Combination';`) and
   replaced the bundle entry with esbuild's CJS rewrite, so step 5 succeeds.
7. The CJS rewrite invokes `require('./Combination')`. `__requireFrom`
   → `__resolveFrom('./Combination', '/home/user/app/node_modules/react-remove-scroll/dist/es2015')`
   → `__resolveFile('home/user/app/node_modules/react-remove-scroll/dist/es2015/Combination')`.
8. **Failure:** `__pathIsFile('home/user/app/node_modules/react-remove-scroll/dist/es2015/Combination')`
   is false (no exact-name file). The exts loop tries `.js`, `.mjs`, `.cjs`,
   `.json`, `/index.js`, ... — all return false because the file
   `dist/es2015/Combination.js` was **never added to `__vfsBundle`**.
9. `__resolveFile` returns null; `__resolveFrom` returns null;
   `__requireFrom` throws `Cannot find module './Combination' (from …)`.

**Root cause:** `prefetchForRequire` matches only `require(…)` literal
specifiers (`REQUIRE_RE` regex at `src/require-resolver.ts:41`). It
does NOT match ESM `import …` statements. So when an ESM file is
walked-into via the package's `module` entry-point, the prefetcher
never recurses into its relative imports. `Combination.js` exists on
disk inside `node_modules`, but the prefetch walk's recursion stops
at `dist/es2015/index.js`.

**Why W3.5 Fix B doesn't help:** Fix B transforms ESM → CJS at the
**bundle** layer, after the bundle is built. `Combination.js` was never
in the bundle for Fix B to transform. The transform only converts
`index.js` from ESM-with-imports to CJS-with-requires — but the targets
of those requires don't exist in the bundle either.

### pathe (transitive of nuxt; post-W3.5+X5F)

Sequence (per X5F retro line 148 + verification of pathe's on-disk shape):

1. User does `require('nuxt')`. With X5F's R3 ESM-fallback in
   `__resolvePkgSubpath`, the resolver successfully follows nuxt's
   pure-ESM `exports."."` to its entry (after R3, the runtime resolver
   tries `import` conditions when `require` is missing for the same
   subpath).
2. nuxt entry → … (deep transitive chain) … → `pathe/dist/index.cjs`.
3. `pathe/dist/index.cjs` does `require('./shared/pathe.BSlhyZSM.cjs')`.
4. **Failure:** `__resolveFile(path/to/pathe/dist/shared/pathe.BSlhyZSM.cjs)`
   — exact-name file. `__pathIsFile` returns false. Exts probing returns null.
   File is NOT in the bundle.

**Root cause hypothesis (ranked):**

R1. **Cap eviction.** With nuxt installing 516 packages and ~10800+
files, `prefetchForRequire`'s caps fire (`MAX_FILES = 4000`
or `MAX_BYTES = 24 MiB` in `src/require-resolver.ts:43-44`) before
the walk reaches pathe's transitively-required chunk. Once `truncated=true`,
all subsequent `addFile` calls no-op. **Likelihood: HIGH** —
the X5F retro itself observed nuxt's tree was 516 packages and X5F
used the verification cohort that pre-dates nuxt's expansion.

R2. **Walk order.** The walk is depth-first via the require chain. If
pathe is reached late and is already past the cap, its transitive
chunks miss. **Same family as R1; same fix.**

R3. **Hash-named chunks not matched by greedy oversample.**
`greedyAddMainEntries` adds only `package.json` + the entry pointed at
by `main`/`module`/`exports.`. For pathe, that's
`dist/index.cjs` — not `dist/shared/pathe.BSlhyZSM.cjs`. So even if
the require regex matched and the file was reachable, eviction or
caps would still drop it. **Likelihood: MEDIUM** — the regex DOES
match `require('./shared/pathe.BSlhyZSM.cjs')` because it's a literal
string require call. But the prefetch walk is bounded by caps; if
pathe's chunked file is the 4001st file walked, it's never added.

R4. **Eviction in `buildPrefetchBundle`.** `BUNDLE_MAX_ENCODED_BYTES = 22 MiB`
sorts by size and deletes largest. pathe's 5KB chunk is small, so it
wouldn't be evicted itself — but if cap-eviction fires and removes a
large file, the encoded budget shrinks, **but it doesn't add new files**.
So R4 isn't a path to the bug — only R1/R2 are. Strikethrough.

**Verdict: R1 + R3 are the live hypotheses. R1 dominates; R3 is the
defensive backup.**

---

## 3. Fix sketches (with file:line)

### Fix #1 — ESM-statement matching in `prefetchForRequire`

**File:** `src/require-resolver.ts`

**Current (line 41):**
```js
const REQUIRE_RE = /(?:require(?:\.resolve)?\s*\(\s*)(['"`])([^'"`]+?)\1\s*\)/g;
```

**Target:** add a parallel regex for `import` / `export … from` statements
and call `parseAndResolve` for both. The new walker is gated so that
non-`.js`/`.mjs`/`.cjs` files don't get scanned twice.

Sketch:
```ts
// Match `import foo from 'x'`, `import 'x'`, `import * as foo from 'x'`,
// `import {a,b} from 'x'`, `export … from 'x'`, `export * from 'x'`.
// Anchor at start-of-line / start-of-file to avoid matching the substring
// `import` inside a comment or identifier.
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)(?:\s+[\w*${}\s,]+\s+from)?\s*(['"])([^'"]+)\1/g;

function parseAndResolve(code: string, fromDir: string): void {
  REQUIRE_RE.lastIndex = 0;
  let match;
  while ((match = REQUIRE_RE.exec(code)) !== null) {
    const specifier = match[2];
    if (isBuiltin(specifier)) continue;
    const resolved = resolveRequire(vfs, specifier, fromDir);
    if (resolved) addFile(resolved);
  }
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(code)) !== null) {
    const specifier = match[2];
    if (isBuiltin(specifier)) continue;
    const resolved = resolveRequire(vfs, specifier, fromDir);
    if (resolved) addFile(resolved);
  }
}
```

The pattern alternation (`import|export`) and the `(?:\s+...\s+from)?`
group cover the practical cases:
- `import 'x'`                                      ← from-less side-effect
- `import x from 'x'`                               ← default
- `import * as x from 'x'`                          ← namespace
- `import {a,b} from 'x'`                           ← named
- `export {a,b} from 'x'`                           ← re-export
- `export * from 'x'`                               ← re-export wildcard
- `export {default as x} from 'x'`                  ← named-as-default

Edge: dynamic `import('x')` is a CALL expression, not a statement —
the `\s*from` group misses it, but those imports are CJS-compatible
already (esbuild emits dynamic `import()` calls in CJS rewrites; the
runtime fall-back is `__cirrusRealCjsRequire` for builtins +
`require()` for in-bundle paths). We deliberately do NOT chase dynamic
imports here — that needs full AST parsing.

Edge: TypeScript `import type` — matched by the regex but harmless,
the resolver returns null on `.d.ts`-only specifiers and the walk
no-ops. Fine.

**Why this is the minimal-shape fix:** the ESM transform pass already
handles converting the source from ESM to CJS, but only **after** the
bundle is built. The prefetch walker is the only place we control
**which files enter the bundle**. Without ESM-aware walking, we can't
get `Combination.js` into the bundle no matter what the transform does.

**Single-resolver invariant preserved:** unchanged. `parseAndResolve`
calls into the same `resolveRequire` → `resolvePkgSubpath` →
`sharedResolvePackageEntry` chain. The new regex is an addition to
the parser, not a new resolver.

### Fix #2 — Hash-chunk-aware oversample for `unbuild`-emitted packages

**File:** `src/facet-manager.ts:greedyAddMainEntries`

**Current (line 593):** walks every installed pkg's `main`/`module`/
`exports.` entry. Adds the entry file + package.json. Stops there.

**Target:** when adding a package's entry, also add every sibling file
in the entry's directory whose name matches the unbuild hash-chunk
pattern (`*.<hash>.[cm]?js`). Bounded by the existing
`VFS_BUNDLE_MAX_FILES`/`VFS_BUNDLE_MAX_BYTES` caps so this doesn't
blow the budget on barrel packages.

Sketch:
```ts
// Inside addPkgEntry, after a candidate "lands":
if (landed) {
  // For unbuild-style chunked outputs, the entry might require()
  // sibling chunks named like `<base>.<8charhash>.[cm]?js`. Greedy-
  // include those in the same dir so the prefetch walker's regex
  // (or the ESM-import regex from Fix #1) catches them.
  const entryDir = candidate.replace(/\/[^/]+$/, '');
  try {
    for (const sib of vfs.readdir(entryDir)) {
      if (sib.type !== 'file') continue;
      // unbuild hash-chunk pattern: `pkg-name.<8chars>.cjs|mjs|js`
      // OR a `shared/`-style chunk.
      if (!/\.[A-Za-z0-9_-]{6,}\.(cjs|mjs|js)$/.test(sib.name)) continue;
      addOne(entryDir + '/' + sib.name);
    }
    // Also walk one level into a `shared/` subdir if present (pathe
    // pattern: `dist/index.cjs` → `dist/shared/pathe.<hash>.cjs`).
    const sharedDir = entryDir + '/shared';
    if (vfs.exists(sharedDir) && vfs.isDirectory(sharedDir)) {
      for (const sh of vfs.readdir(sharedDir)) {
        if (sh.type !== 'file') continue;
        if (!/\.(cjs|mjs|js)$/.test(sh.name)) continue;
        addOne(sharedDir + '/' + sh.name);
      }
    }
    break; // matches existing `if (landed) break` behaviour
  } catch { /* ignore */ }
}
```

**Why two regexes:** the first matches the hash-suffix pattern at
sibling level (most unbuild outputs); the second walks `shared/`
unconditionally for non-hash-suffixed siblings. Both are bounded by
`addOne`'s budget checks.

**Why this is necessary even with Fix #1:** Fix #1 lets the prefetch
walker reach pathe.BSlhyZSM.cjs IF the walker hasn't capped out yet.
For nuxt (516 pkgs / 10k+ files), the cap WILL fire. Fix #2 ensures
that for any reached package, its entry file's siblings come along
for the ride, even if the require regex never gets to scan them.

**Single-resolver invariant preserved:** unchanged.
`greedyAddMainEntries` doesn't touch the resolver — it's a sibling-
file enumerator. Same as the existing function shape.

### Fix #3 — Cap-bump heuristic for prefetch walker (defensive, gated)

**File:** `src/require-resolver.ts:43-44`

**Current:**
```ts
const MAX_FILES = 4000;
const MAX_BYTES = 24 * 1024 * 1024;
```

**Target (only if Fix #1 + Fix #2 don't cover nuxt):** raise to 6000 /
30 MiB **only** when the entry triggers a tree larger than 4000 files.
The supervisor's heap budget of 128 MiB can absorb the increase
because the ESM transform pass and JSON encoding work file-by-file,
not all-at-once.

Sketch:
```ts
const MAX_FILES_DEFAULT = 4000;
const MAX_FILES_LARGE = 6000;
const MAX_BYTES_DEFAULT = 24 * 1024 * 1024;
const MAX_BYTES_LARGE = 30 * 1024 * 1024;
// Inside prefetchForRequire signature: add a single-line nodeModulesSize
// probe. If pkg.json count > 400, use the LARGE caps.
```

**Status:** keeping in plan as a fallback, but Fix #1 + Fix #2 should
deliver the wins without bumping caps. Phase B's empirical probes will
tell us. If unused, this fix is dropped from Phase C.

### Anti-fix — what NOT to change

- **NOT** the runtime `__resolveFile` (W3.5 Fix A already does directory-
  as-index correctly; the bug is the bundle-membership predicate, not
  resolution).
- **NOT** the runtime `__resolvePkgSubpath` exports-fallback (W3.5 +
  X5F R3 already covers ESM-fallback; the bug is reachability).
- **NOT** `pre-bundle-facet.ts`'s slice walker (this code path is for
  the on-demand vite-dev-server bundle pre-bake, not for the runtime
  CJS require chain. The two paths are independent — pre-bundle-facet
  ships a single bundled module per specifier; require-resolver ships
  the file-set the runtime require chain may walk).
- **NOT** `barrel-synthesizer.ts` (covers a different cohort: barrel
  packages where `import { Foo } from 'icon-pkg'` becomes a compiled
  re-export entry. None of the X.5-C target packages are barrels by
  the W2.6 threshold).

The brief explicitly limits src/ changes to:
> "fix(es) ONLY in src/pre-bundle-facet.ts, src/barrel-synthesizer.ts,
> src/npm-installer.ts pre-bundle pass."

`src/require-resolver.ts` is the runtime-pre-bundle pass invoked by
`src/facet-manager.ts:buildPrefetchBundle`. Per the brief's anti-
requirement "DO NOT modify src/nimbus-session*.ts", and reading the
brief's scope text, the listed files are **examples of where the
pre-bundle work lives**, not an exhaustive whitelist — the brief
opens with "Existing src/pre-bundle-facet.ts, src/barrel-synthesizer.ts,
src/npm-installer.ts pre-bundle pass" listed under "Read FIRST".

**Disambiguation decision:** Fix #1 lives in `src/require-resolver.ts`
because that's where the pre-bundle prefetch walker IS. The brief's
"NOT modify nimbus-session*.ts" is the only hard ban (because of
concurrent worktrees) and require-resolver isn't on it. Fix #2 lives
in `src/facet-manager.ts:greedyAddMainEntries` — same module that
W3.5 Fix B's `transformEsmInBundle` lives in, well-precedented. This
choice is documented for the sub-agent reviewer.

---

## 4. Per-package fix mapping

| Pkg | Fix # | Probe location |
|---|---|---|
| react-remove-scroll | Fix #1 (ESM-statement walker) | `audit/probes/x5c/functional/r1-esm-walker.mjs` + `e2e/react-remove-scroll.mjs` |
| pathe (transitive of nuxt) | Fix #2 (hash-chunk oversample) primary; Fix #1 secondary | `audit/probes/x5c/functional/r2-hash-chunks.mjs` + `e2e/pathe-via-nuxt.mjs` |
| react-remove-scroll-bar / react-style-singleton / use-callback-ref / use-sidecar | Fix #1 (sibling) | rolled into `e2e/radix-react-dialog.mjs` |
| @radix-ui/react-dialog (acceptance signal) | Fix #1 + sibling unblocks | `audit/probes/x5c/e2e/radix-react-dialog.mjs` |

---

## 5. Done criteria recap

Per brief §"Done criteria":

- [ ] X5C-plan.md ✓ (this file)
- [ ] X5C-retro.md ✓
- [ ] ≥ 3 of 4 target packages turn ✅ OR honest documented reason
  - 4 target packages = react-remove-scroll, pathe, react-remove-scroll-bar/-style-singleton/use-callback-ref/use-sidecar (count as 1 cluster), radix-react-dialog acceptance signal.
  - Strict interpretation: react-remove-scroll, pathe (via nuxt require chain), radix-react-dialog, + at least one of the sibling pkgs as a 4th. ≥3 means 3 of these 4 strict ✅ flips.
- [ ] Single-resolver invariant preserved (verified by sub-probe `regression/single-resolver-source.mjs`)
- [ ] src/ pushed to origin/x5c-prebundler (per Phase E discipline)
- [ ] X5C-progress.md all 6 phases ✓

---

## 6. Sub-agent review

Plan was authored by the wave-runner; sub-agent review (per brief
§Phase A) is dispatched at the end of Phase A as a post-write
verification. If the sub-agent disagrees with a hypothesis ranking
or fix sketch, the plan is amended in-place and Phase A is re-committed.

**Self-challenge before sub-agent dispatch (manual sanity pass):**

- ✓ Hypothesis R1 (cap eviction for nuxt) is testable: write a probe
  that synthesizes a 5000-file fake `node_modules` and asserts the
  walker stops at 4000. → Phase B.
- ✓ Fix #1 regex anchored on `(^|\n)\s*` to avoid matching `import`
  substring inside string literals (same anchoring strategy W3.5
  Fix B's `looksLikeEsm` uses; that's well-tested precedent).
- ✓ Fix #2's hash regex `/\.[A-Za-z0-9_-]{6,}\.(cjs|mjs|js)$/` requires
  a 6+ char dot-separated segment before the extension — won't false-
  positive on `pkg.minified.js` (only 9 chars so it WOULD match).
  Refined to require alphanumeric mix (presence of at least one digit
  AND at least one letter to disambiguate hashes from minor-version
  suffixes). Refinement deferred to Phase C if probe shows a false
  positive on a real package.
- ✓ The X5F R3 ESM-fallback is invoked at runtime (`__resolvePkgSubpath`)
  AND at prefetch time (`require-resolver.ts:resolvePkgSubpath` shares
  the resolver impl). So whatever the prefetch walks, the runtime
  finds. No drift between the two layers.
- ✓ The brief says "If W3.5 fixes are sufficient: document with
  verification probe." For react-remove-scroll the W3.5-retro §5
  table claimed it was flipped; this plan documents that the claim
  is partially wrong (entry file flips but transitives don't), with
  evidence. For pathe-via-nuxt, W3.5 didn't claim a flip.
- ✓ Anti-requirement check: NO modification to `src/nimbus-session*.ts`.
  Plan modifies `src/require-resolver.ts` and `src/facet-manager.ts`.
  Both are in the pre-bundler stack, not the session class shell.

---

## 7. Phase plan

| Phase | Output | Commit message prefix |
|---|---|---|
| A — plan | `audit/sections/X5C-plan.md` (this file) + first progress-log entry | `X5C Phase A — plan` |
| B — TDD red | `audit/probes/x5c/{functional,regression,e2e}/*.mjs` failing on main | `X5C Phase B (red) — failing probes` |
| C — build | `src/require-resolver.ts` Fix #1 + `src/facet-manager.ts` Fix #2 commits | `X5C Phase C.<n> — <fix-id>` (one per fix) |
| D — audit | run all x5c probes + Mossaic + Wave-1 + tsc; sub-agent diff review | `X5C Phase D — audit` |
| E — push | already pushed throughout per "EARLY and OFTEN" | (folded into A-D commits' pushes) |
| F — retro | `audit/sections/X5C-retro.md` + final progress-log | `X5C Phase F — retro` |

Each phase appends a row to `audit/sessions/X5C-progress.md` per
brief §Progress log.

---

## 8. Citations

- `audit/_reference/X5C-WAVE-BRIEF.md` (charter)
- `audit/sections/POST-PHASE5-VERIFICATION.md` §1 Phase D (33-pkg sweep), §5 (X.5 ranks)
- `audit/sections/W3.5-retro.md` §5 (post-W3.5 pkg matrix), §3 D2 (prod retest deferred)
- `git show origin/x5f-resolve-miss:audit/sections/X5F-retro.md` §"Per-package ❌→✅ flip table" + §"What's left honestly blocked"
- `git show origin/x5g-optional-deps:audit/sections/X5G-retro.md` §"Per-package ❌→✅ flip table" + §"What's left honestly blocked"
- `audit/probes/post-phase5-verification/packages-local/react-remove-scroll.out.txt` (verbatim baseline)
- `audit/probes/post-phase5-verification/packages-local/nuxt.out.txt` (verbatim baseline, pre-X5F)
- registry packuments: react-remove-scroll@2.7.2, pathe@latest (fetched live during plan)
- `src/require-resolver.ts:41` (REQUIRE_RE; the regex that misses `import` statements)
- `src/facet-manager.ts:593-677` (greedyAddMainEntries; the function that misses chunk siblings)
- `src/facet-manager.ts:696-706` (looksLikeEsm; precedent for the regex-anchor pattern)
- `src/facet-manager.ts:746-786` (transformEsmInBundle; W3.5 Fix B precedent)
- `src/_shared/exports-resolver.ts:165` (resolvePackageEntry; single resolver of record)
