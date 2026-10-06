/**
 * ES module to CommonJS: the one emitter of the import/export interop every
 * Nimbus lowering shares, and its two module readers.
 *
 * A module's imports and exports are read into records (readEsmRecords, by
 * acorn's module parse; the bounded bundle rewrite builds its own from the
 * declarations it found, esbuild-service.ts), and emitCommonJs writes the
 * CommonJS for them, as esbuild's and TypeScript's CommonJS output behave:
 *   - every module the source requests is required in source order, before
 *     the body; an import's bindings are read off its module (a default
 *     import through `__esModule` interop, and a namespace of a module not
 *     marked `__esModule` with that module as its `default`);
 *   - `__esModule` is a non-enumerable `true`, and each export is a live,
 *     enumerable getter installed before the body runs, in name order, so a
 *     binding the body assigns later (`export let db; db = await connect()`)
 *     reads as assigned; `export default <expression>` evaluates where it
 *     stands, into a binding its getter reads;
 *   - `export *` copies the source module's names after the module's own,
 *     skipping `default` and any name already exported: the module's own
 *     names, and an earlier `export *`'s, win.
 *
 * Two bodies: `async` runs the module in an async IIFE, the body the
 * CommonJS cell gives a module with top-level await (the transform refuses
 * `format: 'cjs'` for it, so it emits ESM and this lowers that); `sync` is
 * the module's own statements at the wrapper's top level.
 *
 * Acorn's parse gives the declarations: esbuild prints an import or export
 * clause across several lines when it is long (serve 14's `import {\n
 * resolve as resolvePath, ... } from "node:path"`), so no line or text
 * pattern can stand in for it.
 *
 * Runs in the transform facet (installed by oxc-facet/preamble.ts), in
 * esbuild-service.ts, and in the shell's `node` command.
 */
import { Parser, type Pattern } from 'acorn';
import { applySourceEdits, type SourceEdit } from './javascript-ast.js';

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
 * emitter removes or replaces: the whole declaration, except an exported
 * declaration (`export const`, `export function`, `export default class C`),
 * where it is the `export` keywords alone and the declaration stays.
 */
export type EsmRecord =
  | { readonly kind: 'import'; readonly start: number; readonly end: number; readonly source: string; readonly bindings: readonly EsmImportBinding[] }
  | { readonly kind: 'export'; readonly start: number; readonly end: number; readonly source: string | null; readonly names: readonly EsmExportName[] }
  | { readonly kind: 'export-all'; readonly start: number; readonly end: number; readonly source: string }
  | {
    readonly kind: 'export-default';
    readonly start: number;
    readonly end: number;
    /** The default expression's range in the source. */
    readonly expression: { readonly start: number; readonly end: number };
  };

/**
 * Names for code generated around `source`: a prefix its text does not hold
 * anywhere, then a number, so no binding of the source is one of them.
 */
export function generatedNames(source: string): () => string {
  let prefix = '__nimbus_m';
  while (source.includes(prefix)) prefix += '_';
  let count = 0;
  return () => `${prefix}${count++}`;
}

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
export function lowerAsyncModule(esm: string): string {
  return emitCommonJs(esm, readEsmRecords(esm), { body: 'async' });
}

