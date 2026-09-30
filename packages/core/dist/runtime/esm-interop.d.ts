export declare const ESM_NAMESPACE_KEY = "nimbus.esm.namespace";
/** An expression: is `value` a lowered ES module's exports object? */
export declare function isEsmNamespaceSource(value: string): string;
/**
 * Statements marking `target`, the exports object of a lowering that assigns
 * its exports as the module runs, as a lowered ES module's: its namespace is
 * the object itself, and `__esModule` is added (not enumerable, so a
 * namespace import does not list it) when the module exports a default.
 */
export declare function markEsmNamespaceSource(target: string, exportsDefault: boolean): string;
/**
 * A declaration of `name(exports)`: the namespace an import of those exports
 * sees. A lowered ES module's is its marker's; CommonJS gets module.exports as
 * `default` and its names, live.
 */
export declare function namespaceHelperSource(name: string): string;
/**
 * esbuild's CommonJS output with its interop helpers replaced by Node's rule.
 * esbuild prints its runtime helpers first, as top-level `var` declarations,
 * so only that prologue is parsed: parsing stops at the first statement that
 * declares no `__`-prefixed helper, and the rest of the module is never read.
 */
export declare function nodeInterop(cjs: string): string;
//# sourceMappingURL=esm-interop.d.ts.map