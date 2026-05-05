# Spike: @swc/wasm-web — verdict

**Question (per plan §3.2):** is `wasm.js` not in the pre-bundle slice, or is it
something else?

## Findings

1. **Package shape (verified by local `bun add @swc/wasm-web`):**
   ```
   node_modules/@swc/wasm-web/
     LICENSE
     package.json   ("main": "wasm.js")
     wasm.d.ts
     wasm.js          (CJS loader)
     wasm_bg.wasm     (15,125,446 bytes — 15 MiB)
   ```

2. **Pre-bundle slice walker would include both files.** `walkDir(...)` in
   `src/pre-bundle-facet.ts:buildSliceForSpecifierWithCap` is a recursive
   directory walker with no extension filter; `.wasm` is binary-loader; so
   `wasm.js` AND `wasm_bg.wasm` should both end up in `fileMap`.

3. **However, `wasm_bg.wasm` is 15 MiB — under the 24 MiB cap, but tight.**
   If any other transitive dep brings the slice over 24 MiB, the slice is
   bailed and the package gets a CDN fallback (not a Nimbus install). For a
   standalone `npm install @swc/wasm-web`, the slice cap is fine.

4. **The actual error origin is `src/node-shims.ts:2058`:**
   ```
   "Cannot load module '" + resolvedPath + "': file was not pre-bundled.
    Add it to the VFS bundle."
   ```
   Fires when `new Function(code)` throws "Code generation from strings
   disallowed" — a workerd CSP-like restriction. This is a **runtime-side**
   issue, not an install-side or pre-bundle-side issue.

5. **The fix is NOT in @swc/wasm-web's slice walker.** It's in the runtime
   loader: a workerd-compatible code path that uses pre-compiled modules
   from `__compiledModules` instead of `new Function`. That's a fundamental
   facet-runtime architecture decision that affects every JS module the user
   tries to require, not just @swc/wasm-web.

## Surface-area gate verdict

**DEFER** to W6.5.x.

- Fix is not in 1 src/ file. The runtime-loader change touches `node-shims.ts`,
  potentially `cirrus-real.ts`, and likely `pre-bundle-facet.ts` (to ensure
  the user-app's modules are pre-compiled to functions and pickled into
  `__compiledModules` at startup).
- The fix is not @swc/wasm-web-specific — it's a general facet-runtime issue
  that the registry can't fix.

**Action:** keep `@swc/wasm-web` REJECT_INSTALL entry. Refine its `suggest:`
to be honest: "not pre-bundle wiring — runtime CSP-like 'Code generation
from strings disallowed' issue. Tracked separately."

## Track 2 promotion: NO.
