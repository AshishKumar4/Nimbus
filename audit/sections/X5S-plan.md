# X.5-S plan — pre-compile `__dirname` re-declaration

> Per VERIFY-23417C5.md §4 #1 / X5M3-retro.md §"Per-package verdict — vite — Next bucket".
> Branch: `x5s-dirname` from `origin/main` HEAD `23417c5`.
> Predicted classifier delta: +1 strict ✅ → 28/33.

## 1. Investigation summary

vite blocks at install layer with:

```
Cannot load module 'home/user/app/node_modules/vite/dist/node/chunks/node.js':
  pre-compile failed at facet startup:
  Identifier '__dirname' has already been declared
```

Reproduced both as standalone Node (`audit/probes/x5s/investigation/repro.mjs`)
and via local wrangler dev e2e (`e2e-RED-baseline.out.txt`).

## 2. Root cause (final)

Three components conspire:

1. **Source**: vite's `chunks/node.js` (transitive bundle of `open@10.2.0`)
   contains the ESM idiom
   ```js
   const __dirname = path.dirname(fileURLToPath(import.meta.url));
   ```

2. **W3.5 Fix B (`transformEsmInBundle`, facet-manager.ts:953-993)** runs
   the file through `esbuild --format=cjs --target=esnext`. esbuild's
   empty-import-meta CJS substitution emits:
   ```js
   const import_meta = {};
   const __dirname = import_path.default.dirname((0, import_url.fileURLToPath)(import_meta.url));
   ```
   The `const __dirname = …` line is preserved unchanged.

3. **Pre-compile wrap (facet-manager.ts:215, :400; node-shims.ts:2312)**
   wraps the body in `new Function("exports","require","module","__filename","__dirname", code)`.
   The parameter list and the body's `const __dirname` collide at parse
   time → `SyntaxError: Identifier '__dirname' has already been declared`
   → caught by the pre-compile loop → recorded into `__compileFailures`
   → surfaced at `__loadModule` request time as the error above.

The fault is at the **wrap site**, not the source or the esbuild
transform: the wrap unconditionally injects a `__dirname` parameter
that conflicts with any source that declares its own.

## 3. Fix sketch

Drop the `__dirname` (and `__filename`, symmetrically) parameter from
`new Function(...)` when the body already declares it. The body's
binding becomes the single declarer; callers continue passing 5
positional args (JS ignores extras when the function declares fewer
parameters).

### File:line targets

| File | Line | Site | Type |
|------|------|------|------|
| `src/facet-manager.ts` | 215 | `generateFacetCode` pre-compile loop | hot path (every module wrapped at facet startup) |
| `src/facet-manager.ts` | 400 | `generateEntrypointCode` pre-compile loop | hot path (LOADER.load fallback) |
| `src/node-shims.ts` | 2312 | `__loadModule` runtime fallback | cold path (runs only when `__compiledModules.get(p)` misses) |

### Diff sketch

Add a helper used at all three sites:

```js
// Conditional-param wrap. The body of an esbuild ESM→CJS transform may
// declare its own `const __dirname = path.dirname(fileURLToPath(import.meta.url))`
// (vite's open@10 transitive), which collides with `__dirname` as a
// function parameter at parse time. Detect-and-drop the param when the
// body declares it; callers still pass 5 positional args (JS ignores
// trailing args when the fn declares fewer params).
function __mkCompiledFn(code) {
  const re = (id) => new RegExp(
    "(?:^|\\n|;)\\s*(?:const|let|var)\\s+" + id + "\\s*=", "m");
  const params = ["exports","require","module"];
  if (!re("__filename").test(code)) params.push("__filename");
  if (!re("__dirname").test(code))  params.push("__dirname");
  return new Function(...params, code);
}
```

Implementation note: in `facet-manager.ts` the helper lives inside the
generated facet code (it's a string template), so it goes near the top
of `generateFacetCode` / `generateEntrypointCode` and replaces both the
inline `new Function(...)` at the `__compiledFn` initialization and the
loop at line 215/400.

The user-code `__compiledFn` (line 192/380) is also subject to this —
USER_CODE that happens to declare `__dirname` at top-level (e.g.,
TS-compiled to CJS that emits `const __dirname = …`) would today
silently fail. Same conditional-drop applies symmetrically.

In `node-shims.ts` the runtime fallback (line 2312) is the same shape
inlined directly. Apply the same conditional-drop.

## 4. Regression matrix

| Layer | Probe | Pre-fix | Post-fix |
|-------|-------|---------|----------|
| Synthetic | `investigation/repro.mjs` | RED (collision) | GREEN |
| Functional | `functional/f1-conditional-param-drop-marker.mjs` | RED (no marker in shim source) | GREEN |
| Functional | `functional/f2-eval-no-collision.mjs` | RED (collision repro) | GREEN |
| Functional | `functional/f3-clean-body-still-binds-dirname.mjs` | GREEN both — invariant guard | GREEN |
| Regression | `regression/install-pipeline-coverage-shim.mjs` (X.5-F) | GREEN | GREEN |
| Regression | `regression/single-resolver-source.mjs` (X.5-F) | GREEN | GREEN |
| Regression | `regression/cross-wave-x5-runalls.mjs` | GREEN (mod x5z5-build pre-existing) | GREEN |
| E2E | `e2e/e1-vite-loads.mjs` | RED (`__dirname has already been declared`) | GREEN at this layer (vite may surface deeper class — document) |

Cross-wave heavy guards (run on demand, not in run-all default):
- mossaic prod-w2 — vite-driven dev server smoke
- W1 wave1-regression-w2

## 5. Anti-requirements / scope guards

- **NO** changes to `src/facet-manager.ts` `buildPrefetchBundle`
  CAP-EVICTION logic (X.5-26b territory).
- **NO** changes to `src/npm-installer.ts` or `src/npm-resolve-facet.ts`
  (X.5-peer-gap territory).
- **NO** changes to `src/require-resolver.ts` (X.5-L) or
  `src/npm-resolver.ts` (X.5-J).
- Fix is additive: a single helper in three places (two in the generated
  facet template strings, one in the shim runtime fallback). No existing
  call shape changes — callers still pass 5 positional args.
- The `__compileFailures` surfacing path (W3.5 Fix C) stays intact:
  failures other than `__dirname` collision continue to be recorded and
  surfaced verbatim.

## 6. Self-review TL;DR

- Three call sites share an identical wrap signature; one helper covers all.
- The fix is purely conditional — when body has no `const __dirname`,
  the parameter is preserved (legacy CJS unchanged).
- JS arg-passing is amenable: extras are silently discarded by the
  function when it declares fewer parameters.
- `__filename` is patched symmetrically — vite's open@10 sometimes also
  emits `const __filename = fileURLToPath(import.meta.url)`. Without
  symmetric handling we'd ship X.5-S' twin failure as next bucket.
- The post-fix vite path is expected to surface a deeper failure
  (`fileURLToPath(undefined)` runtime crash from the body's now-executing
  `const __dirname = …`). Per dispatch: "acceptable to surface NEW deeper
  failure if multiple class issues — document". Documented in
  INVESTIGATION.md §"Predicted post-fix shape".

## 7. Open question deferred

If the post-fix vite e2e exposes the predicted `fileURLToPath(undefined)`
crash, that's a NEW bucket (call it X.5-T candidate): teach
`__urlMod.fileURLToPath` to handle undefined input gracefully (perhaps
using `globalThis.__currentModulePath` like the URL shim already does),
or teach esbuild's substitution to emit `import_meta.url = "file:///"+__filename`
instead of `{}`. **Out of X.5-S scope.**
