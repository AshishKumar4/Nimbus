# X.5-T tsjest realpathSync — progress log

> Branch: `x5t-tsjest` off `origin/main` @ `9d4b61d`.
> Worktree: `/workspace/worktrees/x5t-tsjest`.
> Mission: smallest known win — flip `ts-jest` ⚠→✅ via 3-LOC fix
> in `src/node-shims.ts` (X.5-Z5 plan §4.3 + X.5-26b retro §3.1).

## Phase A — Plan ✓

Wrote `audit/sections/X5T-plan.md`. Key moves:

- Confirmed root cause stack from `audit/probes/verify-90993b3/packages-local/ts-jest.out.txt:64-72`.
- Documented line-number drift: X.5-Z5 cited `~line 580`; current return-object literal is at line 607-611. Drift +27 LOC consistent with X.5-NPQO's `promises` namespace expansion.
- Insertion plan: function defn at line 419 (between `copyFileSync` close and `// ── Async variants`), then `realpathSync.native = realpathSync;`, then add `realpathSync` token to return-object listing at line 608.
- Regression matrix covers: async `promises.realpath` (line 547), W3.5 install pipeline, X.5-C R1 single-resolver, all prior X.5 run-alls, Mossaic + W1 anchors, tsc baseline.
- Self-review confirmed scope minimal, file-lock anti-req from X.5-26b not inherited (X.5-T's mission IS to touch that file), and parallelism with `verify-9d4b61d` is safe (verify is read-only against `origin/main`).

## Phase B — TDD red ✓

Authored 5 probes under `audit/probes/x5t/`:

```
audit/probes/x5t/
├── functional/realpath-native-defined.mjs    ─ NEW: asserts fs.realpathSync.native callable + same ref
├── regression/single-resolver-source.mjs     ─ delegates to x5f authoritative probe
├── regression/install-pipeline-coverage-shim.mjs ─ delegates to x5f authoritative probe
├── regression/cross-wave-runalls.mjs         ─ NEW: J/L/M/NPQO/Z5/R/Z3/M3/S/26b sweep
├── e2e/ts-jest-real-install.mjs              ─ NEW: wrangler dev local; install ts-jest; smoke require
└── run-all.mjs                                ─ aggregator (functional + regression; e2e gated by BASE)
```

**Red baseline run** (pre-fix, no e2e):

- `realpath-native-defined`: **FAIL** (7/9 sub-asserts fail). Error message `undefined is not an object (evaluating '_fs.realpathSync.native')` reproduces the exact Bun/JSC equivalent of V8's `Cannot read properties of undefined (reading 'native')` from verify-90993b3 ts-jest.out.txt:64. Confirms the failure is structural to `__fsMod`'s missing `realpathSync` symbol, not environmental.
- `single-resolver-source`: **PASS** (baseline preserved).
- `install-pipeline-coverage-shim`: **PASS** (4/4 install scenarios — fastify, express, ts-jest, redis — all green via parallel verify-9d4b61d wrangler on 8787).

Total: 2 pass, 1 fail. RED confirmed.

Reverted generated-file timestamp drift (`src/git-bundle.generated.ts`, `src/parallel/generated-workers.ts`) caused by `bun install`'s postinstall — anti-req: only `src/node-shims.ts` will be touched.

## Phase C — Build ✓

Single commit `886e9ab`, single file `src/node-shims.ts`, +8 lines (3 executable + 5 comment block):

```ts
  // ── realpathSync (X.5-T per X5Z5-plan §4.3 + X526b-retro §3.1) ──
  // VFS has no symlinks; identity-resolve to the absolute path. The
  // .native static is required by TypeScript's getNodeSystem at
  // typescript.js:8291 (see audit/probes/x5t/functional/realpath-native-defined.mjs).
  function realpathSync(p, opts) { return _resolve(String(p)); }
  realpathSync.native = realpathSync;
```

…inserted at line 420 (between `copyFileSync` close and `// ── Async variants`); plus `realpathSync` token added to the return-object literal at line 617.

**Functional probe re-run post-fix: 9/9 GREEN** (vs 2/9 pre-fix). The same-ref invariant `fs.realpathSync === fs.realpathSync.native` per Z5 plan §4.3 holds; both branches of TS's ternary at typescript.js:8291 now evaluate to the same callable.

## Phase D — Audit ✓

### D.1 tsc baseline preserved

```
$ bun x tsc --noEmit
src/esbuild-service.ts(153,28): error TS2307: Cannot find module 'esbuild-wasm/esbuild.wasm' or its corresponding type declarations.
src/nimbus-session-init.ts(74,39): error TS2345: Argument of type 'SqliteVFSProvider' is not assignable to parameter of type 'VirtualProvider | MountProvider'.
```

**2 errors — same baseline.** Fix introduces 0 new type errors.

### D.2 x5t functional + regression (no e2e)

- `realpath-native-defined`: **9/9 PASS** (post-fix)
- `single-resolver-source`: **PASS** (delegates to x5f)
- `install-pipeline-coverage-shim`: **PASS** (4/4 install scenarios green against local wrangler dev on port 8790: fastify, express, ts-jest, redis)

### D.3 e2e ts-jest real-install (BASE=http://127.0.0.1:8790)

```
  ok  probe ran (POST /new succeeded)
  ok  npm install completed (output mentions "added" packages)
  ok  NO `Cannot read properties of undefined (reading 'native')` error
  ok  NO TypeError at getNodeSystem
  NOT OK  smoke output contains "typeof: object" — ts-jest failed at NEW deeper layer
```

**4/5 GREEN.** The original X.5-T fix surface (`.native`) is FULLY ELIMINATED — no longer present in the runtime stack. The smoke step now fails at a NEW deeper layer:

```
Error: ENOENT: no such file or directory, open '/home/user/app/node_modules/ts-jest/.ts-jest-digest'
    at readFileSync (runner.js:254:19)
    at eval (eval at __mkCompiledFn (runner.js:29:10), <anonymous>:70:43)
```

The ts-jest tarball (verified via `npm view ts-jest dist.tarball` + `tar -tzf`) DOES contain `package/.ts-jest-digest`. The file is being **dropped during install** — Nimbus's npm install pipeline appears to filter dotfiles. This is a NEW class of bug, separate from `realpathSync.native`, and explicitly out of X.5-T scope per the dispatch's "acceptable to surface NEW deeper failure if multiple class issues — document".

**Verdict: ts-jest is now blocked by a SECOND, ORTHOGONAL issue (install-pipeline dotfile filtering).** The X.5-T fix removed the FIRST blocker as predicted. The second blocker is a candidate for a future X.5-* wave (or a hardening of the install pipeline's tarball-extraction surface in the npm subsystem).

### D.4 Cross-wave run-all sweep

After cross-wave-runalls.mjs refactor (per-row args + KNOWN_FAILS allowlist):

```
PASS  audit/probes/x5j/run-all.mjs  (2853ms)
PASS  audit/probes/x5l/run-all.mjs  (3513ms)
PASS  audit/probes/x5m/run-all.mjs  (342ms)
PASS  audit/probes/x5npqo/run-all.mjs  (273ms)
KNOWN-FAIL  audit/probes/x5z5-build/run-all.mjs  exit=1 (1310ms) — pre-existing per X5Z5-build-retro
PASS  audit/probes/x5r/run-all.mjs  (496ms)
PASS  audit/probes/x5z3/run-all.mjs  (424ms)
PASS  audit/probes/x5m3/run-all.mjs  (12185ms)
PASS  audit/probes/x5s/run-all.mjs  (26391ms)
PASS  audit/probes/x526b/run-all.mjs  (336ms)

# new pass: 9, known-fail (pre-existing): 1, NEW fail: 0
```

The 1 known-fail is X5Z5-build's tailwindcss-vite e2e — pre-existing lightningcss native-binding gap, explicitly labelled `[downstream — out of Z5 scope]` in its own assert, addressed by X.5-26b's REJECT_INSTALL approach (lightningcss is now in the registry rejection list). Not a regression.

### D.5 Mossaic + W1 anchors (production)

Both run against production (`https://nimbus.ashishkmr472.workers.dev`); confirms the X.5-T src diff is isolated to a worktree branch and does not leak into prod-tested surface.

```
==== VERDICT: PASS ====
  status=200, htmlLen=2866, external=0, alive=true, viteRunning=true
==== END MOSSAIC PROD W2 ====

==== VERDICT: PASS ====
  external=0, status=200, htmlLen=3206, twOk=true
==== END WAVE1 REGRESSION ====
```

### D.6 Audit verdict

| Surface | Result |
|---|---|
| tsc baseline (≤2 errors) | 2/2 baseline only ✓ |
| x5t functional probe | 9/9 ✓ |
| x5t single-resolver regression | ✓ |
| x5t install-pipeline regression | 4/4 ✓ |
| x5t cross-wave runalls (10 X.5 probes) | 9 PASS + 1 KNOWN-FAIL + 0 NEW REGRESS ✓ |
| Mossaic production anchor | ✓ |
| W1 regression anchor | ✓ |
| x5t e2e ts-jest real-install | 4/5 — `.native` blocker GONE; **NEW** deeper blocker surfaced (install-pipeline dotfile filtering on `.ts-jest-digest`) — documented as separate class |

## Phase E — Push ✓

`git push origin x5t-tsjest`. Branch grant active at `origin/x5t-tsjest`.

Commit chain on branch:
- `6e668db` x5t plan: ts-jest realpathSync.native — 3-LOC fix
- `d3997ae` x5t TDD red: 5 probes under audit/probes/x5t/
- `886e9ab` x5t fix: __fsMod.realpathSync + .native static (3 LOC)
- `f0d25a0` x5t progress: Phase C build complete
- `3ef6404` x5t Phase D audit

## Phase F — Retro ✓

Authored `audit/sections/X5T-retro.md`:

- **§1 Verdict:** ts-jest PARTIAL flip — first blocker (`.native`) eliminated; SECOND blocker surfaced (install-pipeline dotfile filtering on `.ts-jest-digest`).
- **§2 Root cause:** X.5-Z5 §4 + X.5-26b §3.1 hypothesis CONFIRMED. Fix exactly as prescribed; same-ref invariant holds.
- **§3 New deeper blocker:** install pipeline drops dotfiles. Recommended X.5-U dispatch.
- **§4 Scope deviations:** documented W-wave exclusion from cross-wave probe; per-row args + KNOWN_FAILS allowlist refactor; setsid wrangler restart precedent; generated-file revert.
- **§5 REGRESSED status:** 0 cross-wave regressions; 1 pre-existing known-fail (X5Z5-build tailwindcss-vite e2e).
- **§6 Delta:** net package-count delta from X.5-T alone is 0 strict-flips at install layer; runtime-shim surface improved; predicted +1 lands once X.5-U addresses the dotfile drop.
- **§7 Dispatch recommendation:** X.5-U on tarball extraction dotfile handling.

