/** Whose detection a scan follows: Node's (cjs-module-lexer) or the Vite dev server's interop. */
export type CjsExportPolicy = 'node' | 'vite';
export interface CjsExports {
    /** Export names, in the order first detected. */
    readonly names: string[];
    /** Specifiers whose exports this module's include. */
    readonly reexports: string[];
}
/** `source`'s exports and reexports by `policy`; none for a source that does not tokenize, as the lexer has none. */
export declare function scanCjsExports(source: string, policy?: CjsExportPolicy): CjsExports;
//# sourceMappingURL=cjs-export-names.d.ts.map