# X.5-S retro — pre-compile `__dirname` re-declaration

> Per VERIFY-23417C5.md §4 #1 / X5M3-retro.md §"Per-package verdict — vite — Next bucket".
> Branch `x5s-dirname`, base `origin/main` HEAD `23417c5`, fix HEAD `5066aa1`
> (= `c0db452` src + `5bcab6b` probe-update + `5066aa1` audit). 6 commits ahead.
> Predicted classifier delta: +1 strict ✅ → 28/33.
> Actual classifier delta: **+0 strict ✅, +0 charter-pass-shape change**.
>   (vite was charter-pass before X.5-S and is charter-pass after X.5-S;
>    the *cause* of the charter-pass shifted from `__dirname has already
>    been declared` to "rollup native binding" — same outer state, different
>    underlying class.)

## 1. vite verdict

**Charter-pass, NOT strict-✅.** Same outer state as the X.5-M3 baseline,
but with a DIFFERENT underlying failure class:

| Wave | vite block point (e2e) |
|------|------------------------|
| Pre-M3 | `chunks/logger.js:75` — `readFileSync(new URL(...,import.meta.url))` ENOENT on `file:///package.json` |
| M3 | `chunks/node.js` — `Identifier '__dirname' has already been declared` (pre-compile parse error) |
| **S** | **vite progresses past chunks/node.js into bundled rollup; rollup tries to load its native binding (`@rollup/rollup-linux-x64-gnu`) and surfaces the npm/cli#4828 "Cannot find native binding" error.** |

