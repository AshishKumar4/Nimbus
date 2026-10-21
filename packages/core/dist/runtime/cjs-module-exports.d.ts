/**
 * cjs-module-exports.ts — the names an ES module may import from a CommonJS
 * module, as Node 22.23.4 names them before the module runs
 * (lib/internal/modules/esm/translators.js cjsPreparseModuleExports): what
 * cjs-module-lexer, at Node's own version, finds in its source, `default`
 * first, and the names of every module it re-exports (`module.exports =
 * require('x')`, `__exportStar`, Babel's loop) that require() resolves to a
 * `.js`, a `.cjs` or a file of an extension require has no loader for,
 * walked the same way. A module whose source does not lex has no names but
 * `default`; a re-export that does not resolve, or whose resolution require()
 * refuses (a path a package's "exports" hides), adds none. A cycle stops at a
 * module already being read: its names are the ones found so far, as Node's,
 * which records them first.
 *
 * One walk over a host that answers in place (a process's filesystem) or
 * with promises (the session's).
 */
type MaybePromise<T> = T | Promise<T>;
/** What the walk asks of the filesystem and the require resolver. */
export interface CjsModuleExportsHost<A extends 'sync' | 'async' = 'sync'> {
    /** A module's source, or null when it cannot be read. */
    source(path: string): A extends 'sync' ? string | null : MaybePromise<string | null>;
    /** The absolute path `require(specifier)` from the module at `fromPath` loads, or null; a refusal may throw. */
    resolve(specifier: string, fromPath: string): A extends 'sync' ? string | null : MaybePromise<string | null>;
}
/**
 * The names an ES module may import from the CommonJS module at `path`
 * (`source`, when the caller holds it), `default` first. `cache` keeps each
 * module's names across calls, and is what ends a cycle.
 */
export declare function cjsModuleExportNames(path: string, host: CjsModuleExportsHost, cache?: Map<string, Set<string>>, source?: string): Set<string>;
/** cjsModuleExportNames over a host whose answers may be promises (the session's filesystem). */
export declare function cjsModuleExportNamesAsync(path: string, host: CjsModuleExportsHost<'async'>, cache?: Map<string, Set<string>>, source?: string): Promise<Set<string>>;
export {};
//# sourceMappingURL=cjs-module-exports.d.ts.map