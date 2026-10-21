/**
 * cjs-module-lexer's JavaScript build (lexer.js of the version
 * packages/core/package.json pins, Node 22.23.4's), wrapped in a factory:
 * the lexer Node's ESM loader runs on a CommonJS module to name its exports
 * before it runs (lib/internal/modules/esm/translators.js
 * cjsPreparseModuleExports). The package's own ESM build is its wasm one,
 * which needs a compile no Worker may make at runtime. Each createCjsLexer()
 * evaluates a fresh copy: the upstream module keeps its scan state at module
 * level.
 *
 * Between the markers is the upstream file verbatim but for its three
 * `module.exports` lines; tests/unit/cjs-module-lexer-vendor.mjs checks it
 * lexes as the installed package does. MIT License, Copyright (C) 2018-2020
 * Guy Bedford.
 */
/** The names a CommonJS module exports, and the specifiers whose exports it re-exports. */
export interface CjsLexed {
    readonly exports: readonly string[];
    readonly reexports: readonly string[];
}
/** Lexes one source; throws where it cannot. */
export type CjsLexer = (source: string, name?: string) => CjsLexed;
export declare function createCjsLexer(): CjsLexer;
//# sourceMappingURL=cjs-module-lexer.d.ts.map