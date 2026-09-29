/**
 * host-wasm.ts — the WebAssembly modules this Worker bundles, handed to
 * dynamic workers compiled.
 *
 * wrangler bundles a `.wasm` import as a compiled module, and workerd
 * compiles it once, at script startup, in every isolate of the script
 * (https://developers.cloudflare.com/workers/wrangler/bundling/). A Worker
 * Loader module map accepts that WebAssembly.Module as a member and the
 * dynamic worker shares its compiled code (workerd src/workerd/api/
 * worker-loader.c++, extractWasmModuleContent), so a facet built on it
 * needs no second copy of the bytes, no fetch of them, and no compile.
 * Each module is described (@nimbus-sh/fabric/host-wasm.js) with its wire
 * size, which still counts toward the 64 MiB dynamic-worker code limit.
 */
import { describeHostWasm } from '@nimbus-sh/fabric/host-wasm.js';
import { ESBUILD_WASM_BYTES, ESBUILD_WASM_VERSION } from '../esbuild-wasm-bundle.generated.js';

let esbuild: Promise<WebAssembly.Module> | null = null;

/**
 * esbuild's wasm, the module core's EsbuildService initializes from. Imported
 * on first use, like core's own import of it: outside a wrangler bundle (bun,
 * node) the specifier does not resolve to a module, and a static import would
 * fail every importer there.
 */
export function esbuildWasmModule(): Promise<WebAssembly.Module> {
  esbuild ??= import('esbuild-wasm/esbuild.wasm').then(({ default: module }) => {
    if (!(module instanceof WebAssembly.Module)) {
      throw new Error(
        'esbuild-wasm/esbuild.wasm did not import as a WebAssembly.Module; '
          + 'the Worker must be bundled by wrangler, which compiles it at startup',
      );
    }
    return describeHostWasm(module, { id: `esbuild-wasm@${ESBUILD_WASM_VERSION}`, bytes: ESBUILD_WASM_BYTES });
  });
  return esbuild;
}
