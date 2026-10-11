/**
 * esm-interop.ts — an ES module's import and export declarations, and how
 * they link as CommonJS: the one model both of a module's lowerings share.
 * async-module-lowering.ts writes it as a module cell's source, and the
 * interpreter (interpreter/modules.ts) binds it to a module's slots when a
 * program produces the module after its launch began, which the next launch
 * then compiles from that cell. So the two agree by construction:
 *
 *   - the export getters are installed first, on the CommonJS exports object
 *     (ESM_EXPORTS_HELPER: `__esModule`, a `Module` tag, live enumerable
 *     getters in exported-name order), so a module in a cycle with this one
 *     finds them;
 *   - every requested module is then required in source order, a default
 *     import's interop (ESM_INTEROP_HELPER) made as its module is required;
 *   - then each namespace (ESM_NAMESPACE_HELPER) an import or `export * as`
 *     names, once;
 *   - last, each `export *` copies its module's names (ESM_STAR_HELPER).
 *
 * The helpers are source text: a lowered cell carries them, and a launch's
 * runtime compiles the same text for its interpreter (ESM_MODULE_HELPERS,
 * commonjs-cell.ts), so what a launch runs before and after its code is
 * staged is the same code. Each is one line: the lowering puts them on the
 * module's first line, which keeps its lines where they were.
 * They reach Object, and Symbol.toStringTag (AsyncFunction.prototype's one
 * own symbol), through literals: in a lowered module without top-level
 * await they share the module's scope, where it may declare either name.
 * The exports object is tagged `Module`, as Node's namespace is, so a call
 * on it reads `Module.f` in a stack.
 *
 * The interpreter runs this module after a program may have replaced
 * built-ins, so it names none (tests/unit/interpreter-primordials.mjs), and
 * it makes its lists with the caller's EsmLists.
 */
import type { ModuleDeclaration, Statement } from 'acorn';
/** The CommonJS exports object marked as an ES module's; answers the function that installs an export's getter. */
export declare const ESM_EXPORTS_HELPER: string;
/** What a default import reads `default` of: the module when it is marked `__esModule`, else `{ default: module }`. */
export declare const ESM_INTEROP_HELPER = "(m) => m && m.__esModule ? m : { default: m }";
/**
 * A required module as a namespace, as Node and esbuild read a CommonJS
 * module: one marked `__esModule` as it is; any other with its exports as
 * `default`, its other own names read through.
 */
export declare const ESM_NAMESPACE_HELPER: string;
/** `export *`: each name of the module but `default` and those already exported, read through. */
export declare const ESM_STAR_HELPER = "(exports, define, m) => { for (const k in m) if (k !== \"default\" && !({}).hasOwnProperty.call(exports, k)) define(k, () => m[k]); }";
/** The four helpers as an object literal's source: what a launch compiles for its interpreter (interpreter/modules.ts ModuleHelpers). */
export declare const ESM_MODULE_HELPERS = "{ exports: (() => { const O = ({}).constructor; const tag = O.getOwnPropertySymbols(O.getPrototypeOf(async () => {}))[0]; return (exports) => { O.defineProperty(exports, \"__esModule\", { value: true }); O.defineProperty(exports, tag, { value: \"Module\" }); return (name, get) => O.defineProperty(exports, name, { enumerable: true, get }); }; })(), interop: (m) => m && m.__esModule ? m : { default: m }, namespace: (m) => { if (m && m.__esModule) return m; const O = ({}).constructor; const ns = O.create(m != null ? O.getPrototypeOf(m) : null); O.defineProperty(ns, \"default\", { value: m, enumerable: true }); if (m != null) for (const k of O.getOwnPropertyNames(m)) if (k !== \"default\") O.defineProperty(ns, k, { get: () => m[k], enumerable: O.getOwnPropertyDescriptor(m, k).enumerable }); return ns; }, star: (exports, define, m) => { for (const k in m) if (k !== \"default\" && !({}).hasOwnProperty.call(exports, k)) define(k, () => m[k]); } }";
/**
 * One name an import binds: the module's namespace, or one of its exports
 * by name (`default` included, which `import d from` binds too). A string
 * name is any string, `"*"` included: only `namespace` is the namespace.
 */
export type EsmImportBinding = {
    readonly kind: 'namespace';
    readonly local: string;
} | {
    readonly kind: 'named';
    readonly local: string;
    readonly imported: string;
};
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
 * lowering removes or replaces: the whole declaration, except an exported
 * declaration (`export const`, `export function`, `export default class C`),
 * where it is the `export` keywords alone and the declaration stays.
 */
export type EsmRecord<Binding extends EsmImportBinding = EsmImportBinding> = {
    readonly kind: 'import';
    readonly start: number;
    readonly end: number;
    readonly source: string;
    readonly bindings: readonly Binding[];
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
/** How the caller makes the lists this module returns: the interpreter's SafeLists, or ordinary arrays. */
export interface EsmLists {
    list<T>(): T[];
    push<T>(list: T[], value: T): void;
}
/** The record of a module's top-level statement, or null for one that declares no import or export. */
export declare function esmRecord(node: Statement | ModuleDeclaration, lists: EsmLists): EsmRecord | null;
/** A module the declarations request, required in source order. */
export interface EsmRequest<Binding extends EsmImportBinding = EsmImportBinding> {
    readonly source: string;
    /** Whether the module is read again (an import's binding, a re-export, a namespace, `export *`), not only run. */
    readonly kept: boolean;
    /** Whether a default import reads it, through its interop (ESM_INTEROP_HELPER), made as it is required. */
    readonly interop: boolean;
    /**
     * The bindings of the import that requests it (none for a re-export's): a
     * named one reads `imported` of the module (`default`, of its interop) at
     * each use; a namespace one is among the link's namespaces.
     */
    readonly bindings: readonly Binding[];
}
/** An export's getter, by what it reads. */
export type EsmExport = 
/** One of the module's bindings, an import's included. */
{
    readonly kind: 'binding';
    readonly exported: string;
    readonly local: string;
}
/** The value of `export default <expression>`. */
 | {
    readonly kind: 'default';
    readonly exported: string;
}
/** A requested module's export, read at each get. */
 | {
    readonly kind: 'reexport';
    readonly exported: string;
    readonly request: number;
    readonly name: string;
}
/** One of the link's namespaces. */
 | {
    readonly kind: 'namespace';
    readonly exported: string;
    readonly namespace: number;
};
/** How a module's declarations link, in the order the steps run (see the top of this file). */
export interface EsmLink<Binding extends EsmImportBinding = EsmImportBinding> {
    /** The export getters, by exported name. */
    readonly exports: readonly EsmExport[];
    readonly requests: readonly EsmRequest<Binding>[];
    /** A requested module's namespace: an import's (`import * as local`), or a re-export's (local null). */
    readonly namespaces: readonly {
        readonly request: number;
        readonly local: string | null;
    }[];
    /** The requests whose names `export *` copies. */
    readonly stars: readonly number[];
}
/** The link of a module whose declarations are `records`, in source order. */
export declare function esmLink<Binding extends EsmImportBinding>(records: ArrayLike<EsmRecord<Binding>>, lists: EsmLists): EsmLink<Binding>;
//# sourceMappingURL=esm-interop.d.ts.map