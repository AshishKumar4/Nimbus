# X.5-T plan — `ts-jest` realpathSync.native shim

> Branch: `x5t-tsjest` off `origin/main` @ `9d4b61d`.
> Worktree: `/workspace/worktrees/x5t-tsjest`.
> Mission: smallest known win — flip `ts-jest` ⚠→✅ at the real-package
> install layer via the 3-LOC fix already prescribed in
> `audit/sections/X5Z5-plan.md §4.3` and confirmed in
> `audit/sections/X526b-retro.md §3.1`.
>
> X.5-T is a single-package, single-file wave. It does not investigate;
> it dispatches the already-known fix that prior waves intentionally
> deferred (X.5-26b's `src/node-shims.ts` anti-requirement explicitly
> punted ts-jest).

## §1. TL;DR

| Field | Value |
|---|---|
| Pkg | `ts-jest` |
| Symptom | `TypeError: Cannot read properties of undefined (reading 'native')` at `getNodeSystem` |
| Root cause | `__fsMod` exports no `realpathSync` (and therefore no `realpathSync.native`); TS's `getNodeSystem` reads `_fs.realpathSync.native` for truthy gating |
| Fix file | `src/node-shims.ts` |
| Fix LOC | 3 (function defn + `.native` static binding + return-object word) |
| Predicted delta | +1 ✅ → 17/33 strict, 30/33 healthy |
| Risk | negligible (`_resolve(p)` is a no-op symlink resolver; VFS has no symlinks) |
| Cross-wave touch | none beyond `src/node-shims.ts` |

## §2. Confirmed root cause

Verbatim from `audit/probes/verify-90993b3/packages-local/ts-jest.out.txt:64-72`:

```
TypeError: Cannot read properties of undefined (reading 'native')
    at getNodeSystem (eval at <anonymous> (runner.js:34:34), <anonymous>:8291:43)
```

TypeScript 5.6.3 / 6.0.3 source (verified in X.5-Z5 plan §4.1) at the
identified offset:

```js
const fsRealpath = !!_fs.realpathSync.native ? ... : _fs.realpathSync;
```

The `!!_fs.realpathSync.native` access reads `.native` of `undefined`
because `__fsMod`'s return object literal at the current line **608**
(line drift since X.5-Z5 plan §4 cited line 580) does not include
`realpathSync`:

```
readFileSync, writeFileSync, appendFileSync, existsSync, statSync, lstatSync,
readdirSync, mkdirSync, unlinkSync, rmdirSync, renameSync, copyFileSync,
readFile, writeFile, stat, readdir, exists, mkdir, unlink, access,
promises, constants, createReadStream, createWriteStream,
watch, watchFile, unwatchFile
```

Async `promises.realpath` exists at `src/node-shims.ts:547`; sync
counterpart was never added. ts-jest is the first verify-cohort package
to exercise it.

## §3. Line-number drift confirmation

X.5-Z5 plan §4.3 cited:
- "function defn" — to be added near the sync block
- "return-object literal at `src/node-shims.ts:581`"

Current state (HEAD `9d4b61d`):
- Sync block ends at `copyFileSync` (line 416-418).
- Async-variants comment is at line 420.
- Return-object literal is at **line 607-611** (with `readFileSync, …` listing on 608-611).
- The "**~line 581**" in the dispatch is stale — likely from before
  X.5-NPQO's promises-namespace expansion (which added the FileHandle
  class and 100+ lines of promises surface). The OFFSET is wrong; the
  STRUCTURE is identical.

Insertion strategy:
1. New `function realpathSync(p, opts) { return _resolve(String(p)); }` at line 419 (between `copyFileSync` close and `// ── Async variants` comment).
2. New `realpathSync.native = realpathSync;` immediately after.
3. Add `realpathSync` token to the return-object listing at line 608.

Total: 3 LOC additive. No deletions. No renames.

## §4. Regression matrix

