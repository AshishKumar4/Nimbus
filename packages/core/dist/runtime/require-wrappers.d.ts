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