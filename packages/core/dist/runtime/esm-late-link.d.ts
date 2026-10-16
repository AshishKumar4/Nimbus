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
 * resolver, the files, the interpreter's reading of a module); this decides.
 * It is a runtime module of its own (RUNTIME_ESM_LATE_MODULE, with Node's
 * CommonJS lexer), so a launch whose imports never need it never compiles it.
 */
import type { ModuleRequests } from '../interpreter/index.js';
export { CyclicModuleRecord, OtherModuleRecord, evaluate, link } from './esm-graph.js';
/** What the loader resolves a static import to. */
export interface LateResolution {
    readonly url: string;
    readonly format: string;
    readonly path?: string;
    readonly builtin?: string;
}
export interface LateLinkHost {
    /** The staged row of `kind` at `key` (a builtin's name), or -1. */
    row(kind: 'module' | 'commonjs' | 'json' | 'builtin', key: string): number;
    /** A staged row's kind: 'module', or a facade's ('commonjs', 'json', 'builtin'). */
    rowKind(row: number): string;
    /** A staged row's key: a module's path, a builtin's name. */
    rowKey(row: number): string;
    /** The facades' export names, as staging wrote them (worker facets/esm-stage.ts EsmRowBindings): JSON, by row. */
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
    /** A builtin's export names: `default`, and its own (a function's too). */
    builtinNames(name: string): readonly string[];
    /** The file require() loads for `specifier` from the module at `parentPath`, or null. */
    cjsResolve(specifier: string, parentPath: string): string | null;
    /** Node's message for `name`, which the module `specifier` names does not export. */
    exportMessage(specifier: string, name: string, commonjs: boolean): string;
    /** `error` thrown as the loader's own (no arrow of the importer's). */
    decorate(error: Error): Error;
    /** A module's requests and bindings, as the interpreter reads it with the loader's parse goal (interpreter/index.ts moduleRequests). */
    requests(path: string, text: string, javaScript: boolean, goal: 'module' | 'commonjs' | 'detect'): ModuleRequests;
}
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
export declare function linkLateGraph(host: LateLinkHost, key: string, url: string): number[];
/**
 * Links staged row `id` (its module at `key`, `url`), which the interpreter
 * adopts because workerd could not link its graph (it reaches a module
 * staging handed on, or one the interpreter took), as a late graph is
 * linked: unless a link already checked it (the late graph that imports it).
 */
export declare function linkAdopted(host: LateLinkHost, id: number, key: string, url: string): void;
/** The names the `export *`s of the interpreted module at `url` reach two different bindings of, which its namespace omits. */
export declare function starConflicts(host: LateLinkHost, url: string): string[];
/**
 * The names of the namespace of the late module at `url`, as its link read
 * them: its own and its `export *`s', but those two of them reach different
 * bindings of; null where its link did not read them (one not linked, or
 * whose names its source does not tell). Known before its body runs, so a
 * namespace taken in a cycle has them all.
 */
export declare function namespaceNames(host: LateLinkHost, url: string): string[] | null;
//# sourceMappingURL=esm-late-link.d.ts.map