/** The import and export declarations of ES module `source`, in source order. Throws on a syntax error. */
export function readEsmRecords(source: string): EsmRecord[] {
  const program = Parser.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  // ModuleExportName: an identifier, or a string such as `export { a as "b-c" }`.
  const nameOf = (node: { type: string; name?: string; value?: unknown }) =>
    node.type === 'Identifier' ? String(node.name) : String(node.value);
  const records: EsmRecord[] = [];
  for (const node of program.body) {
    switch (node.type) {
      case 'ImportDeclaration':
        records.push({
          kind: 'import', start: node.start, end: node.end, source: String(node.source.value),
          bindings: node.specifiers.map((specifier): EsmImportBinding => (
            specifier.type === 'ImportNamespaceSpecifier'
              ? { kind: 'namespace', local: specifier.local.name }
              : {
                kind: 'named',
                local: specifier.local.name,
                imported: specifier.type === 'ImportDefaultSpecifier' ? 'default' : nameOf(specifier.imported),
              }
          )),
        });
        break;
      case 'ExportNamedDeclaration':
        if (node.declaration) {
          records.push({
            kind: 'export', start: node.start, end: node.declaration.start, source: null,
            names: declaredNames(node.declaration).map((name): EsmExportName => ({ kind: 'named', exported: name, local: name })),
          });
        } else {
          records.push({
            kind: 'export', start: node.start, end: node.end, source: node.source ? String(node.source.value) : null,
            names: node.specifiers.map((s): EsmExportName => ({ kind: 'named', exported: nameOf(s.exported), local: nameOf(s.local) })),
          });
        }
        break;
      case 'ExportDefaultDeclaration': {
        const declaration = node.declaration;
        if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
          records.push({
            kind: 'export', start: node.start, end: declaration.start, source: null,
            names: [{ kind: 'named', exported: 'default', local: declaration.id.name }],
          });
        } else {
          records.push({
            kind: 'export-default', start: node.start, end: node.end,
            expression: { start: declaration.start, end: declaration.end },
          });
        }
        break;
      }
      case 'ExportAllDeclaration':
        if (node.exported) {
          records.push({
            kind: 'export', start: node.start, end: node.end, source: String(node.source.value),
            names: [{ kind: 'namespace', exported: nameOf(node.exported) }],
          });
        } else {
          records.push({ kind: 'export-all', start: node.start, end: node.end, source: String(node.source.value) });
        }
        break;
      default:
        break;
    }
  }
  return records;
}

