export interface StaticModuleSpecifierContext {
    nodeType: string;
    isSideEffectImport: boolean;
}
export interface ModuleSourceRewriteOptions {
    staticSpecifier(specifier: string, context: StaticModuleSpecifierContext): string | undefined;
    dynamicImport?(specifier: string): string | undefined;
    createRequireCallee?: string;
}
export declare function rewriteJavaScriptModuleSource(source: string, options: ModuleSourceRewriteOptions): string;
//# sourceMappingURL=module-source-rewriter.d.ts.map