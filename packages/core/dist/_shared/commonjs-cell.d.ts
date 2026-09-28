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
/** The main module's imports the runtime below reads through. */
export declare const COMMONJS_CELL_IMPORTS: string;
/**
 * The generated facet's side of the cells: resolve a VFS key to its module's
 * wrapper function, and read a cell's text back for the process's store.
 *
 * Expects COMMONJS_CELL_IMPORTS and a `__NIMBUS_CODE_CELLS` table of
 * CommonJsCellRow rows.
 */
export declare const COMMONJS_CELL_RUNTIME_SOURCE: string;
//# sourceMappingURL=commonjs-cell.d.ts.map