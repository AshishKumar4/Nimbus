/**
 * native-esm.ts — an ES module as a guest's module registry evaluates it:
 * its own text, scope, live bindings, cycles and top-level await, all the
 * engine's. Nimbus stages it; it never lowers it.
 *
 * The registry (workerd's new module registry over a Worker Loader map, or a
 * host's own loader off Cloudflare) joins a specifier to the importing
 * module's URL and nothing more: no package lookup, no conditions, no Node
 * builtins in a program's sense, and every module lives under the map's
 * root, so its own `import.meta` names the map, not the program's file. So
 * each module is staged before it runs, edited only where the registry reads
 * it differently from Node:
 *   - each static specifier names the map module of what Node's resolver
 *     names for it (a module, a CommonJS facade, a builtin facade);
 *   - `import.meta` and the `import` of `import(` are the module's own
 *     bindings of the same length, so no line or column moves;
 *   - a prologue call opens the first line (its `head`), and one line after
 *     the last binds those names from the module's meta instance
 *     (ESM_META_MODULE, `?<id>`), imports the module's own namespace, and
 *     registers it once the body completes.
 *
 * The meta instance is the module's gate (workerd): its body ends in a
 * top-level await, so the registry, which evaluates every module with the
 * request's I/O context suppressed (workerd io/worker-modules.h,
 * SuppressIoContextScope), runs no module body inside that evaluation; V8
 * runs it from the gate's fulfillment, a microtask, inside the request. One
 * instance per module, so a module first evaluated later (a chunk whose
 * dependencies are all loaded) waits for its own gate too. The prologue call
 * runs first in the body, where a gate cannot: every gate of a batch settles
 * before any body of it runs. It stops the body once an earlier body of the
 * same batch threw, as Node's evaluation stops at the first error, or once
 * the batch was cancelled for a require() of a module in it (node-shims).
 *
 * Every edit is recorded (ColumnMap): a stack frame's column moves back by
 * the ones that changed a line's length, and the module's text before it was
 * staged is read back through them all (commonjs-cell.ts
 * __nimbusModuleSourceText), for its source map's URL and for the
 * interpreter, which evaluates the module where the registry cannot
 * (node-shims' adoption).
 */
import { type ImportSites } from './dynamic-import-rewrite.js';
import type { ModuleScope } from './module-format.js';
import { type SourceEdit } from './javascript-ast.js';
/** The map module every staged module binds import.meta, import(), its check and its registration from. */
export declare const ESM_META_MODULE = "nimbus/meta.js";
/** The map module the runner fills with the functions ESM_META_MODULE's instances ask for. */
export declare const ESM_HOST_MODULE = "nimbus/esm-host.js";
/** Where a launch puts the facades an ES module imports a builtin or a CommonJS module through. */
export declare const ESM_FACADE_DIR = "nimbus/facade/";
/** A staged module's flag in its launch's table: its meta instance binds Bun's CommonJS names (bunScopeNames). */
export declare const ESM_BUN_SCOPE = 1;
/** A staged module's flag in its launch's table: it awaits at its top level (esm-require-hoist.ts hasTopLevelAwait). */
export declare const ESM_TOP_LEVEL_AWAIT = 2;
/**
 * A staged module's flag in its launch's table: a `.js` an ES module by its
 * syntax alone, under a package.json with no "type" (its row names that
 * package.json), which Node warns about as it loads it (MODULE_TYPELESS_PACKAGE_JSON).
 */
export declare const ESM_TYPELESS = 4;
/**
 * Where a module's edits change a line, by line: [line, source column,
 * generated length, source text], and 1 for a call (commonjs-cell.ts
 * __nimbusSourceColumn, __nimbusSourceLine).
 */
