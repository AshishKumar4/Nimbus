import { type RuntimeFunctionKind } from './runtime-function-source.js';
export { runtimeFunctionSyntaxError, type RuntimeFunctionKind } from './runtime-function-source.js';
/** The Worker Loader module name for the cell at VFS key `key` (a path without its leading slash). */
export declare function commonJsCellModuleName(key: string): string;
/** The module name of a process's entry code, `filename` being the script's path or `[eval]`. */
export declare function commonJsEntryModuleName(filename: string): string;
/**
 * Whether the guest can read a cell's module text back from its bundle
 * filesystem (workerd's node:fs view of the module map) under its module
 * name. workerd's lookup percent-decodes the path it is given and encodes it
 * again with the path set, which gives back every name moduleNameUnder
 * writes except an escaped `%` or `\`: a path carrying either names a
 * different file there, so its cell also travels as data.
 */
export declare function commonJsCellReadsBack(key: string): boolean;
/** How a cell is wrapped (THE WRAPPER): as Node's function body, or in a block. */
export type CommonJsCellScope = 'function' | 'block';
export interface WrappedCommonJsCell {
    /** The module text. */
    text: string;
    /** Characters of wrapper before the cell. */
    head: number;
    /** Characters of wrapper after the cell. */
    tail: number;
    /** The cell opened with a shebang, which the text carries as `//`. */
    hashbang: boolean;
}
/**
 * Wrap a CommonJS cell as a `{ cjs }` module whose export is Node's module
 * wrapper function, in the given scope (THE WRAPPER). A leading shebang
 * becomes a line comment of the same length (Node strips it too; `#!` is not
 * valid inside a function).
 */
export declare function wrapCommonJsCell(cell: string, scope?: CommonJsCellScope): WrappedCommonJsCell;
/**
 * Whether a script declares one of the wrapper's five names lexically at its
 * top level (`const`, `let` or `class`) — the one thing that needs the block
 * scope — for code whose provenance is unknown: an entry script as the
 * runtime prepared it, or runtime code. Parsed, not matched: a declaration
 * inside a string or template is not one. Parsed as a script, and failing
 * that as a module (a lowered module may still read `import.meta`); a source
 * that parses as neither gets `false` (its SyntaxError surfaces under either
 * scope), and one too large to parse cheaply gets `true`, the scope every
 * lowered module needs.
 */
export declare function declaresWrapperBinding(source: string): boolean;
/**
 * Whether the source's directive prologue (ECMA-262 §11.2.1) holds a
 * "use strict" directive: its leading string-literal statements, one of which
 * is exactly `'use strict'` or `"use strict"`.
 */
export declare function opensWithUseStrict(source: string): boolean;
/**
 * One row of the table a launch's main module carries for its cells:
 * `[key, moduleName, head, tail, hashbang, adopt]`. `adopt` is 1 when the
 * process's store takes the cell's file content from the module text (read
 * back from the bundle filesystem) rather than from a data cell: the store's
 * one copy of that file, and the map's only.
 */
export type CommonJsCellRow = [key: string, moduleName: string, head: number, tail: number, hashbang: 0 | 1, adopt: 0 | 1];
/** Bytes of runtime code one launch records, and the supervisor keeps. */
export declare const RUNTIME_CODE_MAX_BYTES: number;
/** Pieces of runtime code one launch records, and the supervisor keeps. */
export declare const RUNTIME_CODE_MAX_ENTRIES = 1024;
/**
 * What each piece is charged beyond its text, against RUNTIME_CODE_MAX_BYTES:
 * its key, its bookkeeping, and the module it becomes. Without it a flood of
 * tiny pieces is nearly free by text and not at all by heap.
 */
export declare const RUNTIME_CODE_ENTRY_OVERHEAD = 512;
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
/**
 * What of a file's path decides the module its text becomes: its directory
 * (the parent its relative imports and `import.meta.resolve` resolve
 * against) and its extension (how it is lowered: TypeScript, JSX, ESM or
 * CommonJS). Its name does not, so a file written under a fresh name each run
 * — Vite's `vite.config.ts.timestamp-<now>.mjs` — is the same module each time.
 * Self-contained: the guest embeds its source to compute the same key.
 */
export declare function runtimeModuleScope(path: string): [dir: string, ext: string];
/** The key of a piece of runtime code: SHA-256 of runtimeCodeKeySource, hex. */
export declare function runtimeCodeKey(entry: RuntimeCodeEntry): string;
/**
 * What a piece of runtime code is charged against RUNTIME_CODE_MAX_BYTES:
 * everything it holds. A module keeps its path beside its text, and a data:
 * URL's path is the whole module again, so it is charged for both. The guest
 * ledger charges the same (__nimbusRuntimeCodeCompile).
 */
export declare function runtimeCodeCharge(entry: RuntimeCodeEntry): number;
/** The module names, in every node launch's map, of the interpreter and the host module it runs on. */
export declare const RUNTIME_INTERPRETER_MODULE = "nimbus/interpreter.js";
export declare const RUNTIME_INTERPRETER_OPS_MODULE = "nimbus/interpreter-ops.js";
/** The module name of the runtime code with key `key`. */
export declare function runtimeCodeModuleName(key: string): string;
/** A ledger entry as the supervisor receives it: shape-checked, or null. */
export declare function parseRuntimeCodeEntry(value: unknown): RuntimeCodeEntry | null;
/**
 * The `{ cjs }` module text for a Function-constructor call: it exports the
 * function V8 builds for `new <Kind>Function(...params, body)` — named
 * `anonymous`, its source `<head> anonymous(<params>\n) {\n<body>\n}`, the body
 * from line 3 — or, for arguments the constructor refuses
 * (runtimeFunctionSyntaxError), throws the SyntaxError it would. A
 * constructor's function closes over the global scope, where a CommonJS
 * module's body would see workerd's five CommonJS names
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
 * answer runtime code from the launch's `gen/` modules, or else record it for
 * the next launch and interpret it (`__nimbusRuntimeCode`, which the shims'
 * Function constructors, `vm.compileFunction`, `vm.runInThisContext`,
 * `Module.prototype._compile` and the loader of a file outside the map call).
 *
 * Expects COMMONJS_CELL_IMPORTS, a `__NIMBUS_CODE_CELLS` table of
 * CommonJsCellRow rows and a `__NIMBUS_RUNTIME_CODE` list of staged keys.
 */
export declare const COMMONJS_CELL_RUNTIME_SOURCE: string;
//# sourceMappingURL=commonjs-cell.d.ts.map