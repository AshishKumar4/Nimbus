/**
 * runtime/esm-late-link.ts — Node's link of a late ES module graph: one the
 * interpreter evaluates (a module a program wrote after its launch began, a
 * query's or a fragment's instance, a staged module the registry hands on),
 * with the staged modules it reaches. Node links a whole graph before any of
 * it runs: every static import resolves and loads, and every name a module
 * imports is one its module exports (ECMA-262 ResolveExport), or the import
 * rejects and no body runs.
 *
 * node-shims gives the facts (LateLinkHost: the registry's rows, the
 * resolver, the files); this decides. The interpreter's runtime module
 * carries it, which every late graph loads anyway, so a launch that never
 * links one never compiles it.
 */
import type { ModuleRequests } from '../interpreter/index.js';
/** What the loader resolves a static import to. */
export interface LateResolution {
    readonly url: string;
    readonly format: string;
    readonly path?: string;
    readonly builtin?: string;
}
/** A staged module row's bindings (worker facets/esm-stage.ts EsmRowBindings, a module's). */
export interface ModuleRowFacts {
    readonly exports: readonly string[];
    readonly stars: readonly number[];
    /** By static import that reads names: the row it loads, its specifier as written, the names. */
    readonly imports: readonly (readonly [row: number, specifier: string, ...names: string[]])[];
    /** Its names that are another row's: the name, the row, the name there (null: its namespace). */
    readonly reexports: readonly (readonly [exported: string, row: number, name: string | null])[];
}
export interface LateLinkHost {
    /** The staged row of `kind` at `key` (a builtin's name), or -1. */
    row(kind: 'module' | 'commonjs' | 'json' | 'builtin', key: string): number;
    /** A staged row's kind: 'module', or a facade's ('commonjs', 'json', 'builtin'). */
    rowKind(row: number): string;
    /** A staged module row's bindings, or null where unknown. */
    moduleFacts(row: number): ModuleRowFacts | null;
    /** A facade row's export names, or null where unknown. */
    rowNames(row: number): readonly string[] | null;
    /** A staged module row's static targets: a row, or -2 - i for the staging refused as missing(i). */
    rowTargets(row: number): readonly number[];
    /** Whether a staged row has run, or the interpreter took it over. */
    rowSettled(row: number): boolean;
    /** The staging refused as -2 - i: a query's or a fragment's instance handed on (its URL), or Node's refusal. */
    missing(i: number): {
        readonly handedOn: string;
    } | {
        readonly refusal: Error;
    } | null;
    /** The source of the module at `key`: staged row `row`'s, else (-1) its file's; null where none. */
    source(key: string, row: number): string | null;
    /** The format the file at `key` has by its extension or its package, else undefined (its syntax decides). */
    fileFormat(key: string): 'module' | 'commonjs' | undefined;
    /** Loads the module at `key`, which its parser could not read, as the interpreter does: for the error it throws. */
    loadUnread(key: string, text: string, format: 'module' | 'commonjs' | undefined): void;
    /**
     * `specifier` from `parentUrl`, resolved as an import and loadable, and,
     * where `type` is not undefined, checked against its type attribute;
     * else Node's error, as the loader's own (no arrow of the importer's).
     */
    resolve(specifier: string, parentUrl: string, type: string | null | undefined): LateResolution;
    /** A builtin's export names: `default`, and its own. */
    builtinNames(builtin: string): readonly string[];
    /** The CommonJS module at `key`'s export names, as Node's lexer finds them. */
    commonJsNames(key: string): readonly string[];
    /** Node's message for `name`, which the module `specifier` names does not export. */
    exportMessage(specifier: string, name: string, commonjs: boolean): string;
    /** `error` thrown as the loader's own (no arrow of the importer's). */
    decorate(error: Error): Error;
}
/** How the host reads a module's requests and bindings (interpreter/index.ts moduleRequests). */
export type ReadRequests = (path: string, text: string, javaScript: boolean, goal: 'module' | 'commonjs' | 'detect') => ModuleRequests;
/**
 * Links the late graph of the module at `key` (`url`): throws the refusal
 * of a static import anywhere in it that does not resolve or load, or of a
 * name a module of it imports that its module does not export. Answers the
 * staged modules it imports, in import order, for the caller to evaluate
 * before the interpreter does the rest.
 */
export declare function linkLateGraph(host: LateLinkHost, read: ReadRequests, key: string, url: string): number[];
/** The names the `export *`s of the interpreted module at `url` (staged row `row`, or -1) reach two different bindings of. */
export declare function starConflicts(host: LateLinkHost, url: string, row: number): string[];
//# sourceMappingURL=esm-late-link.d.ts.map