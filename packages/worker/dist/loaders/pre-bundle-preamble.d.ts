/**
 * pre-bundle-preamble.ts — preamble injected into NimbusLoaderPool isolates
 * that run src/pre-bundle-facet.ts.
 *
 * NimbusLoaderPool serialises the user function via fn.toString() and runs
 * it inside a dynamic worker built from inline modules. Names referenced
 * by the function at the module-top-level scope are NOT in that worker's
 * lexical scope at runtime — they must be re-declared in the preamble.
 *
 * Specifically prebundleOne references:
 *   - ESBUILD_WASM_JS_FN_BODY — function-body string (~117 KiB) that,
 *                               when run via new Function(...)(), returns
 *                               the esbuild namespace. SMALL — kept inline.
 *   - resolvePackageEntry     — the npm-resolver helper used by the
 *                               bare-specifier resolver
 *
 * NOT in the preamble:
 *   - ESBUILD_WASM_BASE64 / wasm BYTES — the wasm Module is shipped via
 *     NimbusLoaderPool's `wasmModules` option (LOADER `modules` map
 *     entry shape `{ wasm: ArrayBuffer }`). Workerd compiles it at
 *     module-load (startup phase) and the pool's generated worker.js
 *     exposes the resulting WebAssembly.Module on
 *     globalThis.__NIMBUS_WASM['esbuild.wasm']. The pre-bundle facet
 *     reads it at request time and passes to esb.initialize().
 *
 * resolvePackageEntry is a pure-JS function from src/npm-resolver.ts;
 * we inline its source here so the facet doesn't need to fault back
 * to the supervisor for it.
 *
 * Preamble bytes are part of the loader-cache key for NimbusLoaderPool.
 * Changing this file invalidates all warm slots in the pre-bundle pool;
 * fine — esbuild boot is the dominant cost and re-paying it once on a
 * deploy is acceptable.
 */
/**
 * Preamble string injected ahead of the prebundleOne function in every
 * pre-bundle facet isolate. Must be passed via NimbusLoaderPool's
 * `preamble` option.
 */
export declare const PRE_BUNDLE_PREAMBLE: string;
//# sourceMappingURL=pre-bundle-preamble.d.ts.map