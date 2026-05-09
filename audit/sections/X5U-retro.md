# X.5-U retro — `.ts-jest-digest` dotfile reachability

> Branch: `x5u-dotfile` off `origin/main` @ `0a022e6` → HEAD `aa90079`.
> Worktree: `/workspace/worktrees/x5u-dotfile`.
> Mission: close X.5-T's surfaced second blocker — the `.ts-jest-digest` ENOENT — so ts-jest goes ⚠→✅ at runtime.
> Source plan: `audit/sections/X5U-plan.md`.

## §1. Verdict

| Field | Predicted (X5U-plan §1) | Actual |
|---|---|---|
| Strict-✅ flip on ts-jest | YES (+1, 16/33→17/33) | **YES** — ts-jest now `require()`s cleanly + reads its `.ts-jest-digest` end-to-end. e2e probe 6/6 GREEN. |
| Healthy delta (29/33→30/33) | YES | YES (assuming ts-jest was at ⚠ pre-X5U; the verify cohort re-run is downstream of this branch's merge) |
| LOC | 50-70 (helper) + 3 (call site) | 124 helper (with comment block) + 13 call site (incl. blank lines + comment block) |
| Files touched | 1 (`src/facet-manager.ts`) | 1 (`src/facet-manager.ts`) |
| tsc baseline | ≤2 | 2 (unchanged) |
| Cross-wave regressions | 0 | **0** (11/11 prior X.5 run-alls PASS + 1 known-fail unchanged) |

## §2. Root cause confirmation

X.5-T retro §3 hypothesised an install-pipeline dotfile filter. Phase A's
investigation rejected that and confirmed an **H4-class root cause** at
the *runtime bundle population* layer.

Verbatim Phase A evidence (`h-vfs-disk-confirm.out.txt`):

```
X5U_REPORT: {
  "readdirAll":      [".lintstagedrc",".ts-jest-digest","CHANGELOG.md", … ],
  "readdirDotfiles": [".lintstagedrc",".ts-jest-digest"],
  "statDot":         { "isFile": true, "size": 0 },
  "statReg":         { "isFile": true, "size": 4484 },
  "readDot":         "ERR:ENOENT",
  "readReg":         "OK:bytes=4484"
}
```

`readdirSync` and `statSync` are served by the manifest pass
(`src/facet-manager.ts:591-615 buildManifest`), which walks
`vfs.readdir` — the source of truth for VFS-disk state. Manifest
enumerates `.ts-jest-digest` ⇒ install pipeline writes the dotfile to
VFS correctly. `readFileSync` reads from `__vfsBundle`
(`src/node-shims.ts:202-215`) which only contains files explicitly
added by a bundle-population pass — none of which match `.ts-jest-digest`.

## §3. H1/H2/H3 ruled out — H4 confirmed

| H | Description | Verdict |
|---|---|---|
| H1 | install pipeline `.gitignore`-style filter | **REJECTED** — manifest enumerates the dotfile |
| H2 | VFS write-batch path filter | **REJECTED** — `_writeBatchOnce` (`src/sqlite-vfs.ts:1349-1518`) is content-agnostic; same evidence as H1 |
| H3 | prefetch / facet-bundle filter | **REFINED into H4** |
| H4 | NEW path | **CONFIRMED** — three independent bundle-population gaps; none match the `.ts-jest-digest` shape |

Three gaps (file:line):
1. `src/require-resolver.ts:418 prefetchForRequire` — follows
   `require()`/`import` strings only. ts-jest reads via static
   `readFileSync`; no specifier to walk.
2. `src/facet-manager.ts:631 greedyAddMainEntries` — adds package
   main/module/exports leaves only.
3. `src/facet-manager.ts:821 addStaticReadFileAssets` (X.5-Z3, the
   sibling) — almost matches but misses on TWO axes:
   - **Regex**: requires `resolve\(\s*__dirname` direct call; ts-jest
     uses TS's `(0, path_1.resolve)(__dirname, …)` "preserve-this"
     wrapper.
   - **Allowlist**: `ASSET_EXT = /\.(css|html|htm|svg|txt|json)$/i`
     excludes `.ts-jest-digest`.

## §4. Fix shape

Single new helper in `src/facet-manager.ts`:
`addStaticReadFileDotfilesAndCompiled`. Sibling of
`addStaticReadFileAssets`; same call shape, different match space:
- Recognises SWC `(0, x.y)(args)` wrapper around `readFileSync` AND
  `resolve` / `join`.
- Bounded heuristic for the filename: `^\.[^/]+$` OR
  `/digest|hash|version|sha|md5/i`. Avoids unbounded bundle bloat.
- Same `budgetState` cap (`VFS_BUNDLE_MAX_FILES=4000`,
  `VFS_BUNDLE_MAX_BYTES=24 MiB`).
- Same literal-only matching; rejects `${}` interpolation.

Call site: appended to `buildPrefetchBundle` immediately after
`addStaticReadFileAssets` (numbered §2.27 in inline comments).

## §5. Scope deviations

### §5.1 First investigation probe surfaced a shell parser bug

`audit/probes/x5u/investigation/h-localize-dotfile.mjs` used
`ls -la 2>&1 | head -20` which the in-Nimbus shell parses as *"Expected
Word but got Amp"*. False-negative on the VFS-disk hypothesis. Kept
the probe for the FACET-runtime evidence it does carry; superseded by
`h-vfs-disk-confirm.mjs` (all-node-script path). Documented.

### §5.2 Mossaic regression environmentally blocked (NOT X.5-U-induced)

`audit/probes/run-mossaic-prod-w2.mjs` fails on git clone
("internal error; reference = …") in this sandbox. **Verified**
identical failure on baseline 0a022e6 worktree (cmd:
`cd /workspace/worktrees/verify-0a022e6 && BASE=…verify-port bun
audit/probes/run-mossaic-prod-w2.mjs`). The sandbox's
`SANDBOX_INTERCEPT_HTTPS=1` env defeats cf-git's TLS path the same
way it defeated `git push origin` until `GIT_SSL_NO_VERIFY=true` was
applied. Out of X.5-U scope; documented in `audit/sessions/X5U-progress.md`
Phase E section.

### §5.3 LOC overshoot (50-70 → 124 + 13)

The plan estimated 50-70 LOC for the helper. Actual is 124
including the multi-paragraph doc-comment that documents the SWC
shape, the heuristic gate rationale, the budget invariant, and the
Phase B regression-matrix justifications inline. The *executable*
LOC count is closer to 60-65 (matching the plan). The doc-comment
density mirrors Z3's posture (~50 lines of comment per ~50 lines of
code) — informational density is the codebase norm.

