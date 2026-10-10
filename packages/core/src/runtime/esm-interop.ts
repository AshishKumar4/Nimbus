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
import type { Identifier, Literal, ModuleDeclaration, Statement } from 'acorn';
import { forEachBindingIdentifier } from './binding-pattern.js';

/** The CommonJS exports object marked as an ES module's; answers the function that installs an export's getter. */
export const ESM_EXPORTS_HELPER = '(() => { const O = ({}).constructor; const tag = O.getOwnPropertySymbols(O.getPrototypeOf(async () => {}))[0]; '
  + 'return (exports) => { O.defineProperty(exports, "__esModule", { value: true }); O.defineProperty(exports, tag, { value: "Module" }); '
  + 'return (name, get) => O.defineProperty(exports, name, { enumerable: true, get }); }; })()';

/** What a default import reads `default` of: the module when it is marked `__esModule`, else `{ default: module }`. */
export const ESM_INTEROP_HELPER = '(m) => m && m.__esModule ? m : { default: m }';

/**
 * A required module as a namespace, as Node and esbuild read a CommonJS
 * module: one marked `__esModule` as it is; any other with its exports as
 * `default`, its other own names read through.
 */
export const ESM_NAMESPACE_HELPER = '(m) => { if (m && m.__esModule) return m; const O = ({}).constructor; '
  + 'const ns = O.create(m != null ? O.getPrototypeOf(m) : null); O.defineProperty(ns, "default", { value: m, enumerable: true }); '
  + 'if (m != null) for (const k of O.getOwnPropertyNames(m)) if (k !== "default") '
  + 'O.defineProperty(ns, k, { get: () => m[k], enumerable: O.getOwnPropertyDescriptor(m, k).enumerable }); return ns; }';

/** `export *`: each name of the module but `default` and those already exported, read through. */
export const ESM_STAR_HELPER = '(exports, define, m) => { for (const k in m) if (k !== "default" && !({}).hasOwnProperty.call(exports, k)) define(k, () => m[k]); }';

/** The four helpers as an object literal's source: what a launch compiles for its interpreter (interpreter/modules.ts ModuleHelpers). */
export const ESM_MODULE_HELPERS = `{ exports: ${ESM_EXPORTS_HELPER}, interop: ${ESM_INTEROP_HELPER}, namespace: ${ESM_NAMESPACE_HELPER}, star: ${ESM_STAR_HELPER} }`;

/**
 * One name an import binds: the module's namespace, or one of its exports
 * by name (`default` included, which `import d from` binds too). A string
 * name is any string, `"*"` included: only `namespace` is the namespace.
 */
export type EsmImportBinding =
  | { readonly kind: 'namespace'; readonly local: string }
  | { readonly kind: 'named'; readonly local: string; readonly imported: string };

/**
 * A name a module exports: one of its own bindings, or, re-exported from
 * the record's source, one of that module's exports by name or its
 * namespace (`export * as ns from`).
 */
export type EsmExportName =
  | { readonly kind: 'named'; readonly exported: string; readonly local: string }
  | { readonly kind: 'namespace'; readonly exported: string };

/**
 * An import or export declaration of a module, with the source range the
 * lowering removes or replaces: the whole declaration, except an exported
 * declaration (`export const`, `export function`, `export default class C`),
 * where it is the `export` keywords alone and the declaration stays.
 */
export type EsmRecord<Binding extends EsmImportBinding = EsmImportBinding> =
  | { readonly kind: 'import'; readonly start: number; readonly end: number; readonly source: string; readonly bindings: readonly Binding[] }
  | { readonly kind: 'export'; readonly start: number; readonly end: number; readonly source: string | null; readonly names: readonly EsmExportName[] }
  | { readonly kind: 'export-all'; readonly start: number; readonly end: number; readonly source: string }
  | {
    readonly kind: 'export-default';
    readonly start: number;
    readonly end: number;
    /** The default expression's range in the source. */
    readonly expression: { readonly start: number; readonly end: number };
  };

/** How the caller makes the lists this module returns: the interpreter's SafeLists, or ordinary arrays. */
export interface EsmLists {
  list<T>(): T[];
  push<T>(list: T[], value: T): void;
}

/** A ModuleExportName: an identifier, or a string such as `export { a as "b-c" }`. */
function exportName(node: Identifier | Literal): string {
  return node.type === 'Identifier' ? node.name : `${node.value}`;
}

