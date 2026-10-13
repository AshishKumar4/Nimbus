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
/**
 * A staged module row's bindings (worker facets/esm-stage.ts EsmRowBindings,
 * a module's): its own names, the rows its `export *`s reach, by static
 * import that reads names the row it loads, its specifier as written and the
 * names, and its names that are another row's (the name, the row, the name
 * there; null for its namespace).
 */
export type ModuleRowFacts = readonly [
    exports: readonly string[],
    stars: readonly number[],
    imports: readonly (readonly [row: number, specifier: string, ...names: string[]])[],
    reexports?: readonly (readonly [exported: string, row: number, name: string | null])[]
];
export interface LateLinkHost {
    /** The staged row of `kind` at `key` (a builtin's name), or -1. */
    row(kind: 'module' | 'commonjs' | 'json' | 'builtin', key: string): number;
    /** A staged row's kind: 'module', or a facade's ('commonjs', 'json', 'builtin'). */
    rowKind(row: number): string;
    /** The launch's row bindings, as staging wrote them (worker facets/esm-stage.ts EsmRowBindings): JSON, by row. */
    rowBindings(): string;
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
    /** A builtin's exports. */
    builtin(name: string): object | null | undefined;
    /** The file require() loads for `specifier` from the module at `parentPath`, or null. */
    cjsResolve(specifier: string, parentPath: string): string | null;
    /** Node's message for `name`, which the module `specifier` names does not export. */
    exportMessage(specifier: string, name: string, commonjs: boolean): string;
    /** `error` thrown as the loader's own (no arrow of the importer's). */
    decorate(error: Error): Error;
}
/** How the host reads a module's requests and bindings (interpreter/index.ts moduleRequests). */
export type ReadRequests = (path: string, text: string, javaScript: boolean, goal: 'module' | 'commonjs' | 'detect') => ModuleRequests;
/**
 * The names Node's loader finds in the CommonJS module at `key` before it
 * runs: a staged facade's, else Node's lexer's over its source and the
 * modules it re-exports (cjs-module-exports.ts), `default` first.
 */
export declare function commonJsNames(host: LateLinkHost, key: string): readonly string[];
/**
 * Links the late graph of the module at `key` (`url`): throws the refusal
 * of a static import anywhere in it that does not resolve or load, or of a
 * name a module of it imports that its module does not export. Answers the
 * staged modules it imports, in import order, for the caller to evaluate
 * before the interpreter does the rest.
 */
export declare function linkLateGraph(host: LateLinkHost, read: ReadRequests, key: string, url: string): number[];
/** The names the `export *`s of the interpreted module at `url` reach two different bindings of, which its namespace omits. */
export declare function starConflicts(host: LateLinkHost, url: string): string[];
//# sourceMappingURL=esm-late-link.d.ts.map