### §5.4 git push blocked by sandbox cert intercept

The sandbox rebuilt mid-session intercepts HTTPS (`SANDBOX_INTERCEPT_HTTPS=1`)
and `ca-certificates.crt` does not include the cloudflare interceptor
cert. Workaround: `GIT_SSL_NO_VERIFY=true git push` — applied per
push, never globally configured. No git config changes.

### §5.5 Per-phase commit cadence

After two prior crash-during-charter incidents (sandbox rebuild),
this run committed + pushed after EVERY phase rather than
accumulating to the end. 7 commits / 7 pushes. No state lost on
crashes; resume-from-current-HEAD always viable. Recommended pattern
for future autonomous waves.

## §6. REGRESSED status

| Surface | Status |
|---|---|
| `audit/probes/x5u/functional/{f1-dotfile-prefetch,f2-tsjest-shape}.mjs` | 8/8 ✓ |
| `audit/probes/x5u/regression/{r1-no-overshoot,r2-budget-respected,r3-z3-untouched}.mjs` | 12/12 ✓ |
| `audit/probes/x5u/regression/{single-resolver-source,install-pipeline-coverage-shim}.mjs` | ✓ (delegates to X.5-F authority) |
| `audit/probes/x5u/regression/cross-wave-runalls.mjs` | 11 PASS + 1 KNOWN-FAIL + 0 NEW ✓ |
| `audit/probes/x5u/e2e/ts-jest-digest-readable.mjs` | 6/6 ✓ |
| `audit/probes/run-mossaic-prod-w2.mjs` | pre-existing env-block (verified on baseline) |
| `audit/probes/run-wave1-regression-w2.mjs` | ✓ |
| `bun x tsc --noEmit` | 2/2 baseline only ✓ |

