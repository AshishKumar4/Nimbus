/** Why Node will not run a TypeScript file; `snippet` (with `filename` and `startLine`) where amaro shows the place. */
export interface TypeScriptRefusal {
    code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' | 'ERR_INVALID_TYPESCRIPT_SYNTAX' | 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING' | 'ERR_UNKNOWN_FILE_EXTENSION';
    message: string;
    filename: string;
    startLine: number;
    snippet: string;
}
/** What Node's ES loader says of TypeScript it does not take (`--no-experimental-strip-types`). */
export declare function unknownExtensionRefusal(path: string): TypeScriptRefusal;
/** The refusal of a file under node_modules, which Node does not strip. */
export declare function nodeModulesRefusal(path: string): TypeScriptRefusal;
/**
 * The module of a TypeScript file Node refuses: requiring or importing it
 * throws Node's error, with amaro's snippet before its stack where it shows
 * the place, and no arrow of the generated code (node-shims.ts
 * __nimbusGeneratedNodeError).
 */
export declare function typeScriptRefusalShim(refusal: TypeScriptRefusal): string;
//# sourceMappingURL=typescript-refusal.d.ts.map