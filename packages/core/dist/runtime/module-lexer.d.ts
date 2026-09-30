/**
 * es-module-lexer's CSP build (dist/lexer.asm.js of the version
 * packages/core/package.json pins), wrapped in a factory. The upstream module
 * keeps its scratch buffer, a power-of-two ArrayBuffer of 2 bytes per
 * character of the largest source it has lexed plus 512 KiB, for as long as
 * the module lives. Each createModuleLexer() evaluates a fresh copy with its
 * own buffer, so a caller that drops a lexer releases what its sources grew.
 *
 * Between the markers is the upstream file verbatim but for `export` removed
 * from `export function parse`; tests/unit/module-lexer-vendor.mjs checks it
 * against the installed package. MIT License, Copyright (C) 2018-2022 Guy
 * Bedford (see NOTICE.md).
 */
/** An import the lexer found: `t` 2 is an import() call, 3 is import.meta. */
export interface LexedImport {
    readonly t: number;
    readonly s: number;
    readonly e: number;
    readonly ss: number;
    readonly se: number;
    readonly d: number;
}
/** Lexes one source; throws an Error with a numeric `idx` where it cannot. */
export type ModuleLexer = (source: string) => readonly [readonly LexedImport[], ...unknown[]];
export declare function createModuleLexer(): ModuleLexer;
//# sourceMappingURL=module-lexer.d.ts.map