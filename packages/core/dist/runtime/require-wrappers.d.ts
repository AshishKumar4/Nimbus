/**
 * The bytes the kept answers may hold. They live in the session's isolate
 * (128 MB, about 10 MB of it spare once a launch's map is built:
 * platform/limits.ts ONE_SHOT_MODULE_MAP_MAX_BYTES), and a launch asks of
 * them once per module it walks that names `require` (about 3,000 for a nuxt
 * project, nearly all answering nothing, about 100 bytes each), so 2 MiB keeps
 * a few projects' worth while costing that headroom little.
 */
export declare const REQUIRE_WRAPPER_ANSWERS_MAX_BYTES: number;
/** The answers kept now: how many, and the bytes they hold (UTF-16 strings, and the estimated overhead). */
export declare function requireWrapperAnswersHeld(): {
    entries: number;
    bytes: number;
};
/** What `code`'s require wrappers load, each once. */
export declare function requireWrapperCalls(code: string): Promise<readonly string[]>;
/**
 * Whether `code` has an identifier token `require` or `createRequire` (its
 * escapes read; one in a string, a template, a regular expression or a
 * comment is none), as a module or as a script; true if it tokenizes as
 * neither, for the parse to settle.
 */
export declare function namesRequire(code: string): boolean;
//# sourceMappingURL=require-wrappers.d.ts.map