export type ColumnMap = Array<[number, number, number, string] | [number, number, number, string, 1]>;
/** The ColumnMap of `edits` to `source`, none of which adds or removes a line break. */
export declare function columnMap(source: string, edits: readonly SourceEdit[]): ColumnMap;
/** An ES module as staged: its map text, and how its frames and its file are read back from it. */
export interface StagedEsModule {
    readonly text: string;
    /** Characters of prologue before the module's first line. */
    readonly head: number;
    /** Characters after its last line. */
    readonly tail: number;
    /** It opened with a shebang, which the text carries as `//`. */
    readonly hashbang: boolean;
    readonly columns: ColumnMap;
}
/** Where a staged module sits and what it links to. */
export interface EsModuleLink {
    /** Its meta instance's query: the module's row in the launch's cell table. */
    readonly id: number;
    /** Its own map name, under the map's root. */
    readonly name: string;
    /** The map name each of `sites.statics`, in order, loads. */
    readonly targets: readonly string[];
    /** Bun's scope: the CommonJS names (`require`, `__filename`, `__dirname`) it reads but does not declare. */
    readonly commonJsNames?: readonly string[];
    /**
     * The map names its hoisted require()s load (esm-require-hoist.ts), in
     * order: imported after its own imports, so evaluated before its body.
     */
    readonly hoisted?: readonly string[];
}
/** The map's root as module URLs name it: workerd's, under which a Worker Loader map's modules live. */
export declare const MAP_ROOT = "file:///bundle/";
/**
 * The relative specifier that names map module `target` from map module
 * `from`. Every specifier a stage writes is relative, so the staged text
 * names the same modules under any root its host serves the map from.
 */
export declare function relativeSpecifier(from: string, target: string): string;
/**
 * The module the registry evaluates for ES module `text`, read as `sites`,
 * linked as `link` says. Lines and columns stay the file's but for the first
 * line's prologue (`head`) and specifiers whose length changed (`columns`).
 */
export declare function stageEsModule(text: string, sites: ImportSites, link: EsModuleLink): StagedEsModule;
/**
 * The CommonJS names an ES module in Bun's scope may read and does not
 * declare at its top level: the ones its meta instance binds for it. A name
 * the text only mentions (in a string, a comment) is bound unread, which is
 * harmless; one it declares is its own.
 */
export declare function bunScopeNames(code: string): string[];
/**
 * What staging reads of an ES module's text, once, where the module is read
 * (the transform host; its store keeps the reading with the module): its
 * import sites, its EsModuleFacts, and in Bun's `scope` the CommonJS names
 * its meta instance binds.
 */
export declare function readEsModule(code: string, scope: ModuleScope | undefined): ImportSites;
/**
 * The facade an ES module imports CommonJS module `id` through (Node's
 * createCJSModuleWrap): it loads the module as require() does, at its place
 * in the graph's evaluation; `default` is module.exports and each of `names`
 * (cjs-module-exports.ts) its own property's value then.
 */
export declare function commonJsFacadeModule(name: string, id: number, names: readonly string[]): string;
/**
 * The facade an ES module imports builtin `id` through (Node's
 * getESMFacade): `default` is the builtin itself, the object require()
 * gives, and each of `names` (node-builtin-exports.ts) its value, until
 * module.syncBuiltinESMExports() reads them again.
 */
export declare function builtinFacadeModule(name: string, id: number, names: readonly string[]): string;
/**
 * The module an ES module imports JSON file `id` through (Node's JSON
 * translator): `default` is the file's value, the object require() gives
 * for the same file, which its meta instance's `l` loads.
 */
export declare function jsonFacadeModule(name: string, id: number): string;
/**
 * ESM_META_MODULE: one instance per staged module (`?<id>`). Its evaluation
 * hands the module its bindings from the runner (ESM_HOST_MODULE's `host`),
 * which tags the module with the batch evaluating it. On workerd it is the
 * module's gate (`await`, see the header); a host with no request context to
 * reach has none, so its graphs stay synchronous for require().
 */
export declare function metaModuleSource(gate: boolean): string;
/** ESM_HOST_MODULE: what the runner fills before the program's first import. */
export declare const ESM_HOST_SOURCE = "export const host = Object.create(null);\n";
//# sourceMappingURL=native-esm.d.ts.map