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
import type { ExportAllDeclaration, ExportNamedDeclaration, Identifier, ImportDeclaration, Literal, ModuleDeclaration, Statement } from 'acorn';
import { bindingIdentifiers } from './binding-pattern.js';

/** The CommonJS exports object marked as an ES module's; answers the function that installs an export's getter. */
export const ESM_EXPORTS_HELPER = '(() => { const O = ({}).constructor; const tag = O.getOwnPropertySymbols(O.getPrototypeOf(async () => {}))[0]; '
  + 'return (exports) => { O.defineProperty(exports, "__esModule", { value: true, configurable: true }); O.defineProperty(exports, tag, { value: "Module" }); '
  + 'return (name, get) => O.defineProperty(exports, name, { enumerable: true, get }); }; })()';

/**
 * `export *`: each name of the module but `default`, those already exported
 * and those `omitted` (ESM_CONFLICTS_HELPER's), read through.
 */
export const ESM_STAR_HELPER = '(exports, define, m, omitted) => { for (const k in m) { if (k === "default" || ({}).hasOwnProperty.call(exports, k)) continue; '
  + 'let left = false; for (let i = 0; omitted && i < omitted.length; i++) if (omitted[i] === k) left = true; if (!left) define(k, () => m[k]); } }';

/** What a module's require is passed for the names its `export *`s reach two different bindings of. */
export const ESM_STAR_CONFLICTS = 'nimbus:star-conflicts';

/** The names a module's `export *`s leave out, as Node's namespace omits them: its loader's answer, through its require. */
export const ESM_CONFLICTS_HELPER = `(require) => require("", "${ESM_STAR_CONFLICTS}")`;

/**
 * What a module's require is passed beside a static import's specifier: the
 * loader resolves it as Node's ESM loader does (node-shims' __requireFrom),
 * not as require() does. A require of a module takes its first argument
 * alone, as Node's does.
 */
export const ESM_STATIC_IMPORT = 'nimbus:static-import';

/** A static import's module: the importer's require, told the request is an import, with its `type` attribute (or null). */
export const ESM_LOAD_HELPER = `(require, source, type) => require(source, "${ESM_STATIC_IMPORT}", type)`;

/** The helpers as an object literal's source: what a launch compiles for its interpreter (interpreter/modules.ts ModuleHelpers). */
export const ESM_MODULE_HELPERS = `{ exports: ${ESM_EXPORTS_HELPER}, star: ${ESM_STAR_HELPER}, conflicts: ${ESM_CONFLICTS_HELPER}, load: ${ESM_LOAD_HELPER} }`;

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
  | { readonly kind: 'import'; readonly start: number; readonly end: number; readonly source: string; readonly type: string | null; readonly bindings: readonly Binding[] }
  | {
    readonly kind: 'export';
    readonly start: number;
    readonly end: number;
    readonly source: string | null;
    /** Its source's `type` attribute (importType); null with no source. */
    readonly type: string | null;
    readonly names: readonly EsmExportName[];
  }
  | { readonly kind: 'export-all'; readonly start: number; readonly end: number; readonly source: string; readonly type: string | null }
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

/**
 * The attribute a static import or re-export passes its loader: its `type`,
 * or null. V8 keeps only the keys its host supports, Node's being `type`
 * alone, so any other key is dropped, not refused (import()'s are refused).
 */
