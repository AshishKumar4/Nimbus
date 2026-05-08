# prod-bugs-2 progress

## Bugs
- **Bug 1**: npm warn lines stream after `npm install` finishes (log queue
  drain ordering vs prompt return)
- **Bug 2**: `wrangler dev` fails with "Entry point not found:
  home/user/app/Nimbus/src/index.ts" — naive path-join in nimbus-wrangler
- **Bug 3** (heap-line audit): `supervisor heap N MiB` lines always read
  `0.0 MiB` because `process.memoryUsage()` returns 0 in DO contexts

## Phase status
- [x] Setup worktree (HEAD: 4c6aacc; tsc baseline: 2)
- [x] P0 progress.md (b24d5f2)
- [x] P1 Bug 2 RED probe (21bd9d4)
- [x] P2 Bug 2 fix — normalizeVfsPath at join site (8135a23)
- [x] P3 Bug 1 RED probe (b1390fe)
- [x] P4 Bug 1 fix — gate late progress to console.log (ddfe099)
- [x] P5 heap-line audit — deterministic estimator (ae29d9c)
- [x] P6 cross-wave verification — 20 PASS, 1 pre-existing FAIL, 8 SKIP
- [x] P7 retro PROD-BUGS-2-retro.md

## Final state
- tsc baseline: 2 errors (unchanged)
- Bug 1 probe: GREEN (was: prompt corrupted by trailing [npm] line)
- Bug 2 probe: GREEN, all 4 main-shape variants (was: 1/4)
- Bug 3 audit: heap line reads real MiB (was: always 0.0 MiB)
- Phase 5 regression: 20 PASS, 1 FAIL (D'.1 pre-existing on main),
  8 SKIP (W7 slow probes — QUICK mode)
- src/ touch: 2 files (wrangler/nimbus-wrangler.ts, npm/installer.ts)

## Anti-requirements honored
- NO setTimeout/sleep/retry-with-delay anywhere
- NO defensive `if !path.startsWith('/')` prepends — fix at strip site
- NO comment-out / "to ship" patches
- NO new src/ behavior beyond the 3 bugs
