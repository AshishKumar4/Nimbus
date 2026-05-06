# X.5-S audit summary

> Branch `x5s-dirname` — fix HEAD `5bcab6b`, base `23417c5`.
> Local wrangler dev (worktree, port 8788): `BASE=http://127.0.0.1:8788`.
> (Port 8787 is occupied by a sibling worktree's wrangler in this env;
> the local-wrangler convention from prior dispatches uses 8787, but the
> port number is incidental — pick any free port.)

## Run-all (no e2e, no heavy)

`audit/probes/x5s/run-all-post-fix.txt` — 7 pass / 0 fail.

```
[PASS] functional/f1-conditional-param-drop-marker.mjs
[PASS] functional/f2-eval-no-collision.mjs
[PASS] functional/f3-clean-body-still-binds-dirname.mjs
[PASS] investigation/repro.mjs
[PASS] regression/install-pipeline-coverage-shim.mjs
[PASS] regression/single-resolver-source.mjs
[PASS] regression/cross-wave-x5-runalls.mjs
```

## E2E (NIMBUS_X5S_E2E=1, BASE=http://127.0.0.1:8788)

`audit/probes/x5s/e2e/e1-vite-loads-POST-FIX.out.txt` — VERDICT: CHARTER-PASS.

```
VITE-OK present: false
VITE-FAIL present: true
targeted '__dirname has already been declared' GONE: true
next-bucket failure shape: Cannot find native binding. npm has a bug
  related to optional dependencies (https://github.com/npm/cli/issues/4828).
  Please try `npm i` again after removing both package-lock.json and
  node_modules directory.
```

X.5-S's targeted bucket (`Identifier '__dirname' has already been declared`)
is GONE. vite progresses past chunks/node.js (and any other
__dirname-shadowing transitive bundle) all the way through into vite's
bundled rollup, which then tries to load its per-platform native binding
(`@rollup/rollup-linux-x64-gnu` etc.) and fails with the documented
optional-dep error.

That failure is the **lightningcss / rollup native-binding** territory
already tracked by X5Z5-build-retro §1 (`tailwindcss-vite e2e` pre-existing
fail) and X5Z3-retro §6. It is NOT an X.5-S regression — it's the next
deeper class beneath the cleared __dirname conflict.

## Cross-wave (every prior X.5-* run-all)

`audit/probes/x5s/regression/cross-wave-x5-runalls.mjs` — 11 / 11 OK.

```
OK  x5f         (exit 0)
OK  x5g         (exit 0)
OK  x5c         (exit 0)
OK  x5j         (exit 0)
OK  x5l         (exit 0)
OK  x5m         (exit 0)
OK  x5npqo      (exit 0)
OK  x5z5-build  (exit 1, expected 1 — pre-existing tailwindcss-vite e2e)
OK  x5r         (exit 0)
OK  x5z3        (exit 0)
OK  x5m3        (exit 0)   ← updated probe regex (see commit 5bcab6b)
```

## Heavy guards

- **Mossaic prod-w2** (BASE=http://127.0.0.1:8788): pre-existing
  playwright REJECT_INSTALL (Mossaic's package.json includes
  `playwright`; our REJECT_INSTALL list rejects it). Same shape as X.5-M3 /
  X.5-Z3 / X.5-R baselines. **NOT an X.5-S regression.**
- **W1 wave1-regression-w2** (BASE=http://127.0.0.1:8788): PASS,
  external=0, html=3206 bytes, tailwind OK.

## tsc

```
$ bun x tsc --noEmit
src/esbuild-service.ts(153,28): error TS2307: Cannot find module 'esbuild-wasm/esbuild.wasm' or its corresponding type declarations.
src/nimbus-session-init.ts(74,39): error TS2345: Argument of type 'SqliteVFSProvider' is not assignable to parameter of type 'VirtualProvider | MountProvider'.
```

2 errors — both pre-existing baseline (matches dispatch's "tsc clean
(2 baseline only)"). No new tsc errors from X.5-S.

## Verdict

vite at the real-package install layer: **CHARTER-PASS** —
`Identifier '__dirname' has already been declared` cleared at the
pre-compile site (3 wrap-call sites updated; conditional-param-rename
helper). Strict-✅ NOT achieved: vite further surfaces a deeper
unrelated failure class (rollup / lightningcss native-binding gap
already tracked by X.5-Z5-build).

Cross-wave: 0 regressions. tsc: clean (2 baseline errors only).
Mossaic: pre-existing playwright REJECT preserved. W1: PASS.

Predicted strict-✅ flip count: **+0 of +1 predicted**. The dispatch's
prediction (28/33) assumed no third-class failure beneath X.5-S; the
audit reveals the rollup-native-binding class also blocks vite. That's
the next bucket (call it X.5-T) — beyond X.5-S scope per dispatch
("acceptable to surface NEW deeper failure if multiple class issues —
document"). vite remains a charter-pass / not strict-✅ classifier
state, identical in shape to the X.5-M3 outcome.
