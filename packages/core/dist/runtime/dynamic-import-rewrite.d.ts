export declare const DYNAMIC_IMPORT_HELPER = "__nimbusDynamicImport";
export declare function mayHaveDynamicImport(code: string): boolean;
interface Span {
    start: number;
    end: number;
}
/** Route the cell's import() calls to the process's loader, `loader(parentUrl, ...arguments)`. */
export declare function rewriteDynamicImports(code: string, parentUrl: string, loader?: string): string;
/** An import() call: where its `import` starts, and its opening parenthesis. */
export interface ImportCallSite {
    readonly start: number;
    readonly open: number;
}
/** A static import or re-export's specifier: its string literal, quotes included, and its value. */
export interface StaticSpecifierSite {
    readonly start: number;
    readonly end: number;
    readonly specifier: string;
    /** Its `with { … }` attributes, as written. */
    readonly attributes: Readonly<Record<string, string>>;
}
/** Where a module's text has module syntax a loader reads: import() calls, import.meta, static specifiers. */
export interface ImportSites {
    readonly calls: readonly ImportCallSite[];
    readonly metas: readonly Span[];
    readonly statics: readonly StaticSpecifierSite[];
    /** An import or export declaration, or import.meta: the text is an ES module. */
    readonly moduleSyntax: boolean;
    /** What staging reads beside the sites (native-esm.ts readEsModule): in Bun's scope, the CommonJS names its meta instance binds. */
    readonly commonJsNames?: readonly string[];
    /** It awaits at its top level (esm-require-hoist.ts hasTopLevelAwait). */
    readonly topLevelAwait?: true;
    /** The require() calls of its top level staging may hoist (esm-require-hoist.ts hoistableRequires). */
    readonly requires?: readonly string[];
}
/**
 * An ES module's import() calls, import.meta and static specifiers, as the
 * language reads them: the lexer's reading where it is the grammar's, and
 * otherwise the grammar's, a top-level statement at a time. Throws acorn's
 * SyntaxError for a module that does not parse.
 */
export declare function readModuleImportSites(code: string): ImportSites;
/**
 * The names `code` spells with unicode escapes: an added name must be none of
 * them, nor any ordinary spelling in the text (raw membership). Each word is
 * decoded alone; a word in text may over-exclude, which is safe.
 */
export declare function escapedIdentifierNames(code: string): Set<string>;
export {};
//# sourceMappingURL=dynamic-import-rewrite.d.ts.map