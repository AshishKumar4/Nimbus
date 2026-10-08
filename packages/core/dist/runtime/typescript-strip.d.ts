import { type PackageType } from './module-format.js';
import type { TypeScriptRefusal } from './typescript-refusal.js';
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