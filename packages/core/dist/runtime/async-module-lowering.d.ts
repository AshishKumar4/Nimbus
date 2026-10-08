import { type SourceEdit } from './javascript-ast.js';
/**
 * One name an import binds: the module's namespace, or one of its exports
 * by name (`default` included, which `import d from` binds too). A string
 * name is any string, `"*"` included: only `namespace` is the namespace.
 *
 * A named binding's `references` are where the module uses it.
 */
export type EsmImportBinding = {
    readonly kind: 'namespace';
    readonly local: string;
} | {
    readonly kind: 'named';
    readonly local: string;
    readonly imported: string;
    readonly references: readonly EsmReference[];
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
/**
 * Names for code generated around `source`: a prefix its text does not hold
 * anywhere, then a number, so no binding of the source is one of them.
 */
export declare function generatedNames(source: string): () => string;
export interface CommonJsEmitOptions {
    /** `async`: the module in an async IIFE (top-level await); `sync`: at the wrapper's top level. */
    readonly body: 'sync' | 'async';
    /**
     * Where the emitter's own names come from: generatedNames over the source,
     * by default. A caller that generates names of its own around the module
     * (a wrapper's parameters, rewritten expressions) passes the allocator it
     * drew them from, generatedNames over its original source, so the two never
     * meet.
     */
    readonly names?: () => string;
    /** The CommonJS exports object, as an expression. Default `module.exports`. */
    readonly exportsObject?: string;
    /** The CommonJS require function, as an expression. Default `require`. */
    readonly requireFunction?: string;
    /** Further edits to the body, outside every record's range (import.meta rewrites). */
    readonly edits?: readonly SourceEdit[];
}
/** `esm` lowered to the CommonJS function body of an async module. */
export declare function lowerAsyncModule(esm: string): string;
/**
 * The import and export declarations of ES module `source`, in source order,
 * each named import binding with where the module uses it (EsmReference).
 * Throws on a syntax error.
 *
 * A use is an identifier no scope inside the module binds again: not a
 * member's, a key's or a label's name, or a declaration's own (an import
 * name cannot be redeclared at the top level). Each function is analyzed as
 * the parse finishes it, its uses of the names imported so far kept (those
 * its own scopes leave free) and its body dropped; a top-level statement's
 * uses are resolved the same way, through its functions' free uses. Imports
 * come first in nearly every module, so one parse does; a module importing
 * a name after code that may use it is parsed again, every name known.
 */
export declare function readEsmRecords(source: string): EsmRecord[];
/**
 * readEsmRecords, and where the module uses a name the CommonJS wrapper
 * binds (`require`, `module`, `exports`, `__filename`, `__dirname`) that
 * neither its top level nor any scope around the use declares: no binding
 * at all in an ES module's scope, which a lowering to CommonJS must keep so
 * (module-format.ts ES_MODULE_UNBOUND_NAMES).
 */
export declare function readEsmModule(source: string): {
    records: EsmRecord[];
    wrapperUses: ReadonlyMap<string, readonly EsmReference[]>;
};
/** The CommonJS for ES module `source`, whose import and export declarations are `records`. */
export declare function emitCommonJs(source: string, records: readonly EsmRecord[], options: CommonJsEmitOptions): string;
//# sourceMappingURL=async-module-lowering.d.ts.map