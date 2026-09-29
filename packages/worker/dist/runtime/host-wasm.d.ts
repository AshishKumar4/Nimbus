/**
 * esbuild's wasm, the module core's EsbuildService initializes from. Imported
 * on first use, like core's own import of it: outside a wrangler bundle (bun,
 * node) the specifier does not resolve to a module, and a static import would
 * fail every importer there.
 */
export declare function esbuildWasmModule(): Promise<WebAssembly.Module>;
//# sourceMappingURL=host-wasm.d.ts.map