| Surface | What could regress | Test |
|---|---|---|
| Async `promises.realpath` (line 547) | NEW sync counterpart could shadow | Probe asserts `promises.realpath` still resolves async |
| `__pathMod.resolve` callers downstream | NEW `_resolve` use must equal `__pathMod.resolve` semantics | `_resolve` is the existing `__fsMod`-internal helper at line 167 (already used by `promises.realpath` at 547); same fn, same semantics |
| Install-pipeline coverage (W3.5 axios/ts-node/puppeteer) | Bundle/eval shape unchanged (additive in IIFE return) | Re-run `install-pipeline-coverage-shim.mjs` |
| Single-resolver invariant (X.5-C R1) | `getExportsResolverJS` is the source-of-truth for ESM resolution; unrelated to fs | Re-run `single-resolver-source.mjs` |
| All prior X.5 wave run-alls (J/L/M/NPQO/Z5/R/Z3/M3/S/26b) | Cross-wave invariants per X5M3-retro | Re-run cross-wave-runalls |
| Mossaic / W1 / W3 production smokes | Different code paths; only fs sync surface adds | Mossaic-prod-w2 + wave1-regression-w2 |
| tsc baseline (2 known errors: esbuild-wasm/esbuild.wasm + nimbus-session-init mount-provider type) | Type surface adds 1 fn; `realpathSync.native` is implicit JS property assignment, not a type | tsc must surface ≤2 errors (same baseline) |

## §5. Probe inventory

```
audit/probes/x5t/
├── functional/
│   └── realpath-native-defined.mjs     ─ asserts builtins.fs.realpathSync.native is callable
│       and === realpathSync (same fn); both return _resolve(String(p)) shape
├── regression/
│   ├── single-resolver-source.mjs       ─ X.5-C R1 invariant
│   ├── install-pipeline-coverage-shim.mjs ─ W3.5 axios/ts-node/puppeteer
│   └── cross-wave-runalls.mjs           ─ J/L/M/NPQO/R/Z3/Z5-build/M3/S/26b + W3..W6
└── e2e/
    └── ts-jest-real-install.mjs         ─ wrangler dev local, install ts-jest, smoke require()
```

Anchor probes outside `x5t/`:
- `audit/probes/run-mossaic-prod-w2.mjs` (Mossaic invariant)
- `audit/probes/run-wave1-regression-w2.mjs` (W1)

## §6. Self-review TL;DR

**Self-review prompts (per X.5-Z5 plan §3 dispatch convention):**

1. **Is the fix sketch ACTUALLY 3 LOC?** Yes — 3 lines additive (one
   function defn line, one `.native` binding line, one identifier in
   the return-object). No multi-line refactors.

2. **Does it touch any file other than `src/node-shims.ts`?** No.
   Anti-req honoured.

3. **Is the line-number drift documented?** Yes (§3). Original cite was
   `~line 580`; current is `408 (defn) / 608 (return)`. Drift is +27
   lines, consistent with X.5-NPQO's promises-namespace addition
   between X.5-Z5 plan and HEAD.

4. **Could this collide with `verify-9d4b61d` running in parallel?** No
   — `verify-9d4b61d` is read-only (verify cohort). x5t-tsjest's
   src/ touches are confined to one file in our worktree branch; verify
   reads against `origin/main` not our branch.

5. **What if the fix lands but ts-jest STILL fails?** Acceptable per
   "Done" criteria — surface the NEW deeper error in retro, document
   as "multi-class ts-jest blockers" and exit. The current
   single-class blocker IS realpathSync.native per Z5 plan §4 and
   X.5-26b retro §3.1.

6. **Anti-req inheritance from X.5-26b?** That wave's
   `node-shims.ts` lock was wave-specific. X.5-T's mission IS to
   touch that file. Not inherited.

## §7. Done criteria

- `audit/probes/x5t/functional/realpath-native-defined.mjs` green.
- `audit/probes/x5t/regression/*.mjs` green (no cross-wave regressions).
- `audit/probes/x5t/e2e/ts-jest-real-install.mjs` green at the real-package layer.
  (Acceptable to surface a NEW deeper failure if ts-jest has multiple class blockers; document in retro.)
- `tsc --noEmit` produces ≤2 errors (baseline only: esbuild-wasm + nimbus-session-init).
- src/node-shims.ts touched, +3 LOC, single commit.
- Branch `x5t-tsjest` pushed to `origin`.
- `X5T-progress.md` ✓ all 6 phases (A through F).
- `X5T-retro.md` ✓ ts-jest verdict + root-cause confirmation.
