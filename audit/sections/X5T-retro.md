# X.5-T retro — `ts-jest` realpathSync.native

> Branch: `x5t-tsjest` off `origin/main` @ `9d4b61d` → HEAD `3ef6404`.
> Worktree: `/workspace/worktrees/x5t-tsjest`.
> Mission: smallest known win — flip `ts-jest` ⚠→✅ via 3-LOC fix.
> Source plan: `audit/sections/X5T-plan.md`.

## §1. Verdict

| Field | Predicted (X5T-plan §1) | Actual |
|---|---|---|
| Strict-✅ flip on ts-jest | YES (+1, 16/33→17/33) | **PARTIAL** — first blocker (`.native`) eliminated; SECOND, ORTHOGONAL blocker surfaced (install-pipeline dotfile filtering on `.ts-jest-digest`) |
| Healthy delta (29/33→30/33) | YES | **NO** — ts-jest still ⚠/⛔ at the verify cohort layer pending dotfile fix |
| LOC | 3 | 3 (executable) + 5 (comment) |
| Files touched | 1 (`src/node-shims.ts`) | 1 (`src/node-shims.ts`) |
| tsc baseline | ≤2 | 2 (unchanged) |
| Cross-wave regressions | 0 | 0 |

## §2. Root cause confirmation

**X.5-Z5 plan §4 + X.5-26b retro §3.1 both correctly identified the FIRST blocker.** Verbatim functional probe stack pre-fix (Bun/JSC):

```
"undefined is not an object (evaluating '_fs.realpathSync.native')"
```

…is the structural equivalent of V8's:

```
TypeError: Cannot read properties of undefined (reading 'native')
    at getNodeSystem (typescript.js:8291:43)
```

The fix exactly per Z5 plan §4.3:
- Add `function realpathSync(p, opts) { return _resolve(String(p)); }` in `__fsMod` IIFE.
- Bind `realpathSync.native = realpathSync` so `!!_fs.realpathSync.native` is truthy and the `.native` branch is callable.
- Add `realpathSync` to the `__fsMod` return-object listing.

Functional probe post-fix: 9/9 GREEN. Same-ref invariant `fs.realpathSync === fs.realpathSync.native` per Z5 plan §4.3 holds. The TS getNodeSystem ternary at typescript.js:8291 now evaluates to a callable on both branches.

## §3. NEW deeper blocker discovered (out of X.5-T scope)

The e2e probe `audit/probes/x5t/e2e/ts-jest-real-install.mjs` confirms the `.native` blocker is GONE — no `Cannot read properties of undefined (reading 'native')` and no `getNodeSystem` stack — but ts-jest's runtime now fails at:

```
Error: ENOENT: no such file or directory, open '/home/user/app/node_modules/ts-jest/.ts-jest-digest'
    at readFileSync (runner.js:254:19)
    at eval (eval at __mkCompiledFn (runner.js:29:10), <anonymous>:70:43)
```

**Diagnosis:** the ts-jest tarball (`https://registry.npmjs.org/ts-jest/-/ts-jest-29.1.4.tgz`) DOES contain `package/.ts-jest-digest` (verified via `tar -tzf`). The file is being **dropped during install** by Nimbus's tarball-extraction pipeline, which appears to filter dotfile entries.

