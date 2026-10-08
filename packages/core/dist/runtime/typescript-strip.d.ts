import { type PackageType } from './module-format.js';
/** Why Node will not run a TypeScript file; `snippet` (with `filename` and `startLine`) where amaro shows the place. */
export interface TypeScriptRefusal {
    code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' | 'ERR_INVALID_TYPESCRIPT_SYNTAX' | 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING' | 'ERR_UNKNOWN_FILE_EXTENSION';
    message: string;
    filename: string;
    startLine: number;
    snippet: string;
}
/** Stripped code and the format Node runs it in, or why Node refuses it. */
export type StrippedTypeScript = {
    code: string;
    format: 'module' | 'commonjs';
} | {
    refusal: TypeScriptRefusal;
};
export interface TypeScriptStripOptions {
    mode: 'strip-only' | 'transform';
    sourceMap: boolean;
}
/** How Node takes a launch's TypeScript: stripped so, or as JavaScript (`--no-experimental-strip-types`). */
export type NodeTypeScript = TypeScriptStripOptions | 'javascript';
export declare function stripTypeScript(code: string, filename: string, { mode, sourceMap }: TypeScriptStripOptions, packageType: PackageType): Promise<StrippedTypeScript>;
//# sourceMappingURL=typescript-strip.d.ts.map