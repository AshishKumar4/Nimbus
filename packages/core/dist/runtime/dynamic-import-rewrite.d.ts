export declare const DYNAMIC_IMPORT_HELPER = "__nimbusDynamicImport";
export declare function mayHaveDynamicImport(code: string): boolean;
/**
 * Route the cell's import() calls to the process's loader and, with
 * `moduleMetadata`, bind its import.meta to the module's own. `routeImports`
 * false binds metadata alone: a transform that lowers module syntax binds
 * import.meta before lowering (CommonJS output would make it {}) and routes
 * import() after, once the cell's import bindings are member reads that
 * cannot capture the loader's name.
 */
export declare function rewriteDynamicImports(code: string, parentUrl: string, moduleMetadata?: boolean, routeImports?: boolean): string;
//# sourceMappingURL=dynamic-import-rewrite.d.ts.map