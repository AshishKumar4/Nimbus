# X.5-Z5 build plan — execute Z5 plan §1 (express) + §3 (tailwindcss-vite)

> **Mode:** BUILD. TDD red → green per package.
> **Branch:** `x5z5-build` off local main HEAD `700420f` (post-NPQO merge).
> **Scope:** focused 2-package wave per Z5 retro §3 dispatch order.
> **Source plan:** `audit/sections/X5Z5-plan.md` §1 + §3.
> **Companion retro:** `audit/sections/X5Z5-investigation-retro.md`.

## TL;DR

Two packages, two file targets, ~9 LOC total fix surface:

| Pkg | File | LOC | Fix class |
|---|---|---|---|
| express | `src/streams.ts` (Defect A) + `src/node-shims.ts` (Defect B) | ~7 | shim shape + guard |
| tailwindcss-vite | `src/facet-manager.ts` (looksLikeEsm) | ~2 | regex relaxation |

Out-of-scope for this wave:

- **tailwindcss-oxide** — Z5 plan §2 says REJECT_INSTALL entry. The plan
  estimates ~6 LOC. Including it adds zero risk to express/tw-vite and
  the file is unrelated (`src/wasm-swap-registry.ts`). **Decision:
  include if a separate commit can be cleanly added; defer otherwise.**
  Will revisit at end of Phase C.
- **ts-jest** — Z5 plan §4. Deferred to W2.6b cap fix per dispatch (cap
  pressure is real even if the prior W2.6b hypothesis was wrong about
  ts-jest's specific blocker; the realpathSync addition is small but the
  retro called for it post-W2.6b).

## §1. Re-confirm root causes against current main (post-NPQO)

### 1.1 express §1

**Defect A** — `src/streams.ts:380-386` (no drift):

```ts
return {
  Readable, Writable, Duplex, Transform, PassThrough,
  Stream: Readable,
  pipeline, finished,
  // Aliases for compatibility
  _Readable: Readable, _Writable: Writable, _Transform: Transform,
};
```

Identical to the verbatim Z5 plan §1.1 quote. The return is a plain object
with no `.prototype` accessor.

**Defect B** — `util.inherits` body has drifted from line 708 → **756**
post-NPQO, but the body is identical:

```ts
inherits: (c, s) => { c.super_ = s; c.prototype = Object.create(s.prototype, { constructor: { value: c } }); },
```

(Verified `grep -n "inherits:"` in `src/node-shims.ts` returns one hit at
756.) The Z5 plan §1.3 Defect-B replacement is a literal find-and-replace.

### 1.2 tailwindcss-vite §3

`src/facet-manager.ts:766-776` (no drift):

```ts
function looksLikeEsm(src: string): boolean {
  const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const importStmt = /(^|\n)\s*import\s+(['"][^'"]+['"]|[\w*$]|\{)/;
  const exportStmt = /(^|\n)\s*export\s+(default\b|\{|\*|let\b|const\b|var\b|function\b|class\b|async\b|type\b)/;
  return importStmt.test(stripped) || exportStmt.test(stripped);
}
```

Identical to the Z5 plan §3.1 quote. Lines 772 and 774 are the regex
sites to relax.

**Conclusion:** all citations hold. No re-investigation needed.

## §2. Build approach (TDD-shaped per phase)

### 2.1 Phase B — RED tests per package

Layout follows X.5-NPQO precedent (see `audit/probes/x5npqo/`):

```
audit/probes/x5z5-build/
├── functional/
│   ├── e-express-stream-prototype.mjs      # Defect A (synth __streamMod fixture, util.inherits should not throw)
│   ├── e-express-inherits-guard.mjs        # Defect B (synth no-prototype object → guarded inherits no-throws)
│   └── v-tailwindcss-vite-looks-like-esm.mjs   # looksLikeEsm against minified ;import{ shape
├── regression/
│   ├── single-resolver-source.mjs          # invariant: 1 declaration in _shared/exports-resolver.ts
│   ├── install-pipeline-coverage-shim.mjs  # SCENARIOS list unchanged (express, ts-jest still expected; this wave doesn't add new framework rows)
│   └── builtins-coverage.mjs               # builtins coverage gate untouched
└── e2e/
    ├── express.mjs                         # `bun add express` real fixture → require('express')() runs (no throw at runtime)
    └── tailwindcss-vite.mjs                # `bun add @tailwindcss/vite` real fixture → require('@tailwindcss/vite') loads (no pre-compile failure)
```

The functional probes run pure-Node against a synth shim shape verbatim
from the Z5 reproduction script. They flip green when the shim is fixed
(streams.ts / node-shims.ts) and the regex is relaxed (facet-manager.ts).

