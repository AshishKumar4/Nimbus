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

import {
  ESBUILD_WASM_JS_FN_BODY,
  ESBUILD_WASM_VERSION,
} from '../esbuild-wasm-bundle.generated.js';
import { getExportsResolverJS } from '../_shared/exports-resolver.js';
// NOTE: wasm BYTES deliberately NOT in this preamble. They live in
// env.ASSETS at /_assets/esbuild-<version>.wasm and are fetched by
// the supervisor at pool-construction time
// (src/esbuild-wasm-bytes.ts), then handed to NimbusLoaderPool's
// `wasmModules` option which registers them in the LOADER `modules`
// map as `{ wasm: ArrayBuffer }`. workerd compiles during the
// worker's module-load phase (where wasm code generation is
// permitted) and exposes the resulting WebAssembly.Module via the
// standard ESM import the pool prepends to worker.js.
//
// Earlier approaches that DIDN'T work (history kept for context):
//   1. Inline the ~16 MiB base64 in this preamble — workerd allocates
//      a 16 MiB module-source string per pool.submit dispatch which
//      combined with post-install supervisor heap state OOM-killed
//      the DO on entry to the pre-bundle phase (verified on prod).
//   2. WebAssembly.compile() in the facet at request time — workerd's
//      deployed config disallows wasm code generation at request time
//      ("Wasm code generation disallowed by embedder").
//   3. RPC of a pre-compiled WebAssembly.Module from supervisor —
//      workerd's structured-clone refuses Module transfer in this
//      deploy ("Unable to deserialize cloned data").
//
// Phase 2 A'.5 also moved the bytes OUT of the supervisor module
// bundle (was a 16 MiB base64 string in the generated TS file → 21
// MiB UTF-16 in supervisor module scope). Now they only live where
// they're needed: in the LOADER cache after pool construction, and
// in env.ASSETS at rest.

/**
 * Resolver helpers, sourced from src/_shared/exports-resolver.ts via
 * getExportsResolverJS(). Single source of truth — see
 * audit/sections/03-resolver-gaps.md §3.1 for the prior 3-copy drift this
 * consolidates. The pre-bundle facet uses `resolvePackageEntry` (line 492
 * of src/pre-bundle-facet.ts).
 */
const RESOLVER_HELPERS_SRC = getExportsResolverJS();

/**
 * Preamble string injected ahead of the prebundleOne function in every
 * pre-bundle facet isolate. Must be passed via NimbusLoaderPool's
 * `preamble` option.
 */
export const PRE_BUNDLE_PREAMBLE: string = `
// ── pre-bundle facet preamble (auto-generated) ──────────────────────────
// Esbuild JS helpers (small ~117 KiB). The wasm BYTES are NOT here —
// they're fetched at facet boot via env.SUPERVISOR.getEsbuildWasm() to
// keep the per-dispatch worker module source under ~120 KiB instead of
// ~16 MiB. See src/parallel/pre-bundle-preamble.ts header for why.
const ESBUILD_WASM_VERSION = ${JSON.stringify(ESBUILD_WASM_VERSION)};
const ESBUILD_WASM_JS_FN_BODY = ${JSON.stringify(ESBUILD_WASM_JS_FN_BODY)};

// ── Materialise esbuild namespace at MODULE STARTUP ─────────────────────
// workerd's deployed config disallows \"Code generation from strings\" at
// request time inside dynamic workers (verified via prod repro: pre-bundle
// fn body called \`new Function(jsBody)()\` and got
// \"Code generation from strings disallowed for this context\" for every
// spec). The codebase already documents this constraint at
// src/node-shims.ts:1006-1015.
//
// Workaround: run \`new Function(...)()\` here in the preamble — preambles
// execute at module-load time (the worker's startup phase) where eval IS
// permitted. We capture the resulting esbuild namespace in a module-scope
// const that the user fn references at request time. Same pattern as
// src/facet-manager.ts:176 (USER_CODE is compiled in the generated module
// scope, not inside the request handler).
//
// Fail-safe: if even startup-time eval is blocked, set the cache to a
// sentinel object that the user fn detects and surfaces as a loud error
// (rather than passing undefined and crashing on .initialize).
let __NIMBUS_ESBUILD_NS = null;
let __NIMBUS_ESBUILD_INIT_ERR = null;
try {
  __NIMBUS_ESBUILD_NS = (new Function(ESBUILD_WASM_JS_FN_BODY))();
} catch (e) {
  __NIMBUS_ESBUILD_INIT_ERR = String((e && e.message) || e);
}

${RESOLVER_HELPERS_SRC}
// ── end pre-bundle facet preamble ───────────────────────────────────────
`;