This is a **structurally different class** from realpathSync.native:
- Class A (X.5-T's mission): runtime shim missing a symbol.
- Class B (newly surfaced): install pipeline drops dotfiles from tarball extraction.

Recommended next dispatch: **X.5-U** — investigate Nimbus's npm install batch-facet tarball extraction; locate the dotfile filter; assess whether it's hardcoded (e.g., a `.startsWith('.')` skip) or accidental (e.g., a glob that matches `*` excluding leading dots). Probe candidate: `dotfile-preservation.mjs` — install ts-jest, then assert `existsSync('/home/user/app/node_modules/ts-jest/.ts-jest-digest') === true`.

## §4. Scope deviations

### §4.1 Cross-wave probe scope

X.5-T plan §5 listed all prior X.5 run-alls including `x5j/x5l/x5m/x5npqo/x5z5-build/x5r/x5z3/x5m3/x5s/x526b`. Implementation honoured this exactly.

W-wave anchors (W3-W6 run-alls) were INTENTIONALLY EXCLUDED from `cross-wave-runalls.mjs` because they default to BASE=production for e2e, which is meaningfully different from a regression check on the X.5-T fix. They are anchored separately via `Mossaic + W1` runs in the audit.

### §4.2 Per-row args + KNOWN_FAILS allowlist

The first cut of `cross-wave-runalls.mjs` blindly passed `--no-e2e` to every run-all. Only `x526b` and `x5t` actually respect that flag; older X.5 run-alls gate e2e via `NIMBUS_X5*_E2E=1` env vars (per X.5-J convention). The flag was harmless to pass to non-recognising probes (just ignored), so functionally fine — but the cleaner approach (final committed version) uses per-row `args` and an explicit `KNOWN_FAILS` set documenting `x5z5-build/run-all.mjs` as pre-existing.

### §4.3 e2e wrangler restart

The local wrangler dev on port 8790 was killed once during audit (likely by parent shell cleanup despite `disown`). Restarted via `setsid bash -c '...'` per the x526b precedent. No data loss; e2e re-ran cleanly.

### §4.4 Generated-file diff revert

`bun install` at worktree setup dirtied two timestamped generated files (`src/git-bundle.generated.ts`, `src/parallel/generated-workers.ts`). Reverted to honour the dispatch's "DO NOT touch any file other than src/node-shims.ts" anti-req. Final src diff: 1 file, +8 lines (3 executable + 5 comment block).

### §4.5 Anti-req inheritance check

X.5-26b's `node-shims.ts` lock was wave-scoped, not a global hold. X.5-T's mission IS to touch that file — the inheritance question was correctly answered "no" in plan §6. Fix applied at line 420-426 (defn) + line 617 (return-object), matching Z5 plan §4.3 exactly modulo the +27-line drift from X.5-NPQO's promises-namespace expansion.

## §5. REGRESSED status

| Surface | Status |
|---|---|
| `audit/probes/x5t/functional/realpath-native-defined.mjs` | 9/9 ✓ |
| `audit/probes/x5t/regression/single-resolver-source.mjs` | ✓ |
| `audit/probes/x5t/regression/install-pipeline-coverage-shim.mjs` | 4/4 ✓ |
| `audit/probes/x5t/regression/cross-wave-runalls.mjs` | 9 PASS + 1 KNOWN-FAIL + 0 NEW ✓ |
| `audit/probes/run-mossaic-prod-w2.mjs` | ✓ |
| `audit/probes/run-wave1-regression-w2.mjs` | ✓ |
| `bun x tsc --noEmit` | 2/2 baseline only ✓ |
| `audit/probes/x5t/e2e/ts-jest-real-install.mjs` | 4/5 — `.native` blocker GONE; new `.ts-jest-digest` blocker surfaced |

**No cross-wave regressions introduced.** ts-jest at the verify cohort layer remains ⚠ — but for a NEW reason. Per the dispatch's explicit "Done" criterion: "*acceptable to surface NEW deeper failure if multiple class issues — document*" — this is the documented case.

## §6. Predicted vs actual delta on the strict-✅ axis

| Pkg | X5T-plan prediction | Actual |
|---|---|---|
| ts-jest | +1 ✅ (16→17) | **0** at the package-install layer; the structural runtime fix lands but the install-layer dotfile drop continues to surface. Will count as +1 once X.5-U lands. |
| typescript | "+1 if in cohort" | not measured (out of cohort per verify-90993b3 manifest) |
| ts-node | "potential +1 — re-probe" | not measured (no e2e in this wave; X.5-J's prior fixes still green per cross-wave run-alls) |

**Net package-count delta from X.5-T alone: 0 strict-flips.** Net runtime-shim improvement: 1 missing symbol surface restored; ts-jest now fails at the SECOND blocker, not the first.

## §7. Dispatch recommendation

X.5-U should investigate Nimbus's npm install pipeline's tarball extraction logic for dotfile handling. Per quick probe (`tar -tzf` on the ts-jest tarball), the tarball DOES contain `.ts-jest-digest` — the file is being dropped during install. Likely candidates:
- `src/parallel/batch-facet.ts` (tarball batch extraction)
- `src/parallel/npm-resolve-preamble.ts` (resolver preamble used during install)
- `src/parallel/generated-workers.ts` (entry-point bundle)

Estimated scope: ~5-15 LOC (depending on whether the filter is explicit or accidental). Predicted impact: +1 ✅ on ts-jest (closing what X.5-T started); possible follow-on flips on other dotfile-using packages.

## §8. References

- `audit/sections/X5Z5-plan.md §4` — original root-cause identification.
- `audit/sections/X526b-retro.md §3.1` — verbatim 3-LOC fix sketch.
- `audit/sections/X5T-plan.md` — this wave's dispatch plan.
- `audit/sessions/X5T-progress.md` — phase-by-phase log.
- `audit/probes/verify-90993b3/packages-local/ts-jest.out.txt:64-72` — pre-fix evidence.
- `audit/probes/x5t/e2e/ts-jest-real-install.out.txt` — post-fix evidence.