export function importType(node: ImportDeclaration | ExportNamedDeclaration | ExportAllDeclaration): string | null {
  const attributes = node.attributes ?? [];
  for (let i = 0; i < attributes.length; i++) {
    const { key, value } = attributes[i];
    if ((key.type === 'Identifier' ? key.name : key.value) === 'type' && typeof value.value === 'string') return value.value;
  }
  return null;
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
      return { kind: 'import', start: node.start, end: node.end, source: `${node.source.value}`, type: importType(node), bindings };
    }
    case 'ExportNamedDeclaration': {
      const names = lists.list<EsmExportName>();
      const declaration = node.declaration;
      if (declaration) {
        if (declaration.type === 'VariableDeclaration') {
          const ids = lists.list<Identifier>();
          for (let i = 0; i < declaration.declarations.length; i++) bindingIdentifiers(declaration.declarations[i].id, ids);
          for (let i = 0; i < ids.length; i++) lists.push(names, { kind: 'named', exported: ids[i].name, local: ids[i].name });
        } else {
          lists.push(names, { kind: 'named', exported: declaration.id.name, local: declaration.id.name });
        }
        return { kind: 'export', start: node.start, end: declaration.start, source: null, type: null, names };
      }
      for (let i = 0; i < node.specifiers.length; i++) {
        const specifier = node.specifiers[i];
        lists.push(names, { kind: 'named', exported: exportName(specifier.exported), local: exportName(specifier.local) });
      }
      return { kind: 'export', start: node.start, end: node.end, source: node.source ? `${node.source.value}` : null, type: node.source ? importType(node) : null, names };
    }
    case 'ExportDefaultDeclaration': {
      const declaration = node.declaration;
      if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
        const names = lists.list<EsmExportName>();
        lists.push(names, { kind: 'named', exported: 'default', local: declaration.id.name });
        return { kind: 'export', start: node.start, end: declaration.start, source: null, type: null, names };
      }
      return { kind: 'export-default', start: node.start, end: node.end, expression: { start: declaration.start, end: declaration.end } };
    }
    case 'ExportAllDeclaration': {
      if (node.exported) {
        const names = lists.list<EsmExportName>();
        lists.push(names, { kind: 'namespace', exported: exportName(node.exported) });
        return { kind: 'export', start: node.start, end: node.end, source: `${node.source.value}`, type: importType(node), names };
      }
      return { kind: 'export-all', start: node.start, end: node.end, source: `${node.source.value}`, type: importType(node) };
    }
    default:
      return null;
  }
}

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
  const request = (source: string, type: string | null, kept: boolean, bindings: readonly Binding[]): number => {
    lists.push(requests, { source, type, kept, bindings });
    return requests.length - 1;
  };
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    switch (record.kind) {
      case 'import': {
        const at = request(record.source, record.type, record.bindings.length > 0, record.bindings);
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
        const at = request(record.source, record.type, true, none);
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
        lists.push(stars, request(record.source, record.type, true, none));
        break;
    }
  }
  return { exports: byExportedName(exports, lists), requests, namespaces, stars };
}

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
export function esmBindings(link: EsmLink, lists: EsmLists): ModuleBindings {
  const exports = lists.list<string>();
  for (let i = 0; i < link.exports.length; i++) lists.push(exports, link.exports[i].exported);
  const imports = lists.list<string[]>();
  for (let i = 0; i < link.requests.length; i++) {
    const names = lists.list<string>();
    const bindings = link.requests[i].bindings;
    for (let j = 0; j < bindings.length; j++) {
      const binding = bindings[j];
      if (binding.kind === 'named') lists.push(names, binding.imported);
    }
    lists.push(imports, names);
  }
  for (let i = 0; i < link.exports.length; i++) {
    const entry = link.exports[i];
    if (entry.kind === 'reexport') lists.push(imports[entry.request], entry.name);
  }
  const types = lists.list<string | null>();
  for (let i = 0; i < link.requests.length; i++) lists.push(types, link.requests[i].type);
  const reexports = lists.list<readonly [string, number, string | null]>();
  const locals = lists.list<readonly [string, string]>();
  for (let i = 0; i < link.exports.length; i++) {
    const entry = link.exports[i];
    if (entry.kind === 'reexport') lists.push(reexports, [entry.exported, entry.request, entry.name]);
    else if (entry.kind === 'namespace') lists.push(reexports, [entry.exported, link.namespaces[entry.namespace].request, null]);
    else if (entry.kind === 'default') lists.push(locals, [entry.exported, '*default*']);
    else {
      // An export of an imported binding is that module's.
      let imported = false;
      for (let r = 0; r < link.requests.length; r++) {
        const bindings = link.requests[r].bindings;
        for (let j = 0; j < bindings.length; j++) {
          const binding = bindings[j];
          if (binding.local !== entry.local) continue;
          lists.push(reexports, [entry.exported, r, binding.kind === 'named' ? binding.imported : null]);
          imported = true;
        }
      }
      if (!imported) lists.push(locals, [entry.exported, entry.local]);
    }
  }
  return { exports, imports, stars: link.stars, types, reexports, locals };
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
