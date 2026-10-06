import { type SourceEdit } from './javascript-ast.js';
/**
 * One name an import binds: the module's namespace, or one of its exports
 * by name (`default` included, which `import d from` binds too). A string
 * name is any string, `"*"` included: only `namespace` is the namespace.
 *
 * A named binding's `references` are where the module uses it. Null where
 * the reader saw no scopes (the bounded bundle rewrite, which must not build
 * a multi-MiB bundle's tree): the binding is then read once, when its module
 * is required, as Node binds a builtin's or a CommonJS module's names.
 */
export type EsmImportBinding = {
    readonly kind: 'namespace';
    readonly local: string;
} | {
    readonly kind: 'named';
    readonly local: string;
    readonly imported: string;
    readonly references: readonly EsmReference[] | null;
};
/**
 * A use of an imported binding: a read, a call (`this` stays undefined), a
 * shorthand property (`{ n }`), or a write, which throws as the language's
 * assignment to an import does.
 */
export interface EsmReference {
    readonly start: number;
    readonly end: number;
    readonly use: 'read' | 'call' | 'shorthand' | 'write';
}
/**
 * A name a module exports: one of its own bindings, or, re-exported from
 * the record's source, one of that module's exports by name or its
 * namespace (`export * as ns from`).
 */
export type EsmExportName = {
    readonly kind: 'named';
    readonly exported: string;
    readonly local: string;
} | {
    readonly kind: 'namespace';
    readonly exported: string;
};
/**
 * An import or export declaration of a module, with the source range the
 * emitter removes or replaces: the whole declaration, except an exported
 * declaration (`export const`, `export function`, `export default class C`),
 * where it is the `export` keywords alone and the declaration stays.
 */
export type EsmRecord = {
    readonly kind: 'import';
    readonly start: number;
    readonly end: number;
    readonly source: string;
    readonly bindings: readonly EsmImportBinding[];
} | {
    readonly kind: 'export';
    readonly start: number;
    readonly end: number;
    readonly source: string | null;
    readonly names: readonly EsmExportName[];
} | {
    readonly kind: 'export-all';
    readonly start: number;
    readonly end: number;
    readonly source: string;
} | {
    readonly kind: 'export-default';
    readonly start: number;
    readonly end: number;
    /** The default expression's range in the source. */
    readonly expression: {
        readonly start: number;
        readonly end: number;
    };
};
export interface CommonJsEmitOptions {
    /** `async`: the module in an async IIFE (top-level await); `sync`: at the wrapper's top level. */
    readonly body: 'sync' | 'async';
    /** The CommonJS exports object, as an expression. Default `module.exports`. */
    readonly exportsObject?: string;
    /** The CommonJS require function, as an expression. Default `require`. */
    readonly requireFunction?: string;
    /** Further edits to the body, outside every record's range (import.meta rewrites). */
    readonly edits?: readonly SourceEdit[];
}
/** `esm` lowered to the CommonJS function body of an async module. */
export declare function lowerAsyncModule(esm: string): string;
/** The import and export declarations of ES module `source`, in source order. Throws on a syntax error. */
export declare function readEsmRecords(source: string): EsmRecord[];
/** The CommonJS for ES module `source`, whose import and export declarations are `records`. */
export declare function emitCommonJs(source: string, records: readonly EsmRecord[], options: CommonJsEmitOptions): string;
//# sourceMappingURL=async-module-lowering.d.ts.map