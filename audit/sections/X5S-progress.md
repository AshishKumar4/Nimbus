# X.5-S progress log

Per VERIFY-23417C5.md §4 #1. Worktree `x5s-dirname` from origin/main HEAD `23417c5`.
Fresh start (previous X.5-S worktree wiped in platform reset).

## Phase A — Investigate (✓)

- Standalone reproducer confirms exact failure shape:
  `Identifier '__dirname' has already been declared` from
  `new Function("exports","require","module","__filename","__dirname", code)`
  where `code` contains `const __dirname = …` (esbuild ESM→CJS output).
- Local wrangler dev (`bun run dev` on 127.0.0.1:8787) re-runs the X.5-M3
  e2e probe — RED state matches VERIFY-23417C5 §4 #1 byte-for-byte.
- Localized first-declarer: `new Function`'s parameter list (hoisted
  into the function's lexical scope at parse time) collides with the
  body's `const __dirname = …` (esbuild output, second declarer at
  parse time).
- Fix choice: PREFERRED (conditional-drop of `__dirname` / `__filename`
  parameter when body declares it). FALLBACK (banner strip) deferred —
  not needed.
- Saved transcripts: `audit/probes/x5s/investigation/`{repro.mjs, e2e-RED-baseline.out.txt, INVESTIGATION.md}.

## Phase B — Plan (✓)

- `audit/sections/X5S-plan.md` shipped: investigation summary, root cause
  final, fix sketch with file:line targets, regression matrix, scope
  guards, self-review TL;DR.
- Three wrap sites share identical signature → one helper covers all.
- `__filename` patched symmetrically (open@10 sometimes emits the same
  pattern for it).
- Push grant 403 in this environment; commits land locally and push at
  end.

## Phase C — TDD red (✓)

- 3 functional probes (`f1-marker`, `f2-eval-no-collision`, `f3-clean-body`) — all RED.
- 3 regression probes (`install-pipeline-coverage-shim`, `single-resolver-source`,
  `cross-wave-x5-runalls`) — all GREEN at HEAD (baseline confirmed).
- 1 investigation probe (`repro.mjs`) — exits 0 (repro confirms RED, fix shape parses).
- 1 e2e probe (`e1-vite-loads.mjs`) — local-wrangler RED (captured in
  Phase A as `e2e-RED-baseline.out.txt`).
- Run-all transcript at HEAD: `audit/probes/x5s/run-all-pre-fix.txt`
  — 4 pass / 3 fail (the 3 functional probes that demand the fix).

## Phase D — Build (✓)

- src diff: facet-manager.ts (53 +/-), node-shims.ts (37 +/-).
- 3 wrap sites updated:
  - `src/node-shims.ts` __loadModule fallback → `__mkCompiledFn(code)`.
  - `src/facet-manager.ts` generateFacetCode (USER_CODE wrap + module
    pre-compile loop) → `__mkCompiledFn(code, extraParams)`.
  - `src/facet-manager.ts` generateEntrypointCode (same shape) →
    `__mkCompiledFn(code, extraParams)`.
- Strategy: **conditional-param-RENAME** (not drop) so positional slot
  alignment is preserved (USER_CODE wrap appends `console`, `process`,
  etc. after `__dirname`; dropping would mis-align downstream slots).
- Symmetric for `__filename` (open@10's idiom often emits both).
- Probe-update for x5m3: `f3-loadmodule-saves-restores.mjs` regex
  broadened to match either pre-X.5-S `new Function(...)` literal or
  post-X.5-S `__mkCompiledFn(code)` — semantic invariant unchanged.
- 3 commits in Phase D: src fix + x5m3 probe regex + AUDIT artifacts.

## Phase E — Audit (✓)

- run-all: 7 pass / 0 fail.
- e2e (BASE=http://127.0.0.1:8788): CHARTER-PASS — targeted message
  GONE; next-bucket exposed = rollup native-binding (X.5-Z5 territory).
- cross-wave: 11/11 OK including x5m3 (with regex update).
- mossaic: pre-existing playwright REJECT (same as X.5-M3 baseline).
- W1: PASS.
- tsc: 2 baseline errors only.
- AUDIT-SUMMARY.md shipped under `audit/probes/x5s/`.

## Phase F — Push (✓)

- `git push origin x5s-dirname` succeeded after Phase E commit. Push
  grant is active in this env (the Phase A 403 on first attempt was
  transient — likely permission-cache propagation, not real grant gap).
- Branch landed at `5066aa1` (= 6 commits ahead of `origin/main` 23417c5).

## Phase G — Retro (✓)

- `audit/sections/X5S-retro.md` shipped: vite verdict (charter-pass,
  not strict-✅; cause shifted from __dirname re-decl to rollup
  native-binding), root cause final, scope deviations vs prediction
  (predicted +1 ✅, actual +0; predicted next-bucket fileURLToPath, actual
  rollup native-binding), regression verdict (0/11 cross-wave, mossaic
  pre-existing playwright preserved, W1 PASS, tsc 2 baseline), recommended
  next dispatch (X.5-T candidate: rollup native-binding gap).
