# X.5-M3 Investigation — `import.meta.url` null/undefined-base failure path

> **Date:** 2026-05-05 autonomous wave-runner session.
> **Branch:** `x5m3-null-base` off main `7535622` (post-X.5-Z3 merge; jsdom flipped → 25/33 strict ✅).
> **Charter:** P2 per VERIFY-700420F.md §4 #3 — vite blocks at `URL` constructor with null-base on `import.meta.url` substitution. Continuation of X.5-NPQO O-bucket fix path. Predicted: +1 ✅ → 26/33 strict.

---

## 1. Repro — vite ENOENT stack

From `audit/probes/verify-700420f/packages-local/vite.out.txt:119-129`:

```
Error: ENOENT: no such file or directory, open 'file:///package.json'
    at readFileSync (runner.js:226:19)
    at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:144:64)
    at __loadModule (runner.js:2712:7)
    at __requireFrom (runner.js:2803:10)
    at scopedRequire (runner.js:2697:33)
    at eval (eval at <anonymous> (runner.js:34:34), <anonymous>:84:21)
    at __loadModule (runner.js:2712:7)
    at __requireFrom (runner.js:2803:10)
    at __require (runner.js:2811:10)
    at eval (eval at <anonymous> (runner.js:11:22), <anonymous>:3:9)
```

The throwing `readFileSync` is the FIRST one (deepest frame); the chain is:
- user code: `require('vite')` → loads `node_modules/vite/dist/node/index.js`
- index.js: top-level imports re-export from `dist/node/chunks/logger.js`
- logger.js line 75:
  ```js
  const { version } = JSON.parse(
    readFileSync(
      new URL("../../package.json",
              new URL("../../../src/node/constants.ts", import.meta.url))
    ).toString()
  );
  ```

## 2. Root cause — esbuild ESM→CJS transform substitutes `import.meta = {}`

facet-manager.ts's `transformEsmInBundle` runs every ESM-shaped `.js`/`.mjs` file in the prefetch bundle through `esbuild.transform({ format: 'cjs' })` at facet-prepare time (W3.5 Fix B). That transform's behavior for `import.meta.url`:

```
$ esbuild --format=cjs --target=esnext < test.js
▲ [WARNING] "import.meta" is not available with the "cjs" output format and will be empty [empty-import-meta]
var import_node_fs = require("node:fs");
const import_meta = {};
const x = new URL("../../package.json",
                  new URL("../../../src/node/constants.ts", import_meta.url));
```

So at runtime in our facet:
- `import_meta.url` evaluates to **`undefined`** (property of empty object).
- Inner `new URL("../../../src/node/constants.ts", undefined)` enters our X.5-M shim (`src/node-shims.ts:818-839`).
- That shim's `base == null && typeof input === "string"` branch first tries `super(input)` (fails — relative path is not a valid absolute URL), catches, falls back to `super(input, "file:///")`.
- Result: `file:///src/node/constants.ts` (relative `../../../` resolves to `/`, then re-anchored by `file:///` base).
- Outer `new URL("../../package.json", <inner URL instance>)` → `file:///package.json` (resolves up two from `/src/node/constants.ts`).
- `readFileSync(<that URL>)` → fs `_resolve` strips `file://` → `/package.json`.
- `_bundleLookup('/package.json')` fails — vite's actual package.json is at `home/user/app/node_modules/vite/package.json`.
- ENOENT, message echoes the original URL arg as `'file:///package.json'`.

## 3. Compile context — confirmed esbuild CJS-emit

```
$ cat /tmp/test-im3.js
import { readFileSync } from "node:fs";
const x = new URL("../../package.json", new URL("../../../src/node/constants.ts", import.meta.url));
console.log("URL:", x.href);

$ bun x esbuild --format=cjs --target=esnext /tmp/test-im3.js
var import_node_fs = require("node:fs");
const import_meta = {};
const x = new URL("../../package.json", new URL("../../../src/node/constants.ts", import_meta.url));
console.log("URL:", x.href);
```

The `const import_meta = {};` is emitted **once per file** at the top of every transformed module, regardless of whether `import.meta.url` is actually used. esbuild does NOT have any way to know what `__filename` will be at runtime, so it emits the empty stub.

## 4. Localization — which compile context loses `import.meta.url`?

**Confirmed:** esbuild ESM→CJS pre-compile, applied at `facet-manager.ts:953 transformEsmInBundle` for any `.js`/`.mjs` file that `looksLikeEsm()` accepts.

Vite's `chunks/logger.js` is in a `"type":"module"` package, contains top-level `import { readFileSync } from "node:fs";` → `looksLikeEsm` returns true → esbuild transforms → emits `const import_meta = {};` → vite's downstream `readFileSync(new URL(..., import_meta.url))` reads `file:///package.json`.

This is **NOT** a vite-SSR / Vite optimizeDeps / Vite facet-entry-vs-subpath issue — it's a workspace-wide property of every transformed ESM file. Any package that uses `new URL("...", import.meta.url)` in ESM source will hit it once we transform to CJS.

