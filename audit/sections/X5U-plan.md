# X.5-U plan — `.ts-jest-digest` dotfile reachability

> Branch: `x5u-dotfile` off `origin/main` @ `0a022e6`.
> Worktree: `/workspace/worktrees/x5u-dotfile`.
> Source dispatch: follow-up to X.5-T charter-pass.
> Predicted: +1 ✅ (ts-jest fully) → 17/33 strict, 32/33 healthy.
> Phase A artifacts (committed): `audit/probes/x5u/investigation/` + `audit/sessions/X5U-progress.md`.

## §1. TL;DR (self-review)

X.5-T eliminated the `realpathSync.native` blocker. The `.ts-jest-digest`
follow-on, hypothesised as an **install-pipeline dotfile filter** in
X.5-T retro §3, is in fact a **runtime bundle-population gap** (H4
NEW-path; H1/H2/H3 rejected). The install pipeline writes the dotfile
to VFS correctly — `fs.readdirSync` enumerates it, `fs.statSync` reports
a file — but `__vfsBundle` (the in-memory map the facet's `readFileSync`
shim consults at `src/node-shims.ts:202-215`) does not contain it, so
`fs.readFileSync('.ts-jest-digest')` ENOENTs.

The fix is a **single new bundle-population pass** in
`src/facet-manager.ts buildPrefetchBundle`. It mirrors X.5-Z3's
`addStaticReadFileAssets` (which solved the *same* class of "static
readFileSync of asset on VFS-disk but absent from bundle") but covers
the SWC/TS-compiled `(0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, "<rel>"))`
call shape and accepts arbitrary file extensions (or no extension)
rather than the conservative jsdom `ASSET_EXT` whitelist.

Expected impact: ts-jest ⚠→✅ (+1 strict). No expected regressions:
the new pass is an **additive bundle-augmentation** (only adds files,
never removes); it shares the same `budgetState` cap (
`VFS_BUNDLE_MAX_FILES=4000`, `VFS_BUNDLE_MAX_BYTES=24 MiB`) so
worst-case memory is unchanged. Mossaic + W1 packages don't read
`__dirname`-relative files via the SWC-compiled pattern (verified by
grep against their compiled bundles in tarball form), so the new
helper is a no-op on those installs.

## §2. Investigation summary (Phase A)

Probes (committed in `audit/probes/x5u/investigation/`):
- `h-localize-dotfile.mjs` — first cut; surfaced an in-Nimbus shell
  parser bug (`ls -la 2>&1` rejected as *"Expected Word but got Amp"*).
  Kept for evidence; conclusions superseded by the second probe.
- `h-vfs-disk-confirm.mjs` — corrected; all-node-script.

Verbatim post-`npm install ts-jest` evidence from probe #2:

```
X5U_REPORT: {
  "readdirAll": [".lintstagedrc",".ts-jest-digest","CHANGELOG.md", … "package.json", …],
  "readdirDotfiles": [".lintstagedrc",".ts-jest-digest"],
  "statDot":  { "isFile": true, "size": 0 },
  "statReg":  { "isFile": true, "size": 4484 },
  "readDot":  "ERR:ENOENT",
  "readReg":  "OK:bytes=4484"
}
```

`readdirSync` and `statSync` are served by the manifest pass
(`buildManifest` at `src/facet-manager.ts:591-615`), which walks
`vfs.readdir` — the source of truth for VFS-disk state. The fact that
the manifest enumerates `.ts-jest-digest` proves the install pipeline
wrote it. `readFileSync` reads from `__vfsBundle` (`src/node-shims.ts:202-215`),
which only contains files that one of the bundle-population passes
explicitly added — none of which match `.ts-jest-digest`.

## §3. Root cause final

| H | Description | Verdict |
|---|---|---|
| H1 | install pipeline `.gitignore`-style filter excludes dotfiles | **REJECTED** — manifest-pass evidence (readdir sees the file) |
| H2 | VFS write-batch path filter | **REJECTED** — `_writeBatchOnce` (sqlite-vfs.ts:1349-1518) is content-agnostic |
| H3 | prefetch / facet-bundle filter | **CONFIRMED-AS-H4** |
| H4 | NEW path | **CONFIRMED** — three independent bundle-population gaps below |

**Fix locus** = `src/facet-manager.ts buildPrefetchBundle`. Three
independent reasons `.ts-jest-digest` is invisible to the bundle:

1. **`require-resolver.ts:418 prefetchForRequire`** follows
   `require()` / `import` strings only. ts-jest accesses
   `.ts-jest-digest` via static `readFileSync(path.resolve(__dirname,
   "../../../.ts-jest-digest"), "utf8")`. There's no specifier to walk.

2. **`facet-manager.ts:631 greedyAddMainEntries`** adds each installed
   package's `package.json` + main/module/exports leaf. Non-entry files
   are invisible to it.

3. **`facet-manager.ts:821 addStaticReadFileAssets`** (the X.5-Z3
   helper, closest existing precedent) almost matches but misses on TWO
   axes:
   - **Regex shape**: requires `resolve\s*\(\s*__dirname` — direct call.
     ts-jest's compiled JS uses `(0, path_1.resolve)(__dirname, …)` —
     the TypeScript "preserve-this" `(0, x.y)(args)` trick. The `)` after
     `resolve` before `(__dirname` defeats the regex.
   - **Extension allowlist**: `ASSET_EXT = /\.(css|html|htm|svg|txt|json)$/i`
     excludes `.ts-jest-digest` (its name leads with `.` and has no
     recognized extension; the bare-leading-dot shape is unusual).

## §4. Fix sketch (file:line)

Single new helper added to `src/facet-manager.ts`, called from
`buildPrefetchBundle` immediately after the existing
`addStaticReadFileAssets` call (line 1085). New helper signature:

```ts
export function addStaticReadFileDotfilesAndCompiled(
  vfs: SqliteVFS,
  cwd: string,
  bundle: Record<string, string>,
  budgetState: { totalBytes: number; fileCount: number },
): { added: number };
```

Behaviour: like `addStaticReadFileAssets` but
- Recognises `(0, path_1.resolve)(__dirname, …)` and bare
  `path.resolve(__dirname, …)` plus the SWC `__dirname` alone shape
  (e.g. `path.join(__dirname, …)` is also covered).
- Accepts any file extension (including none) — but ONLY when the
  matched filename starts with `.` or contains `digest|hash|version|sha|md5`
  (bounded heuristic to avoid pulling in arbitrary unrelated files).
- Identical budget guards (`VFS_BUNDLE_MAX_FILES`, `VFS_BUNDLE_MAX_BYTES`).
- Identical literal-only matching (rejects `${}` interpolation, dynamic
  `path.resolve(__dirname, basename)`).

Call site: `src/facet-manager.ts buildPrefetchBundle` after
`addStaticReadFileAssets` (current line 1085).

Estimated LOC: ~50-70 (helper) + 3 (call site). Tier: under X.5-T
(8 LOC) but expected — the new helper is broader scope than the
3-LOC `realpathSync.native` shim because it covers a richer class.

## §5. Regression matrix

The new helper is **strictly additive** in three ways: it only
*adds* files to the bundle, only does so for files that *already
exist on VFS-disk*, and shares the same `budgetState` cap as the
two existing oversample passes. So the regression surface is:

| Surface | Risk | Verdict |
|---|---|---|
| **Mossaic (`audit/probes/run-mossaic-prod-w2.mjs`)** | helper accidentally pulls extra files into Mossaic's bundle, blowing the 4000-file/24 MiB cap | LOW. Mossaic's source repo is hand-written; no `(0, x.y)(__dirname)` SWC-compiled patterns. Even if matched, files would have to satisfy the `^\.` OR `digest|hash|version|sha|md5` filename heuristic — rare in Mossaic's actual content. Verified by Phase E run. |
| **W1 wave (`audit/probes/run-wave1-regression-w2.mjs`)** | same | LOW. W1 packages (lodash, debug, axios, …) are mature CJS; no SWC compilation; `path.resolve(__dirname` is uncommon in mature CJS. Verified by Phase E run. |
| **Single-resolver invariant (`audit/probes/regression/single-resolver-source.mjs`)** | new helper changes resolver semantics | NONE. The helper sits in the *bundle population* layer, not the resolver layer. It does not call any resolver function. |
| **install-pipeline-coverage** | helper changes install-side behaviour | NONE. The helper runs supervisor-side at facet-spawn time, not at install time. |
| **All 14 prior X.5 run-alls (J/L/M/NPQO/Z5/R/Z3/M3/S/26b/peer-gap/T/drizzle)** | the helper conflicts with one of those waves' fixes | LOW. X.5-Z3 is the closest analogue and the new helper is its *sibling* (same shape, different match space). The helper is appended to the bundle-population sequence, not inserted between existing steps. Cross-wave run-all in Phase E verifies. |
| **tsc baseline (2)** | type errors | NONE expected. Helper is plain TS with the same `SqliteVFS` + `Record<string, string>` types as `addStaticReadFileAssets`. |

**Why bounded heuristic** (`^\.` OR `/digest|hash|version|sha|md5/`):
unconstrained "match any filename in `__dirname`-relative readFileSync"
would pull in genuinely-large files (e.g. compiled WASM, JSON dictionaries)
on packages that read them via this exact shape. The heuristic narrows
to filenames that look like *small metadata sentinels* — which is
exactly the `.ts-jest-digest` shape. Trade-off documented; if a future
package needs a different shape it can be extended.

## §6. Anti-requirements honoured

- **NO src/ change without test** — Phase C writes RED probes BEFORE Phase D edits src/.
- **NO files outside worktree** — every file under `/workspace/worktrees/x5u-dotfile/`.
- **NO push to main** — branch `x5u-dotfile` only.
- **NO unreviewed commits** — self-review TL;DR §1 above.
- **DO NOT touch `src/node-shims.ts`** — frozen post-X.5-T merge. Confirmed: the fix is in `src/facet-manager.ts` only; no node-shims edit needed (the `__vfsBundle` lookup at lines 202-215 already does the right thing once the file is in the bundle).
- **DO NOT touch `src/npm-resolver.ts` / `src/npm-resolve-facet.ts`** — X.5-drizzle territory. Confirmed: install-pipeline change rejected by Phase A; resolver path untouched.
- **DO NOT prod deploy** — local wrangler dev only.

## §7. Phase D commit plan

Single `src/`-touching commit:
```
x5u Phase D: dotfile + SWC-shaped readFileSync asset prefetch (ts-jest-digest fix)
```
References: probes in `audit/probes/x5u/{functional,regression,e2e}/`,
 plan §3-5 above.

## §8. References

- `audit/sections/X5T-retro.md §3` — original `.ts-jest-digest` discovery + H4 dispatch hint.
- `audit/sections/X5Z3-plan.md §3` — `addStaticReadFileAssets` precedent.
- `audit/sections/W2.5-install-pipeline-finding.md` — install pipeline architecture reference (rejected as fix locus by Phase A).
- `audit/probes/x5u/investigation/h-vfs-disk-confirm.out.txt` — verbatim Phase A evidence.
- `src/facet-manager.ts:591-615 buildManifest` — manifest pass that proves install OK.
- `src/facet-manager.ts:821-911 addStaticReadFileAssets` — sibling helper.
- `src/node-shims.ts:202-215 readFileSync` — frozen consumer.