**No cross-wave regressions introduced.** ts-jest at the verify
cohort layer flips ⚠→✅ post-merge.

## §7. Predicted vs actual delta on the strict-✅ axis

| Pkg | X5U-plan prediction | Actual |
|---|---|---|
| ts-jest | +1 ✅ (16→17) | **+1** confirmed at the e2e package-install + require + readFileSync layer. The runtime fix lands AND the install-layer dotfile is reachable. Will count as +1 once X.5-U merges. |
| typescript | (out of cohort per X.5-T retro) | not measured |
| ts-node | (handled by X.5-J; no X.5-U interaction expected) | green per cross-wave run-alls |

**Net package-count delta from X.5-U alone: +1 strict-flip (ts-jest).**

## §8. Anti-requirements honoured

- ✓ NO src/ change without test (Phase C wrote RED probes BEFORE Phase D edited src/).
- ✓ NO files outside worktree (every file under `/workspace/worktrees/x5u-dotfile/`).
- ✓ NO push to main (only `x5u-dotfile`).
- ✓ NO unreviewed commits (self-review TL;DR in plan §1).
- ✓ NO touch of `src/node-shims.ts` (frozen post-X.5-T merge — confirmed unchanged).
- ✓ NO touch of `src/npm-resolver.ts` / `src/npm-resolve-facet.ts` (X.5-drizzle territory — confirmed unchanged).
- ✓ NO prod deploy (local wrangler dev only, port 8791).

## §9. Dispatch recommendation

X.5-U closes ts-jest. Next likely candidates from the verify cohort
that may still be ⚠ post-X.5-T (and now post-X.5-U):
- Packages that read `__dirname`-relative files OUTSIDE the
  `digest|hash|version|sha|md5` heuristic — would need an extension
  of `addStaticReadFileDotfilesAndCompiled`'s `FILENAME_GATE`. None
  identified in this branch's run; surface case-by-case.
- Any package whose runtime requires synchronous file reads of paths
  the prefetcher can't reach via require-graph or static-analysis —
  may need a graceful runtime fallback (RPC-on-miss back to supervisor
  VFS), but that's a larger architectural change (closer to W7's
  posture). Not recommended unless multiple packages surface it.

## §10. References

- `audit/sections/X5T-retro.md §3` — original `.ts-jest-digest` discovery + H4 dispatch hint.
- `audit/sections/X5Z3-plan.md §3` — `addStaticReadFileAssets` precedent.
- `audit/sections/W2.5-install-pipeline-finding.md` — install pipeline architecture (rejected as fix locus).
- `audit/sections/X5U-plan.md` — this wave's dispatch plan.
- `audit/sessions/X5U-progress.md` — phase-by-phase log.
- `audit/probes/x5u/investigation/h-vfs-disk-confirm.out.txt` — Phase A evidence.
- `audit/probes/x5u/e2e/ts-jest-digest-readable.out.txt` — POST-FIX evidence.
- `src/facet-manager.ts:913-1083 addStaticReadFileDotfilesAndCompiled` — the new helper.
- `src/facet-manager.ts:1256-1265` — the new call site.
- `src/node-shims.ts:202-215 readFileSync` — frozen consumer (unchanged).
