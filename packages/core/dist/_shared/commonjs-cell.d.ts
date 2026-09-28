/** Closes the block, the function and the parenthesized expression. */
export declare const COMMONJS_CELL_TAIL = "\n}});";
/** The Worker Loader module name for the cell at VFS key `key` (a path without its leading slash). */
export declare function commonJsCellModuleName(key: string): string;
/** The module name of a process's entry code, `filename` being the script's path or `[eval]`. */
export declare function commonJsEntryModuleName(filename: string): string;
/**
 * Whether the guest can read a cell's module text back from its bundle
 * filesystem (`/bundle/vfs/<path>`, workerd's node:fs view of the module map)
 * by the cell's own path. workerd's lookup percent-decodes the path it is
 * given and reads `\` as a separator, so a path carrying `%` or `\` names a
 * different file there; such a cell also travels as data.
 */
export declare function commonJsCellReadsBack(key: string): boolean;
export interface WrappedCommonJsCell {
    /** The module text. */
    text: string;
    /** Characters of wrapper before the cell. */
    head: number;
    /** The cell opened with a shebang, which the text carries as `//`. */
    hashbang: boolean;
}
/**
 * Wrap a CommonJS cell as a `{ cjs }` module whose export is Node's module
 * wrapper function. A leading shebang becomes a line comment of the same
 * length (Node strips it too; `#!` is not valid inside a function).
 */
export declare function wrapCommonJsCell(cell: string): WrappedCommonJsCell;
/**
 * Whether the source's directive prologue (ECMA-262 §11.2.1) holds a
 * "use strict" directive: its leading string-literal statements, one of which
 * is exactly `'use strict'` or `"use strict"`.
 */
export declare function opensWithUseStrict(source: string): boolean;
/**
 * One row of the table a launch's main module carries for its cells:
 * `[key, moduleName, head, hashbang, adopt]`. `adopt` is 1 when the process's
 * store takes the cell's file content from the module text (read back from
 * the bundle filesystem) rather than from a data cell: the store's one copy
 * of that file, and the map's only.
 */
export type CommonJsCellRow = [key: string, moduleName: string, head: number, hashbang: 0 | 1, adopt: 0 | 1];
/** Bytes of runtime code one launch records, and the supervisor keeps. */
export declare const RUNTIME_CODE_MAX_BYTES: number;
/** The constructors whose text a program can hand in at runtime. */
declare const RUNTIME_FUNCTION_HEADS: {
    readonly function: "function";
    readonly async: "async function";
    readonly generator: "function*";
    readonly asyncGenerator: "async function*";
};
export type RuntimeFunctionKind = keyof typeof RUNTIME_FUNCTION_HEADS;
/** Code a launch could not compile, as its ledger reports it. */
export type RuntimeCodeEntry = {
    kind: RuntimeFunctionKind;
    params: string[];
    body: string;
} | {
    kind: 'module';
    path: string;
    text: string;
};
/** The key of a piece of runtime code: SHA-256 of runtimeCodeKeySource, hex. */
export declare function runtimeCodeKey(entry: RuntimeCodeEntry): string;
/** The module name of the runtime code with key `key`. */
export declare function runtimeCodeModuleName(key: string): string;
/** A ledger entry as the supervisor receives it: shape-checked, or null. */
export declare function parseRuntimeCodeEntry(value: unknown): RuntimeCodeEntry | null;
/**
 * The `{ cjs }` module text for a Function-constructor call: it exports the
 * function V8 builds for `new <Kind>Function(...params, body)` — named
 * `anonymous`, its source `<head> anonymous(<params>\n) {\n<body>\n}`, the body
 * from line 3. A constructor's function closes over the global scope, where a
 * CommonJS module's body would see workerd's five CommonJS names
 * (src/workerd/api/commonjs.h CommonJsModuleContext: require, module,
 * exports, __filename, __dirname), so an enclosing function rebinds those five
 * to the global object's.
 */
export declare function runtimeFunctionModule(kind: RuntimeFunctionKind, params: readonly string[], body: string): string;
/** The main module's imports the runtime below reads through. */
export declare const COMMONJS_CELL_IMPORTS: string;
/**
 * The generated facet's side of the cells: resolve a VFS key to its module's
 * wrapper function, read a cell's text back for the process's store, and
 * answer runtime code from the launch's `gen/` modules or record it for the
 * next launch (`__nimbusRuntimeCode`, the API a module runner's seam calls).
 *
 * Expects COMMONJS_CELL_IMPORTS, a `__NIMBUS_CODE_CELLS` table of
 * CommonJsCellRow rows and a `__NIMBUS_RUNTIME_CODE` list of staged keys.
 */
export declare const COMMONJS_CELL_RUNTIME_SOURCE: string;
export {};
//# sourceMappingURL=commonjs-cell.d.ts.map