export interface CjsExports {
    /** Export names, in the order first detected. */
    readonly names: string[];
    /** Specifiers whose exports this module's include. */
    readonly reexports: string[];
}
/** `source`'s exports and reexports by cjs-module-lexer's rules; none for a source that does not tokenize. */
export declare function scanCjsExports(source: string): CjsExports;
//# sourceMappingURL=cjs-export-names.d.ts.map