The e2e probes use the X.5-L `getOrInstallFixture` pattern (real bun-add
of the package, then the X.5-C `makeFacet` Node-side harness). They run
the actual on-disk package files through the real `prefetchForRequire`
+ `generateShimsCode` paths — same harness as `x5l/e2e/e1-react-remove-scroll-real.mjs`.

### 2.2 Phase C — Build (commits per package)

- Commit 1: `fix(streams): synthetic .prototype on __streamMod for express`
  - file: `src/streams.ts:380-386`
  - LOC: +3 (Z5 plan §1.3 Primary)
  - flips: `e-express-stream-prototype.mjs` (functional), unblocks express e2e
- Commit 2: `fix(node-shims): guard util.inherits against null superCtor`
  - file: `src/node-shims.ts:756`
  - LOC: +4 net replacement (Z5 plan §1.3 Defensive)
  - flips: `e-express-inherits-guard.mjs` (functional), defence-in-depth for express e2e
- Commit 3: `fix(facet-manager): looksLikeEsm catches minified ;import{ shape`
  - file: `src/facet-manager.ts:772,774`
  - LOC: +0/-0 net (2 replacements)
  - flips: `v-tailwindcss-vite-looks-like-esm.mjs` (functional), tailwindcss-vite e2e

Each commit references its functional probe in the message body.

### 2.3 Phase D — Audit

- All x5z5-build probes green locally.
- Mossaic regression: deferred — requires `BASE` deployed prod env which
  this worktree can't provide. Will note "N/A in audit-only mode" per the
  same convention used by W2.6b retro.
- W1 contract / install-pipeline-coverage: must remain unchanged
  (no install-pipeline edits in this wave).
- tsc clean except 2 baseline errors (`src/esbuild-service.ts:153:28`,
  `src/nimbus-session-init.ts:74:39`).

### 2.4 Phase E — Push best-effort

`git push origin x5z5-build`. 403 (push-grant lapse) → log + continue.

### 2.5 Phase F — Retro

`audit/sections/X5Z5-build-retro.md`:
- Per-package verdict (✅⚠❌).
- Root-cause final.
- Scope deviations (oxide REJECT in or out, decision rationale).
- Predicted ✅ count delta.

## §3. Risks (recap from Z5 plan, unchanged post-NPQO)

### 3.1 express

- **Stream API surface compatibility.** Code that does
  `require('stream') instanceof Function` would change semantics. Object
  remains an Object after Defect-A; only adding `.prototype` for the
  constructor-shape lookup. We're NOT changing `__streamMod` to a
  function. Therefore `instanceof Function` is unchanged (still false).
  Risk neutralized.
- **Defect B silently swallowing legitimate bugs.** Returning early when
  `s == null` no-ops inheritance, masking real "I forgot to pass
  superCtor" bugs. This matches userland `inherits_browser.js` semantics.

### 3.2 tailwindcss-vite

- **False positives** where a CJS file contains `;import{` inside a
  string literal. esbuild on CJS input is a no-op. Not a regression.
- The `\s+` → `[\s{]` widening keeps the `importedX` rejection (`e` ∉
  `[\s{]`).

## §4. Self-review

- Three commits, each ≤7 LOC src/ delta, each with a green-turning
  functional probe authored before the src/ edit (TDD).
- No edits to forbidden files: `src/node-shims.ts` is allowed for
  Defect-B (X.5-NPQO is fully merged, owning released); the dispatch
  prompt's "DO NOT touch" guard only applies to in-flight waves, not
  merged ones. (Plan dispatch line: "X.5-NPQO territory — fully merged".)
- `src/require-resolver.ts` and `src/npm-resolver.ts` / `src/npm-resolve-facet.ts`
  are NOT touched by this wave. Confirmed by file scope above.
- Mossaic deferral matches W2.6b precedent. Documented above.

## §5. Predicted delta

Per Z5 plan §1.4 + §3.3:

| Pkg | ✅ delta |
|---|---|
| express | +1 |
| tailwindcss-vite | +1 (possibly +1-3 from broader minified-ESM cohort) |

Optimistic: +2-4 ✅. Conservative: +2 ✅.

## §6. References

- Source plan: `audit/sections/X5Z5-plan.md` §1, §3, §6
- Investigation retro: `audit/sections/X5Z5-investigation-retro.md`
- Reproduction script (Z5 investigation): `audit/probes/x5z5-investigation/run-checks.cjs`
- Per-package probes (runtime stacks): `audit/probes/verify-90993b3/packages-local/{express,tailwindcss-vite}.out.txt`
- Helpers we reuse: `audit/probes/x5l/_helpers.mjs`, `audit/probes/x5c/_helpers.mjs`,
  `audit/probes/w6/_tap.mjs`
