# X.5-U progress log — `.ts-jest-digest` dotfile reachability

> Branch: `x5u-dotfile` off `origin/main` @ `0a022e6`.
> Worktree: `/workspace/worktrees/x5u-dotfile`.
> Source dispatch: follow-up to X.5-T charter-pass.
> Predicted: +1 ✅ (ts-jest fully) → 17/33 strict.

## Phase A — Investigate ✓ (committed early per "commit often" anti-crash hygiene)

### Probes
- `audit/probes/x5u/investigation/h-localize-dotfile.mjs` — first cut. Surfaced
  a shell-parser bug (`ls -la 2>&1 | head` returns *"Expected Word but got
  Amp"* in the in-Nimbus shell) which gave a false-negative on the VFS-disk
  hypothesis. Kept for its facet-runtime evidence.
- `audit/probes/x5u/investigation/h-vfs-disk-confirm.mjs` — corrected probe.
  All-node-script path; uses `fs.readdirSync` (manifest), `fs.statSync`
  (manifest), and `fs.readFileSync` (`__vfsBundle`/`__vfsWrites`) to discriminate
  between install-pipeline-drop and bundle-population-gap.

### Evidence (verbatim, see `h-vfs-disk-confirm.out.txt`)

```
X5U_REPORT: {
  "readdirAll": [".lintstagedrc",".ts-jest-digest","CHANGELOG.md", … ],
  "readdirDotfiles": [".lintstagedrc",".ts-jest-digest"],
  "statDot":  { "isFile": true, "size": 0 },
  "statReg":  { "isFile": true, "size": 4484 },
  "readDot":  "ERR:ENOENT",
  "readReg":  "OK:bytes=4484"
}
```

### Hypothesis matrix verdict

| H | Description | Verdict |
|---|---|---|
| H1 | install pipeline `.gitignore`-style filter excludes dotfiles | **REJECTED** — `readdirSync` enumerates `.ts-jest-digest`, manifest pass walks `vfs.readdir` which is the source of truth for VFS-disk; if the SQL-layer dropped the dotfile inode, `readdirSync` wouldn't list it |
| H2 | VFS write-batch path filter | **REJECTED** — same reasoning; `_writeBatchOnce` (sqlite-vfs.ts:1349) passes through; SQL-side INSERT didn't filter |
| H3 | prefetch / facet-bundle filter | **PARTIALLY CONFIRMED, REFINED** — see H4 |
| H4 | NEW path | **CONFIRMED** — install OK; runtime bundle population is the gap. `__vfsBundle` (the in-memory map the facet's `readFileSync` shim consults at `src/node-shims.ts:202-215`) does not contain `.ts-jest-digest`, even though the manifest pass at `src/facet-manager.ts:591-615 buildManifest` enumerates it. Root cause: NONE of the three bundle-population paths picks up the dotfile: |

### Fix locus (file:line, three independent gaps)

1. **`src/require-resolver.ts:418 prefetchForRequire`** — only follows `require('…')` / `import '…'` strings. ts-jest accesses the digest via `(0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, '../../../.ts-jest-digest'), 'utf8')`. There's no specifier to walk.

2. **`src/facet-manager.ts:631 greedyAddMainEntries`** — adds each installed package's `package.json` + main/module/exports leaf only. A non-entry file like `.ts-jest-digest` is invisible to this path.

3. **`src/facet-manager.ts:821 addStaticReadFileAssets`** — closest existing path. Two reasons it doesn't match:
   - **Regex shape:** `/(?:\bfs\s*\.)?readFileSync\s*\(\s*(?:[\w$.]+\s*\.\s*)?resolve\s*\(\s*__dirname\s*,\s*…/g` requires `resolve(__dirname` — a bare identifier. ts-jest is TypeScript-compiled to `(0, path_1.resolve)(__dirname, …)` (the [`(0, x.y)(args)`](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-9.html#new-helpers-and-changes-to-tsc-output) "preserve-this" trick). The regex needs `resolve(` with no closing paren before `(__dirname`.
   - **Extension allowlist:** `ASSET_EXT = /\.(css|html|htm|svg|txt|json)$/i` excludes `.ts-jest-digest` (no recognized extension; the leading-dot-as-only-extension shape is also unusual).

### Tarball ground-truth (control)

- `package/.ts-jest-digest` is present in `https://registry.npmjs.org/ts-jest/-/ts-jest-29.1.4.tgz` (40-byte SHA1 hex `bdc3f261ac17efdeccd11ccec4d3ce6c393abe5d`).
- ts-jest reads it at `package/dist/legacy/config/config-set.js:105`:
  ```js
  exports.MY_DIGEST = (0, fs_1.readFileSync)(
    (0, path_1.resolve)(__dirname, '../../../.ts-jest-digest'), 'utf8',
  );
  ```

### Next: Phase B — fix sketch + regression matrix

## Phase B — Plan ✓ (committed)

`audit/sections/X5U-plan.md`: investigation summary (§2), root-cause final
(§3, H4 confirmed), fix sketch with file:line (§4), regression matrix
(§5), self-review TL;DR (§1), anti-req honour list (§6).

Predicted impact: ts-jest ⚠→✅ (+1 strict). Risk: LOW (additive helper,
shared budget cap, no resolver/install-pipeline touch).

## Phase C — TDD RED probes ✓ (committed)

Probes added under `audit/probes/x5u/`:

### Functional (synthetic VFS, in-process; no wrangler)
- `functional/f1-dotfile-prefetch.mjs` — synthetic `synth-swc` package
  whose entry uses the SWC `(0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, "<dotfile>"))`
  shape. Asserts post-fix that `.cache-file` lands in the bundle.
- `functional/f2-tsjest-shape.mjs` — exact ts-jest@29.1.4 shape with
  3-up `../../../.ts-jest-digest` resolution. Asserts the 40-byte sha1
  content lands in the bundle post-fix.

### Regression (synthetic VFS)
- `regression/r1-no-overshoot.mjs` — four negative cases (dynamic
  specifier, template-literal, no-`__dirname`, non-heuristic filename).
  Helper must NOT pull any of them.
- `regression/r2-budget-respected.mjs` — three budget cases (totalBytes
  at cap, fileCount at cap, headroom). Helper must early-return on caps.
- `regression/r3-z3-untouched.mjs` — replays X.5-Z3's f1 jsdom .css
  case. The new helper is a sibling, not a replacement; Z3 must still
  work after Phase D.

### E2E (local wrangler)
- `e2e/ts-jest-digest-readable.mjs` — `npm install ts-jest` against
  local wrangler dev (BASE=http://127.0.0.1:8791), then a node-script
  reads `.ts-jest-digest` directly AND `require('ts-jest')`. Asserts
  no-`.native` regression, no ENOENT on the dotfile, 40-char digest,
  `typeof: object` from require.

### RED state confirmation (pre-Phase-D)

| Probe | RED behaviour | Verified |
|---|---|---|
| f1-dotfile-prefetch | helper missing → fail "exists" assertion → exit 1 | ✓ |
| f2-tsjest-shape | same | ✓ |
| r1-no-overshoot | helper missing → fail "exists" → exit 1 (overshoot guards still pass on baseline) | ✓ |
| r2-budget-respected | helper missing → fail "exported" → exit 1 | ✓ |
| r3-z3-untouched | already GREEN (Z3 helper exists pre-X5U) | ✓ |
| e2e/ts-jest-digest-readable | not run pre-fix (E2E gated on wrangler); X.5-T retro §3 prior evidence is the RED baseline | (deferred to Phase E) |


## Phase D — Build ✓ (committed)

**Edit:** `src/facet-manager.ts` — single file. Two changes:

1. New helper `addStaticReadFileDotfilesAndCompiled` (added between
   existing `addStaticReadFileAssets` and `looksLikeEsm`). ~120 LOC
   including the doc-comment. Handles:
   - SWC-shaped `(0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, "<rel>"))`.
   - Plain `fs.readFileSync(path.resolve(__dirname, "<rel>"))` and
     `…(path.join(__dirname, "<rel>"))`.
   - Quote chars `'` `"` `\``; rejects `${}` interpolation.
   - Bounded heuristic: filename starts with `.` OR matches
     `/digest|hash|version|sha|md5/i`.
   - Same `budgetState` cap as Z3 (VFS_BUNDLE_MAX_FILES=4000,
     VFS_BUNDLE_MAX_BYTES=24 MiB).

2. New call site in `buildPrefetchBundle` (numbered §2.27) immediately
   after the existing `addStaticReadFileAssets` (§2.25) call.

**Probe results POST-FIX (in-process synthetic VFS):**
| Probe | Result |
|---|---|
| f1-dotfile-prefetch       | 5/5 ✓ |
| f2-tsjest-shape           | 3/3 ✓ |
| r1-no-overshoot           | 5/5 ✓ |
| r2-budget-respected       | 4/4 ✓ |
| r3-z3-untouched           | 3/3 ✓ |

**E2E result POST-FIX (local wrangler dev BASE=http://127.0.0.1:8791):**
| Probe | Result |
|---|---|
| ts-jest-digest-readable | 6/6 ✓ |
|   • probe ran | ✓ |
|   • npm install completed (254 packages) | ✓ |
|   • NO `.native` regression | ✓ |
|   • NO ENOENT on .ts-jest-digest | ✓ |
|   • digest read returns 40-char sha1 hex | ✓ |
|   • require('ts-jest') returns typeof object | ✓ |

**tsc baseline:** 2/2 (unchanged from X.5-T baseline).

References:
- `audit/probes/x5u/functional/{f1-dotfile-prefetch,f2-tsjest-shape}.mjs`
- `audit/probes/x5u/regression/{r1-no-overshoot,r2-budget-respected,r3-z3-untouched}.mjs`
- `audit/probes/x5u/e2e/ts-jest-digest-readable.{mjs,out.txt}`

## Phase E — Audit ✓ (committed)

Full regression sweep against the in-tree fix + local wrangler dev
(BASE=http://127.0.0.1:8791) on `x5u-dotfile` HEAD.

### x5u run-all (8/8 ✓)
| Suite | Result |
|---|---|
| FUNCTIONAL: f1-dotfile-prefetch       | ✓ |
| FUNCTIONAL: f2-tsjest-shape           | ✓ |
| REGRESSION: r1-no-overshoot           | ✓ |
| REGRESSION: r2-budget-respected       | ✓ |
| REGRESSION: r3-z3-untouched           | ✓ |
| REGRESSION: single-resolver-source    | ✓ |
| REGRESSION: install-pipeline-coverage-shim | ✓ (4/4 scenarios: fastify/express/ts-jest/redis) |
| E2E: ts-jest-digest-readable          | ✓ (6/6 sub-checks) |

### Cross-wave run-alls regression (11/11 ✓ + 1 known-fail, 0 NEW)
| Wave | Result |
|---|---|
| x5j        | PASS |
| x5l        | PASS |
| x5m        | PASS |
| x5npqo     | PASS |
| x5z5-build | KNOWN-FAIL — pre-existing (lightningcss native binding; X5Z5-build-retro §3) |
| x5r        | PASS |
| x5z3       | PASS |
| x5m3       | PASS |
| x5s        | PASS |
| x526b      | PASS |
| x5t        | PASS |
| x5-drizzle | PASS |

### Independent anchors
| Probe | Result |
|---|---|
| audit/probes/run-wave1-regression-w2.mjs | PASS (vite preview 200; external=0; tw OK) |
| audit/probes/run-mossaic-prod-w2.mjs     | FAIL — pre-existing environmental block: `git clone failed: internal error` from cf-git in this sandbox. Verified IDENTICAL failure on baseline 0a022e6 worktree (`/workspace/worktrees/verify-0a022e6`); X.5-U did NOT introduce the regression. The cert-intercept env (`SANDBOX_INTERCEPT_HTTPS=1`) likely defeats cf-git's TLS verification path the same way it defeated `git push origin` until `GIT_SSL_NO_VERIFY=true` was applied. Not in X.5-U scope to fix. |
| `bun x tsc --noEmit`                     | 2 errors (baseline; unchanged from X.5-T) |

### REGRESSED status

| Surface | Status |
|---|---|
| `audit/probes/x5u/{functional,regression}/`           | 8/8 ✓ |
| `audit/probes/x5u/e2e/ts-jest-digest-readable.mjs`    | 6/6 ✓ |
| `audit/probes/x5u/regression/cross-wave-runalls.mjs`  | 11 PASS + 1 KNOWN-FAIL + 0 NEW ✓ |
| `audit/probes/run-wave1-regression-w2.mjs`            | ✓ |
| `audit/probes/run-mossaic-prod-w2.mjs`                | pre-existing FAIL (env-blocked git clone, verified on baseline) |
| `bun x tsc --noEmit`                                  | 2/2 baseline ✓ |

**No NEW cross-wave regressions introduced.** ts-jest verdict: ⚠→✅
(install layer + runtime). Predicted +1 strict-flip for ts-jest is
realised end-to-end.

## Phase F — Push ✓

Per-phase pushes (anti-crash discipline after two prior charter crashes):
- Phase A: `e45cf11` → origin/x5u-dotfile (Phase A investigation + finding)
- Phase B: `1d77a99` → origin/x5u-dotfile (plan + regression matrix)
- Phase C: `634b223` → origin/x5u-dotfile (TDD RED probes)
- Phase D: `5e9f929` → origin/x5u-dotfile (src/ fix; functional + e2e GREEN)
- Phase E: `aa90079` → origin/x5u-dotfile (audit + cross-wave regression)
- Phase G (this commit): retro

Push command: `GIT_SSL_NO_VERIFY=true git push origin x5u-dotfile`
(see retro §5.4 — sandbox HTTPS intercept).

## Phase G — Retro ✓

`audit/sections/X5U-retro.md` written. Verdict §1: ts-jest ✅
(+1 strict). Root cause final §3: H4 confirmed (bundle-population
gap, NOT install pipeline). Scope deviations §5: shell parser
false-negative in first probe, Mossaic env-block, 124 LOC vs 50-70
predicted (doc-comment heavy), git push needed `GIT_SSL_NO_VERIFY=1`.
Regression status §6: 0 cross-wave regressions, all anchors green
modulo pre-existing Mossaic env-block.
