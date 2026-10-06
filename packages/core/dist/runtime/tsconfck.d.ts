/**
 * tsconfck.ts — the tsconfig a TypeScript module compiles under, found and
 * read as tsconfck 3.1 (https://github.com/dominikg/tsconfck, MIT, Copyright
 * (c) 2021-present dominikg and tsconfck contributors) finds and reads it for
 * Vite 5, 6 and 7's esbuild plugin (`loadTsconfigJsonForFile`), over any
 * synchronous file system rather than node:fs: the closest `tsconfig.json`
 * up from the module (none for a module under node_modules), its text as
 * JSON with comments, trailing commas and a BOM allowed (tsconfck carries
 * strip-json-comments and strip-bom, MIT, Copyright (c) Sindre Sorhus), its
 * `extends` (a path, a package resolved as Node's require.resolve would, or
 * an array: TypeScript 5's later-wins order) merged in, `${configDir}`
 * replaced, and, where it has `references` and does not itself include the
 * module, the referenced config that does (a solution-style tsconfig, as
 * create-vite's templates write). Every path is absolute and POSIX.
 *
 * What the Vite dev server reads of the result is the compiler options
 * Vite's esbuild plugin reads (vite-esbuild-options.ts); `files` names every
 * config read, so an edit of any of them is known to matter.
 */
/** What tsconfck reads through. */
export interface TsconfckFs {
    /** Whether `path` (absolute) is a regular file. */
    isFile(path: string): boolean;
    /** `path`'s text; throws where it cannot be read. */
    readFileString(path: string): string;
}
/** A tsconfig.json's content, as tsconfck returns it. */
export interface Tsconfig {
    compilerOptions?: Record<string, unknown>;
    extends?: string | string[];
    files?: string[];
    include?: string[];
    exclude?: string[];
    references?: Array<{
        path: string;
    }>;
    [key: string]: unknown;
}
export interface TsconfckResult {
    /** The config the module compiles under (a referenced one, for a solution), or null where none was found. */
    tsconfigFile: string | null;
    tsconfig: Tsconfig;
    /** Every config file read to make it: the one found, what it extends, its references and what they extend. */
    files: string[];
}
/** A config that could not be read or resolved, as tsconfck's TSConfckParseError. */
export declare class TsconfckParseError extends Error {
    readonly code: string;
    readonly tsconfigFile: string;
    constructor(message: string, code: string, tsconfigFile: string);
}
/** The closest tsconfig.json up from `filename`, or null (always, under node_modules). */
export declare function findTsconfig(filename: string, fs: TsconfckFs): string | null;
/**
 * The tsconfig `filename` compiles under, as tsconfck's `parse(filename)`
 * gives it: `filename` itself where it is a .json file, else the closest
 * tsconfig.json; extended, tokens replaced, and resolved to the referenced
 * config that includes the file. Throws TsconfckParseError where a config
 * cannot be read or what it extends cannot be resolved.
 */
export declare function parseTsconfig(filename: string, fs: TsconfckFs): TsconfckResult;
/** A tsconfig's text as JSON, as tsconfck reads it (jsonc.ts); `{}` where nothing is left. */
export declare function toJson(tsconfigJson: string): string;
//# sourceMappingURL=tsconfck.d.ts.map