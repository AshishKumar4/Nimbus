/**
 * esbuild shim that uses esbuild-wasm loaded from CDN.
 *
 * When code inside Lifo does `require('esbuild')`, this shim is returned
 * instead of the native esbuild package (which can't run in the browser).
 *
 * The WASM binary is lazy-loaded on first transform/build call.
 */
export declare function createEsbuild(): Record<string, unknown>;
//# sourceMappingURL=esbuild.d.ts.map