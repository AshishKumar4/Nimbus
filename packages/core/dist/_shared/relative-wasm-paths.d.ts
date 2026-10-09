/**
 * Wasm images named beside a JavaScript module, by a quoted relative path.
 * Shared by the launch's image collector and import()'s late read-ahead.
 * Self-contained: the node shims declare it from its compiled bundle.
 */
export declare function relativeWasmPaths(source: string, filename: string): string[];
//# sourceMappingURL=relative-wasm-paths.d.ts.map