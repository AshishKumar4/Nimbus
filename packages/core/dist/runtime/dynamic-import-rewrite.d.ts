/** The loader a rewritten `import()` calls (node-shims.ts). */
export declare const DYNAMIC_IMPORT_HELPER = "__nimbusDynamicImport";
/**
 * Whether `code` can hold an ImportExpression at all: one needs the keyword
 * `import` followed, past whitespace and comments, by `(`. A keyword cannot
 * be spelled with escapes, so a cell without this can be skipped unparsed;
 * one with it is decided by the parse.
 */
export declare function mayHaveDynamicImport(code: string): boolean;
/**
 * `code` with each ImportExpression's `import(` replaced by
 * `__nimbusDynamicImport("<parentUrl>", `. The arguments stay as written, so
 * evaluation order and the options argument are the program's.
 *
 * A cell is a function body (it may `return` or `await` at its top level);
 * one acorn cannot parse is returned unchanged, for the compile to report.
 */
export declare function rewriteDynamicImports(code: string, parentUrl: string, moduleMetadata?: boolean): string;
//# sourceMappingURL=dynamic-import-rewrite.d.ts.map