## 5. Other potential occurrences of the same root cause

Quick survey of the 33 verify-700420f packages for files that use `import.meta.url`-based URL composition:

```
$ grep -rn 'new URL.*import.meta.url' /tmp/vite-investigate/node_modules/vite/dist/node/chunks/*.js
logger.js:75    new URL("../../package.json", new URL("../../../src/node/constants.ts", import.meta.url))
logger.js:165   new URL("../../../src/node/constants.ts", import.meta.url)
```

(Only the line-75 form actually calls `readFileSync`; the line-165 form passes the URL through `fileURLToPath` then `resolve` and is a path-string operation, which works once URL has the right pathname.)

## 6. Fix decision matrix

Three viable fix sites:

| # | Approach | Site | Pros | Cons |
|---|---|---|---|---|
| 1 | Pre-compile transform: replace `const import_meta = {}` with `const import_meta = { url: "file:///" + __filename }` AFTER esbuild transform. | `src/facet-manager.ts:transformEsmInBundle` post-process. | Surgical, single regex, runs once at facet prepare. | **PROHIBITED by anti-requirement** ("DO NOT touch src/facet-manager.ts"). |
| 2 | Runtime URL shim: when `base == null` and input is a relative-looking string, instead of falling back to `"file:///"`, fall back to `"file:///" + globalThis.__currentModulePath`. Set `__currentModulePath` in `__loadModule` before precompiled invocation. | `src/node-shims.ts` URL shim @ line ~818, plus `__loadModule` @ line ~2243. | All-in-node-shims.ts (only file we can touch). Surgical (~10 LOC). Doesn't change esbuild output. | Per-call dependency on a global — must save+restore around recursive `__loadModule` calls. |
| 3 | Pre-compile transform inside `__loadModule` fallback path: post-process `code` before `new Function`. | `src/node-shims.ts:2280-2282`. | Single-site fix. | Only covers the FALLBACK path, not the precompiled path (line 2275-2277), which is the hot path for ESM-transformed bundles. |

**Decision: approach #2.** It is the only approach that:
1. Stays within the allowed file (`src/node-shims.ts`).
2. Covers BOTH the precompiled path AND the fallback path (because the URL shim is invoked at runtime regardless of how the module's source was compiled).
3. Doesn't modify the source bytes — purely runtime behavior change.

Save+restore around recursive `__loadModule` is straightforward (1 local variable; the field is set on entry, restored on exit). The sentinel value is `"/" + resolvedPath` (matching the existing `__filename` argument convention).

## 7. Predicted regression matrix (Phase B will formalize)

The change must NOT regress:
- X.5-M e2e (which passed pre-X.5-M3 with the `"file:///"` fallback) — verify the `__currentModulePath`-based fallback still produces a valid URL when the input is an absolute URL string.
- X.5-NPQO O-bucket functional probe (`o-fs-url.mjs`) — that probe uses URL instances and `file://` strings as direct fs inputs, NOT relative-string-with-null-base. Should be unaffected.
- X.5-Z3 jsdom flip — uses `addStaticReadFileAssets` for fs.readFileSync(path.resolve(__dirname, "...css")); URL constructor not on the hot path.
- Single-resolver invariant — purely a node-shims.ts edit, no resolver touch.
- tsc baseline (2 errors) — must be byte-identical post-fix.
- mossaic + W1 cross-wave — must remain green.

## 8. Relationship to NPQO Bucket O

X.5-NPQO Bucket O fixed `_resolve` to strip `file://` and unwrap URL instances on fs paths (commit a65c994). That fix is mechanically correct and necessary; without it, vite's stack would be even further from healthy. The X.5-NPQO retro §O explicitly noted:

> Bucket O fix is the right shim-layer fix. The vite e2e strict-✅ flip requires also addressing M-3's null-base behavior (so that `import.meta.url` resolves to a real file path in the rolldown-CJS polyfill rather than null). That's a separate wave.

X.5-M3 IS that separate wave. Bucket O said "M-3 null-base"; we are M-3, and the null-base is `import.meta.url === undefined` post-esbuild-CJS substitution.

## 9. Files to touch (Phase D plan)

ONLY: `src/node-shims.ts`. Two regions:
- ~line 818-839: URL shim body — add `globalThis.__currentModulePath` lookup in the null-base fallback branch.
- ~line 2271-2303: `__loadModule` body — set `globalThis.__currentModulePath = "/" + resolvedPath` on entry; save+restore.

Both regions are within the runner.js string template (lines 1-2390 of node-shims.ts is a single TS template literal exporting the runner).

## 10. Charter exit criteria

- vite e2e probe at the install layer: ENOENT(file:///package.json) GONE (charter-pass minimum); ✅ at strict classifier (vite loads, exposes `defineConfig` or similar) preferred.
- 0 cross-wave regressions.
- All 8 X.5 wave run-alls (F/G/C/J/L/M/NPQO/Z5/R/Z3) green.
- tsc baseline 2 errors preserved.
- Single-resolver invariant intact.
- Mossaic + W1 cross-wave probes green.
