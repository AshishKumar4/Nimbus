/**
 * The runtime's function a bound record calls for its package: the one the
 * module system serves (node-shims.ts), named apart from the module's own
 * `require`, which an ES module does not have (module-format.ts).
 */
export declare const PROVIDED_PACKAGE_HOOK = "__nimbusProvidedPackage";
/** Bind canonical esbuild/Bun CommonJS records to the runtime's provided packages. */
export declare function rewriteProvidedCommonJsModules(source: string): string;
//# sourceMappingURL=provided-packages.d.ts.map