/** The record of a module's top-level statement, or null for one that declares no import or export. */
export function esmRecord(node: Statement | ModuleDeclaration, lists: EsmLists): EsmRecord | null {
  switch (node.type) {
    case 'ImportDeclaration': {
      const bindings = lists.list<EsmImportBinding>();
      for (let i = 0; i < node.specifiers.length; i++) {
        const specifier = node.specifiers[i];
        lists.push(bindings, specifier.type === 'ImportNamespaceSpecifier'
          ? { kind: 'namespace', local: specifier.local.name }
          : {
            kind: 'named',
            local: specifier.local.name,
            imported: specifier.type === 'ImportDefaultSpecifier' ? 'default' : exportName(specifier.imported),
          });
      }
      return { kind: 'import', start: node.start, end: node.end, source: `${node.source.value}`, bindings };
    }
    case 'ExportNamedDeclaration': {
      const names = lists.list<EsmExportName>();
      const declaration = node.declaration;
      if (declaration) {
        if (declaration.type === 'VariableDeclaration') {
          for (let i = 0; i < declaration.declarations.length; i++) {
            forEachBindingIdentifier(declaration.declarations[i].id, (id) => lists.push(names, { kind: 'named', exported: id.name, local: id.name }));
          }
        } else {
          lists.push(names, { kind: 'named', exported: declaration.id.name, local: declaration.id.name });
        }
        return { kind: 'export', start: node.start, end: declaration.start, source: null, names };
      }
      for (let i = 0; i < node.specifiers.length; i++) {
        const specifier = node.specifiers[i];
        lists.push(names, { kind: 'named', exported: exportName(specifier.exported), local: exportName(specifier.local) });
      }
      return { kind: 'export', start: node.start, end: node.end, source: node.source ? `${node.source.value}` : null, names };
    }
    case 'ExportDefaultDeclaration': {
      const declaration = node.declaration;
      if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
        const names = lists.list<EsmExportName>();
        lists.push(names, { kind: 'named', exported: 'default', local: declaration.id.name });
        return { kind: 'export', start: node.start, end: declaration.start, source: null, names };
      }
      return { kind: 'export-default', start: node.start, end: node.end, expression: { start: declaration.start, end: declaration.end } };
    }
    case 'ExportAllDeclaration': {
      if (node.exported) {
        const names = lists.list<EsmExportName>();
        lists.push(names, { kind: 'namespace', exported: exportName(node.exported) });
        return { kind: 'export', start: node.start, end: node.end, source: `${node.source.value}`, names };
      }
      return { kind: 'export-all', start: node.start, end: node.end, source: `${node.source.value}` };
    }
    default:
      return null;
  }
}

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
  | { readonly kind: 'binding'; readonly exported: string; readonly local: string }
  /** The value of `export default <expression>`. */
  | { readonly kind: 'default'; readonly exported: string }
  /** A requested module's export, read at each get. */
  | { readonly kind: 'reexport'; readonly exported: string; readonly request: number; readonly name: string }
  /** One of the link's namespaces. */
  | { readonly kind: 'namespace'; readonly exported: string; readonly namespace: number };

/** How a module's declarations link, in the order the steps run (see the top of this file). */
export interface EsmLink<Binding extends EsmImportBinding = EsmImportBinding> {
  /** The export getters, by exported name. */
  readonly exports: readonly EsmExport[];
  readonly requests: readonly EsmRequest<Binding>[];
  /** A requested module's namespace: an import's (`import * as local`), or a re-export's (local null). */
  readonly namespaces: readonly { readonly request: number; readonly local: string | null }[];
  /** The requests whose names `export *` copies. */
  readonly stars: readonly number[];
}

/** The link of a module whose declarations are `records`, in source order. */
export function esmLink<Binding extends EsmImportBinding>(records: ArrayLike<EsmRecord<Binding>>, lists: EsmLists): EsmLink<Binding> {
  const exports = lists.list<EsmExport>();
  const requests = lists.list<EsmRequest<Binding>>();
  const namespaces = lists.list<{ readonly request: number; readonly local: string | null }>();
  const stars = lists.list<number>();
  const none = lists.list<Binding>();
  const request = (source: string, kept: boolean, interop: boolean, bindings: readonly Binding[]): number => {
    lists.push(requests, { source, kept, interop, bindings });
    return requests.length - 1;
  };
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    switch (record.kind) {
      case 'import': {
        let interop = false;
        for (let j = 0; j < record.bindings.length; j++) {
          const binding = record.bindings[j];
          if (binding.kind === 'named' && binding.imported === 'default') interop = true;
        }
        const at = request(record.source, record.bindings.length > 0, interop, record.bindings);
        for (let j = 0; j < record.bindings.length; j++) {
          const binding = record.bindings[j];
          if (binding.kind === 'namespace') lists.push(namespaces, { request: at, local: binding.local });
        }
        break;
      }
      case 'export': {
        if (record.source === null) {
          // A module's own export names a binding of its own; nothing else parses.
          for (let j = 0; j < record.names.length; j++) {
            const name = record.names[j];
            if (name.kind === 'named') lists.push(exports, { kind: 'binding', exported: name.exported, local: name.local });
          }
          break;
        }
        const at = request(record.source, true, false, none);
        for (let j = 0; j < record.names.length; j++) {
          const name = record.names[j];
          if (name.kind === 'named') {
            lists.push(exports, { kind: 'reexport', exported: name.exported, request: at, name: name.local });
          } else {
            lists.push(namespaces, { request: at, local: null });
            lists.push(exports, { kind: 'namespace', exported: name.exported, namespace: namespaces.length - 1 });
          }
        }
        break;
      }
      case 'export-default':
        lists.push(exports, { kind: 'default', exported: 'default' });
        break;
      case 'export-all':
        lists.push(stars, request(record.source, true, false, none));
        break;
    }
  }
  return { exports: byExportedName(exports, lists), requests, namespaces, stars };
}

/** `entries` sorted by exported name, stably: a merge sort, which calls nothing of the realm's. */
function byExportedName<T extends { readonly exported: string }>(entries: T[], lists: EsmLists): T[] {
  const n = entries.length;
  let sorted = true;
  for (let i = 1; i < n && sorted; i++) sorted = !(entries[i].exported < entries[i - 1].exported);
  if (sorted) return entries;
  let from = entries;
  let to = lists.list<T>();
  for (let i = 0; i < n; i++) lists.push(to, entries[i]);
  for (let width = 1; width < n; width *= 2) {
    for (let low = 0; low < n; low += 2 * width) {
      const middle = low + width < n ? low + width : n;
      const high = low + 2 * width < n ? low + 2 * width : n;
      let i = low;
      let j = middle;
      let k = low;
      while (i < middle && j < high) to[k++] = from[j].exported < from[i].exported ? from[j++] : from[i++];
      while (i < middle) to[k++] = from[i++];
      while (j < high) to[k++] = from[j++];
    }
    const merged = to;
    to = from;
    from = merged;
  }
  return from;
}