/** The CommonJS for ES module `source`, whose import and export declarations are `records`. */
export function emitCommonJs(source: string, records: readonly EsmRecord[], options: CommonJsEmitOptions): string {
  const temp = options.names ?? generatedNames(source);
  const key = (name: string) => `[${JSON.stringify(name)}]`;
  const requireFunction = options.requireFunction ?? 'require';
  const requireOf = (specifier: string) => `${requireFunction}(${JSON.stringify(specifier)})`;
  // The wrapper's top level holds only generated names (its records and
  // these): in an async body the module's own bindings, its imports'
  // included, are inside the IIFE, so nothing it declares (`import Object
  // from "dep"`) reaches what these read.
  const exportsRef = temp();
  const exportGetter = temp();
  const ownKey = temp();
  const namespaceOf = temp();
  let namespaces = false;
  /** A required module's namespace: an __esModule one as it is, any other with `default` = its exports. */
  const namespace = (mod: string) => {
    namespaces = true;
    return `${namespaceOf}(${mod})`;
  };

  // In source order, before the body: each requested module.
  const requires: string[] = [];
  // After them, in the body's scope: the imports' bindings, read off their
  // modules, then a getter per export name in name order (a module
  // namespace's), then each `export *`'s names.
  const imported: string[] = [];
  const getters: [string, string][] = [];
  const stars: string[] = [];
  const edits: SourceEdit[] = [...(options.edits ?? [])];
  let exportsAnything = false;
  // A hashbang is only valid as the first line of a script; the body moves
  // into a function. Kept as a comment so line numbers stay put.
  if (source.startsWith('#!')) edits.push({ start: 0, end: 2, text: '//' });

  for (const record of records) {
    switch (record.kind) {
      case 'import': {
        edits.push({ start: record.start, end: record.end, text: '' });
        if (record.bindings.length === 0) {
          requires.push(`${requireOf(record.source)};`);
          break;
        }
        const mod = temp();
        requires.push(`const ${mod} = ${requireOf(record.source)};`);
        for (const binding of record.bindings) {
          const { local } = binding;
          if (binding.kind === 'namespace') imported.push(`const ${local} = ${namespace(mod)};`);
          else if (binding.imported === 'default') imported.push(`const ${local} = ${mod} && ${mod}.__esModule ? ${mod}.default : ${mod};`);
          else imported.push(`const ${local} = ${mod}${key(binding.imported)};`);
        }
        break;
      }
      case 'export': {
        exportsAnything = true;
        edits.push({ start: record.start, end: record.end, text: '' });
        if (record.source === null) {
          for (const name of record.names) {
            // A module's own export names a binding of its own; nothing else parses.
            if (name.kind !== 'named') throw new Error(`export of the namespace ${name.exported} without a source module`);
            getters.push([name.exported, name.local]);
          }
          break;
        }
        const mod = temp();
        requires.push(`const ${mod} = ${requireOf(record.source)};`);
        for (const name of record.names) {
          getters.push([name.exported, name.kind === 'namespace' ? namespace(mod) : `${mod}${key(name.local)}`]);
        }
        break;
      }
      case 'export-default': {
        exportsAnything = true;
        const value = temp();
        edits.push({
          start: record.start, end: record.end,
          // Through a property named default, an anonymous function or class
          // is named `default`, as the language names an exported one.
          text: `var ${value} = ({ default: (${source.slice(record.expression.start, record.expression.end)}) }).default;`,
        });
        getters.push(['default', value]);
        break;
      }
      case 'export-all': {
        exportsAnything = true;
        const mod = temp();
        edits.push({ start: record.start, end: record.end, text: '' });
        requires.push(`const ${mod} = ${requireOf(record.source)};`);
        stars.push(
          `for (const k in ${mod}) if (k !== "default" && !${ownKey}(${exportsRef}, k)) ${exportGetter}(k, () => ${mod}[k]);`,
        );
        break;
      }
    }
  }

  // Object is reached through a literal: in a sync body these lines share
  // the module's scope, where it may declare a binding of that name.
  const header = exportsAnything
    ? [
      `const ${exportsRef} = ${options.exportsObject ?? 'module.exports'}; ({}).constructor.defineProperty(${exportsRef}, "__esModule", { value: true });`,
      `const ${exportGetter} = (name, get) => ({}).constructor.defineProperty(${exportsRef}, name, { enumerable: true, get });`,
      `const ${ownKey} = (o, k) => ({}).hasOwnProperty.call(o, k);`,
    ]
    : [];
  // As Node and esbuild read a CommonJS module as a namespace: its exports
  // object is `default`, its other names read through.
  if (namespaces) {
    header.push(
      `const ${namespaceOf} = (m) => { if (m && m.__esModule) return m; const O = ({}).constructor; ` +
      `const ns = O.create(m != null ? O.getPrototypeOf(m) : null); O.defineProperty(ns, "default", { value: m, enumerable: true }); ` +
      `if (m != null) for (const k of O.getOwnPropertyNames(m)) if (k !== "default") O.defineProperty(ns, k, { get: () => m[k], enumerable: O.getOwnPropertyDescriptor(m, k).enumerable }); return ns; };`,
    );
  }
  const installed = getters
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([exported, value]) => `${exportGetter}(${JSON.stringify(exported)}, () => ${value});`);
  const prologue = [...imported, ...installed, ...stars].join(' ');
  const body = applySourceEdits(source, edits);
  return options.body === 'async'
    ? `${[...header, ...requires].join('\n')}\nreturn (async () => { ${prologue}\n${body}\n})();\n`
    : `${[...header, ...requires].join('\n')}\n${prologue}\n${body}\n`;
}

/** The bindings an exported declaration introduces. */
function declaredNames(declaration: { type: string; id?: { name: string } | null; declarations?: { id: Pattern }[] }): string[] {
  if (declaration.type !== 'VariableDeclaration') return declaration.id ? [declaration.id.name] : [];
  const names: string[] = [];
  const visit = (pattern: Pattern | null): void => {
    if (pattern === null) return;
    switch (pattern.type) {
      case 'Identifier': names.push(pattern.name); break;
      case 'ObjectPattern':
        for (const property of pattern.properties) visit(property.type === 'RestElement' ? property.argument : property.value);
        break;
      case 'ArrayPattern': for (const element of pattern.elements) visit(element); break;
      case 'RestElement': visit(pattern.argument); break;
      case 'AssignmentPattern': visit(pattern.left); break;
      default: break;
    }
  };
  for (const declarator of declaration.declarations ?? []) visit(declarator.id);
  return names;
}
