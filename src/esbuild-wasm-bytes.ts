/**
 * esbuild-wasm-bytes.ts — supervisor-side cache of the bundled
 * esbuild-wasm bytes as an ArrayBuffer.
 *
 * Used by NpmInstaller to populate NimbusFacetPool's `wasmModules`
 * option, which workerd registers in the LOADER `modules` map and
 * compiles at facet startup. Splitting this into its own tiny module
 * avoids the circular import that would result from putting the cache
 * helper directly in nimbus-session.ts (which already imports
 * NpmInstaller).
 *
 * Decoded once per supervisor isolate; subsequent calls return the
 * same ArrayBuffer reference. workerd reuses supervisor isolates
 * across DOs so this cache outlives any one session — pay the decode
 * cost ~once per worker boot.
 *
 * Why dynamic import: defers the ~16 MiB string allocation in
 * src/esbuild-wasm-bundle.generated.ts until first use. A session
 * that never installs npm pays nothing.
 */

let _bytes: ArrayBuffer | null = null;
let _promise: Promise<ArrayBuffer> | null = null;

export async function getEsbuildWasmBytes(): Promise<ArrayBuffer> {
  if (_bytes) return _bytes;
  if (_promise) return _promise;
  _promise = (async () => {
    const mod = await import('./esbuild-wasm-bundle.generated.js');
    const b64 = mod.ESBUILD_WASM_BASE64;
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    _bytes = u.buffer;
    return _bytes;
  })();
  try {
    return await _promise;
  } catch (e) {
    _promise = null;
    throw e;
  }
}
