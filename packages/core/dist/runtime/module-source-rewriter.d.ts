export interface StaticModuleSpecifierContext {
    nodeType: string;
    isSideEffectImport: boolean;
}
export interface ModuleSourceRewriteOptions {
    staticSpecifier(specifier: string, context: StaticModuleSpecifierContext): string | undefined;
    /** The text the whole `import(specifier)` expression becomes. */
    dynamicImport?(specifier: string): string | undefined;
    /** The specifier an `import(specifier)` takes instead, the rest of the expression kept. */
    dynamicImportSpecifier?(specifier: string): string | undefined;
    createRequireCallee?: string;
}
export declare function rewriteJavaScriptModuleSource(source: string, options: ModuleSourceRewriteOptions): string;
//# sourceMappingURL=module-source-rewriter.d.ts.map