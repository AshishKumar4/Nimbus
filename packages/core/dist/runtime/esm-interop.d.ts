/**
 * esm-interop.ts — an ES module's import and export declarations, and how
 * the interpreter (interpreter/modules.ts) links them as CommonJS when it
 * evaluates an ES module: one a program produced after its launch began, or
 * a staged one the registry could not evaluate with Node's semantics
 * (node-shims' adoption). The registry evaluates every other ES module
 * itself (native-esm.ts). The linking:
 *
 *   - the export getters are installed first, on the CommonJS exports object
 *     (ESM_EXPORTS_HELPER: `__esModule`, not enumerable and replaced by a
 *     module's own export of that name, a `Module` tag, live enumerable
 *     getters in exported-name order), so a module in a cycle with this one
 *     finds them;
 *   - every requested module is then loaded in source order (ESM_LOAD_HELPER:
 *     the importer's require, resolving it as an import, with its `type`
 *     attribute), which gives its namespace as Node's loader makes it: an
 *     ES module's own, or a CommonJS module's, a builtin's or JSON's as
 *     Node's translators make it (node-shims); a default import reads its
 *     `default`, and a namespace import is it;
 *   - last, each `export *` copies its module's names (ESM_STAR_HELPER) but
 *     those two of them reach different bindings of (ESM_CONFLICTS_HELPER:
 *     the loader's answer), which Node's namespace leaves out.
 *
 * The helpers are source text a launch's runtime compiles for its
 * interpreter (ESM_MODULE_HELPERS, commonjs-cell.ts). They reach Object,
 * and Symbol.toStringTag (AsyncFunction.prototype's one own symbol),
 * through literals. The exports object is tagged `Module`, as Node's
 * namespace is, so a call on it reads `Module.f` in a stack.
 *
 * The interpreter runs this module after a program may have replaced
 * built-ins, so it names none (tests/unit/interpreter-primordials.mjs), and
 * it makes its lists with the caller's EsmLists.
 */
import type { ExportAllDeclaration, ExportNamedDeclaration, ImportDeclaration, ModuleDeclaration, Statement } from 'acorn';
/** The CommonJS exports object marked as an ES module's; answers the function that installs an export's getter. */
export declare const ESM_EXPORTS_HELPER: string;
/**
 * `export *`: each name of the module but `default`, those already exported
 * (enumerable: the `__esModule` marker is not, and a star replaces it as an
 * export would) and those `omitted` (ESM_CONFLICTS_HELPER's), read through.
 */
export declare const ESM_STAR_HELPER: string;
/** What a module's require is passed for the names its `export *`s reach two different bindings of. */
export declare const ESM_STAR_CONFLICTS = "nimbus:star-conflicts";
/** The names a module's `export *`s leave out, as Node's namespace omits them: its loader's answer, through its require. */
export declare const ESM_CONFLICTS_HELPER = "(require) => require(\"\", \"nimbus:star-conflicts\")";
/**
 * What a module's require is passed beside a static import's specifier: the
 * loader resolves it as Node's ESM loader does (node-shims' __requireFrom),
 * not as require() does. A require of a module takes its first argument
 * alone, as Node's does.
 */
export declare const ESM_STATIC_IMPORT = "nimbus:static-import";
/** A static import's module: the importer's require, told the request is an import, with its `type` attribute (or null). */
export declare const ESM_LOAD_HELPER = "(require, source, type) => require(source, \"nimbus:static-import\", type)";
/** The helpers as an object literal's source: what a launch compiles for its interpreter (interpreter/modules.ts ModuleHelpers). */
export declare const ESM_MODULE_HELPERS = "{ exports: (() => { const O = ({}).constructor; const tag = O.getOwnPropertySymbols(O.getPrototypeOf(async () => {}))[0]; return (exports) => { O.defineProperty(exports, \"__esModule\", { value: true, configurable: true }); O.defineProperty(exports, tag, { value: \"Module\" }); return (name, get) => O.defineProperty(exports, name, { enumerable: true, configurable: false, get }); }; })(), star: (exports, define, m, omitted) => { for (const k in m) { if (k === \"default\" || ({}).propertyIsEnumerable.call(exports, k)) continue; let left = false; for (let i = 0; omitted && i < omitted.length; i++) if (omitted[i] === k) left = true; if (!left) define(k, () => m[k]); } }, conflicts: (require) => require(\"\", \"nimbus:star-conflicts\"), load: (require, source, type) => require(source, \"nimbus:static-import\", type) }";
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
    readonly type: string | null;
    readonly bindings: readonly Binding[];
} | {
    readonly kind: 'export';
    readonly start: number;
    readonly end: number;
    readonly source: string | null;
    /** Its source's `type` attribute (importType); null with no source. */
    readonly type: string | null;
    readonly names: readonly EsmExportName[];
} | {
    readonly kind: 'export-all';
    readonly start: number;
    readonly end: number;
    readonly source: string;
    readonly type: string | null;
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
/**
 * The attribute a static import or re-export passes its loader: its `type`,
 * or null. V8 keeps only the keys its host supports, Node's being `type`
 * alone, so any other key is dropped, not refused (import()'s are refused).
 */
export declare function importType(node: ImportDeclaration | ExportNamedDeclaration | ExportAllDeclaration): string | null;
/** The record of a module's top-level statement, or null for one that declares no import or export. */
export declare function esmRecord(node: Statement | ModuleDeclaration, lists: EsmLists): EsmRecord | null;
/** A module the declarations request, required in source order. */
export interface EsmRequest<Binding extends EsmImportBinding = EsmImportBinding> {
    readonly source: string;
    /** Its `type` attribute (importType), which its loader checks against what it loads. */
    readonly type: string | null;
    /** Whether the module is read again (an import's binding, a re-export, a namespace, `export *`), not only run. */
    readonly kept: boolean;
    /**
     * The bindings of the import that requests it (none for a re-export's): a
     * named one reads `imported` of the module's namespace at each use; a
     * namespace one is among the link's namespaces.
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
/**
 * What Node's linker checks of a module, before any module of its graph
 * runs: each name an import or a re-export reads of a requested module is
 * one that module exports.
 */
export interface ModuleBindings {
    /** The names it exports itself: its own, by name from a requested module, `export * as`. `export *` adds its modules' (`stars`). */
    readonly exports: readonly string[];
    /** By request, in source order (a static specifier's place): the names it imports or re-exports from that module, `default` a default import's. */
    readonly imports: readonly (readonly string[])[];
    /** The requests whose names `export *` re-exports. */
    readonly stars: readonly number[];
    /** By request: its `type` attribute (importType), which the loader checks against what it loads. */
    readonly types: readonly (string | null)[];
    /**
     * Its names that are another module's (ResolveExport's indirect entries:
     * a re-export, or an export of an imported binding): the name, the
     * request, and the name it has there, null for that module's namespace.
     * Its other names are bindings of its own.
     */
    readonly reexports: readonly (readonly [exported: string, request: number, name: string | null])[];
    /**
     * Its names that are bindings of its own (ResolveExport's local entries):
     * the name and the binding's, `*default*` for an `export default` of an
     * expression. Two names of one binding resolve to one binding.
     */
    readonly locals: readonly (readonly [exported: string, local: string])[];
}
/** The bindings of a module linked as `link`. */
export declare function esmBindings(link: EsmLink, lists: EsmLists): ModuleBindings;
//# sourceMappingURL=esm-interop.d.ts.map