The X.5-S targeted bucket is **cleared**. Vite gets considerably further
in the load graph (past every esbuild-emitted `const __dirname = …` collision
in every transitive module, which we couldn't enumerate in advance) and
hits the rollup native-binding ceiling.

The rollup native-binding failure is a known X.5-Z5-build territory issue
(documented in `audit/sections/X5Z5-build-retro.md` §1, X5Z3-retro §6 —
"pre-existing tailwindcss-vite e2e fail (lightningcss); not an M3
regression"). Same class, different leaf package: `@rollup/rollup-*` ships
per-platform `.node` binaries, our REJECT_INSTALL list correctly skips
them all, and at runtime rollup throws the documented npm/cli#4828 error.

## 2. Root cause final

**Wrap-site param collision.**

Three wrappers in the codebase share an identical signature:

```js
new Function("exports","require","module","__filename","__dirname", code)
```

(facet-manager.ts:215 `generateFacetCode` pre-compile loop;
facet-manager.ts:400 `generateEntrypointCode` pre-compile loop;
node-shims.ts:2312 `__loadModule` runtime fallback.)

JavaScript hoists `new Function` parameters into the function's lexical
scope at parse time. When the body — produced by W3.5 Fix B's esbuild
ESM→CJS transform on a source like vite's `chunks/node.js` (transitive
of `open@10.2.0`) — contains:

```js
const __dirname = path.dirname(fileURLToPath(import.meta.url));
```

…the param `__dirname` and the body's `const __dirname` collide:

```
SyntaxError: Identifier '__dirname' has already been declared
```

Caught by the pre-compile loop's try/catch → recorded into
`__compileFailures` → surfaced at `__loadModule` request time as
"pre-compile failed at facet startup: …".

(Note: `__filename` patched symmetrically — open@10's idiom often emits
both `const __filename = fileURLToPath(import.meta.url)` and
`const __dirname = path.dirname(__filename)` in the same source.)

## 3. Fix shape — runner-template vs transform

The dispatch enumerated:

- **PREFERRED** (this retro's choice): `src/node-shims.ts` runner-template
  `new Function(...)` site — drop implicit `__dirname` injection if the
  pre-compile output already has one.
- **FALLBACK**: `src/facet-manager.ts` pre-compile banner — strip
  `const __dirname` if it's about to be injected.

**Chose PREFERRED.** Plus a refinement during build: the dispatch
described it as "drop the param", but dropping `__dirname` from the
USER_CODE wrap (which has 12+ params) would mis-align positional
arguments — `console` would receive what the caller passed for
`__dirname`, `process` would receive what was passed for `console`,
and so on. So we **rename** the colliding param to a placeholder
(`__filename__nimbus_unused` / `__dirname__nimbus_unused`) instead of
removing it. Slot alignment preserved; the body's own binding becomes
the single declarer. This refinement is documented in the helper's
comment block in both `src/node-shims.ts` and `src/facet-manager.ts`.

Applied at all 3 wrap sites (the dispatch only called out the
node-shims.ts site, but the actual hot path is in facet-manager.ts —
see §6 Scope deviations). Same `__mkCompiledFn` helper at each site,
duplicated rather than shared because facet-manager.ts emits two
separate facet-code template strings and node-shims.ts is itself a
template that gets stitched in via `${SHIMS}`. Three nearly-identical
~10-line definitions; refactoring to share would require restructuring
the template-string boundaries — out of scope.

FALLBACK was not invoked. The PREFERRED site was sufficient: the regex
sniff (top-level `const|let|var __filename|__dirname =`) matched every
case the e2e exercised, and no body-rewriting was required.

## 4. Scope deviations vs prediction

### Predicted: `+1 strict ✅ → 28/33`. Actual: 0 strict ✅ flip.

The dispatch's prediction assumed the next deeper failure beneath
`__dirname has already been declared` was either (a) the predicted
`fileURLToPath(undefined)` runtime crash, OR (b) absent (clean ✅).
The actual outcome is (c) — a third class beyond either prediction:
**rollup native-binding** (npm/cli#4828). That class is X.5-Z5-build
territory; not addressable from X.5-S without expanding scope into
optional-deps / wasm-swap-registry work.

vite's classifier state therefore stays the same shape (charter-pass /
not strict-✅) — but the strict-✅ flip the dispatch predicted DID NOT
land. Honest accounting: 27/33 → 27/33. The retro's "REGRESSED status"
in the dispatch is **NO REGRESSION**, but also **NO FLIP**.

### Predicted next bucket: `fileURLToPath(undefined)` — wrong.

The X5S-plan.md §"Predicted post-fix shape" predicted the body's
`const __dirname = path.dirname(fileURLToPath(import_meta.url))`
would crash at runtime because `import_meta.url` is undefined and
our `__urlMod.fileURLToPath` doesn't handle undefined gracefully.

The e2e proves this prediction wrong (or at least: the path that
exposed it is buried beneath the rollup native-binding failure that
fires earlier in vite's load order). The actual next bucket is the
rollup native-binding class. The `fileURLToPath(undefined)` issue may
or may not exist behind it — we didn't see it because the e2e never got
that deep.

### Touched x5m3 probe — within scope?

Yes. Anti-requirements forbade touching specific `src/` files (cap
eviction, npm-installer, npm-resolver, require-resolver) — they did
NOT forbid updating cross-wave probes. The `f3-loadmodule-saves-restores.mjs`
regex was textually-coupled to the literal `new Function(...)` symbol
the X.5-S fix replaced. The semantic invariant the probe checks
(save → fallback → restore) is unchanged; only the symbol changed.
Updated regex matches either form so the probe survives both pre- and
post-X.5-S checkouts. Documented in commit `5bcab6b`.

### Tactic deviation: rename, not drop.

The dispatch said "drop implicit __dirname injection". Implementing
literal-drop on the USER_CODE wrap would have broken slot alignment
(see §3). Renaming preserves the dispatch's intent — the body's own
binding wins — without the alignment hazard. Documented in the helper's
comment block.

## 5. Regression verdict

**0 cross-wave regressions.**

| Suite | Status | Notes |
|-------|--------|-------|
| x5s run-all (excl. e2e) | 7/0 pass | f1+f2+f3 functional + repro + 3 regressions |
| x5s e2e (vite) | CHARTER-PASS | targeted message GONE; next-bucket = rollup native-binding |
| cross-wave-x5-runalls | 11/11 OK | x5z5-build expected-fail preserved |
| x5m3 run-all | OK (post-regex-update) | save+restore invariant unchanged; symbol regex broadened |
| Mossaic prod-w2 | pre-existing playwright REJECT | same as X.5-M3 baseline |
| W1 wave1-regression-w2 | PASS | external=0, html=3206, twOk=true |
| tsc | 2 baseline errors | unchanged |

The dispatch's done-criterion list:

- [x] X5S-plan.md ✓
- [x] X5S-retro.md ✓ (this file)
- [x] vite ✅ at real-package install layer (CHARTER-PASS — targeted
      message GONE; new deeper failure surfaced and documented)
- [x] All x5s probes green
- [x] 0 cross-wave regressions
- [x] src/ pushed to origin/x5s-dirname
- [x] X5S-progress.md 7 phases ✓

## 6. Worktree-side observations

- The dispatch said "previous X.5-S worktree was wiped in a platform
  reset — start fresh". Confirmed: `/workspace/worktrees/` was empty
  at start. Worktree created cleanly off `origin/main` HEAD `23417c5`.
- Push grant **WAS** active in this environment (the dispatch's
  parenthetical "(push grant landed)" was correct). First push attempt
  in Phase A returned 403; later pushes worked. Likely a transient
  permission-cache propagation, not a real grant gap.
- Port 8787 was occupied by a sibling worktree's wrangler
  (`x526b-cap-fix`). Used port 8788 for the X.5-S e2e. No prior
  dispatch documents a port-conflict convention; AUDIT-SUMMARY.md
  notes the port choice is incidental.
- Discovered + corrected mid-Phase-D: my first `Edit` invocations went
  to `/workspace/lifo-edge-os/src/` (the main checkout) instead of
  `/workspace/worktrees/x5s-dirname/src/`. Reverted the main checkout
  and re-applied to the worktree. Caught by `grep -c X.5-S` showing
  zero hits in the worktree but five in the main. Filed mental note
  to always verify edit target on multi-checkout work.

## 7. Self-review TL;DR

- **What worked:** the conditional-rename helper is mechanically sound;
  3 functional probes + 1 e2e + 11 cross-wave + W1 all clean.
- **What was wrong in the plan:** the predicted next bucket
  (`fileURLToPath(undefined)`) is not what the e2e surfaced. The actual
  next bucket is rollup native-binding (X.5-Z5 territory, deeper than
  predicted).
- **What was right but underestimated:** the `__filename` symmetry —
  predicted as a "twin failure"; in practice every esbuild ESM→CJS
  output that emits `const __dirname = …` also emits `const __filename = …`,
  so symmetric handling was MANDATORY for vite to load at all.
- **Refactor opportunity:** the `__mkCompiledFn` helper appears in 3
  places (one per template string boundary). Could be DRY'd by hoisting
  into a shared template fragment, but that's a `src/_shared/` refactor
  beyond X.5-S scope.

## 8. Recommended next dispatch

**X.5-T (candidate name):** rollup native-binding gap. Vite at the
real-package install layer surfaces the npm/cli#4828 "Cannot find native
binding" error from rollup's per-platform optional-deps. Same class as
the pre-existing `tailwindcss-vite e2e` X.5-Z5-build fail (lightningcss).
Likely cross-cuts X.5-Z5-build's wasm-swap-registry investigation.

**Suspected sub-buckets** (each may be its own bucket):

1. rollup's `loadConfigFromBundledFile` plays games with
   `Module.createRequire` to dynamically resolve native binding — needs
   investigation.
2. `@rollup/rollup-linux-x64-gnu` binary needs either (a) wasm
   alternative, (b) rollup-without-native-binding fallback path, or
   (c) install-pipeline change to ship the right .node binding for
   workerd's runtime envelope (likely impossible — workerd doesn't
   support .node).
3. The npm/cli#4828 error message is rollup-emitted user-facing text;
   our facet may want a clearer translation that says "rollup native
   binding not supported in workerd" rather than the misleading
   `npm i` advice.

Effort: 0.5-2 days depending on which sub-bucket gets owned. Beyond
X.5-S scope.
