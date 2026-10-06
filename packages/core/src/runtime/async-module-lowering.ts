/**
 * ES module to CommonJS: the one emitter of the import/export interop every
 * Nimbus lowering shares, and its two module readers.
 *
 * A module's imports and exports are read into records (readEsmRecords, by
 * acorn's module parse; the bounded bundle rewrite builds its own from the
 * declarations it found, esbuild-service.ts), and emitCommonJs writes the
 * CommonJS for them, as esbuild's and TypeScript's CommonJS output behave:
 *   - every module the source requests is required in source order, before
 *     the body; an import's bindings are read off its module at each use, so
 *     they are live as Node's are (an `export let` its module reassigns later
 *     reads as reassigned): a default import through `__esModule` interop, a
 *     call with `this` undefined, and a namespace of a module not marked
 *     `__esModule` with that module as its `default`;
 *   - `__esModule` is a non-enumerable `true`, and each export is a live,
 *     enumerable getter installed in name order before the body runs, so a
 *     binding the body assigns later (`export let db; db = await connect()`)
 *     reads as assigned; and before the modules it requests are required, as
 *     esbuild installs them, so a module in a cycle with it finds them (a
 *     function it declares is there while the cycle evaluates, as Node
 *     hoists it); `export default <expression>` evaluates where it stands,
 *     into a binding its getter reads;
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
import { bindingScope, list, namesBinding, scoped, stringOf, type EsNode, type Scope } from './javascript-scope.js';

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
export type EsmImportBinding =
  | { readonly kind: 'namespace'; readonly local: string }
  | { readonly kind: 'named'; readonly local: string; readonly imported: string; readonly references: readonly EsmReference[] | null };

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
  const references = importReferences(program, program.body.flatMap((node) => node.type !== 'ImportDeclaration' ? [] : node.specifiers
    .filter((specifier) => specifier.type !== 'ImportNamespaceSpecifier')
    .map((specifier) => specifier.local.name)));
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
                references: references.get(specifier.local.name) ?? [],
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

/**
 * Where `program` uses each binding its imports name (not a namespace): the
 * identifiers its own scope resolves to that binding. Not a member's, a
 * key's or a label's name, an import or export declaration's own names, or a
 * name a nested scope binds again.
 */
function importReferences(program: unknown, names: readonly string[]): Map<string, EsmReference[]> {
  const references = new Map(names.map((name): [string, EsmReference[]] => [name, []]));
  if (references.size === 0) return references;
  const outside: Scope = { names: new Set(), parent: null };
  // A pattern's properties, as its walk reaches them: a value there is written.
  const patternProperties = new Set<EsNode>();
  for (const [node, scope, parent, key] of scoped(program, outside, false)) {
    if (node.type === 'ObjectPattern') for (const property of list(node, 'properties')) patternProperties.add(property);
    const name = node.type === 'Identifier' ? stringOf(node, 'name') : null;
    const found = name === null ? undefined : references.get(name);
    if (!found || name === null || parent === null || !namesBinding(parent, key)) continue;
    // The program's own scope is the one directly inside `outside`.
    if (bindingScope(scope, name)?.parent !== outside) continue;
    found.push({ start: node.start, end: node.end, use: useOf(parent, key, patternProperties) });
  }
  return references;
}

/** How an identifier under `parent` by `key` uses the binding it names. */
function useOf(parent: EsNode, key: string, patternProperties: ReadonlySet<EsNode>): EsmReference['use'] {
  switch (parent.type) {
    case 'AssignmentExpression':
    case 'AssignmentPattern':
    case 'ForInStatement':
    case 'ForOfStatement':
      return key === 'left' ? 'write' : 'read';
    case 'UpdateExpression':
    case 'ArrayPattern':
    case 'RestElement':
      return 'write';
    case 'Property':
      if (key !== 'value') return 'read';
      if (patternProperties.has(parent)) return 'write';
      return parent.shorthand === true ? 'shorthand' : 'read';
    case 'CallExpression':
      return key === 'callee' ? 'call' : 'read';
    case 'TaggedTemplateExpression':
      return key === 'tag' ? 'call' : 'read';
    default:
      return 'read';
  }
}

/** The CommonJS for ES module `source`, whose import and export declarations are `records`. */
export function emitCommonJs(source: string, records: readonly EsmRecord[], options: CommonJsEmitOptions): string {
  let prefix = '__nimbus_m';
  while (source.includes(prefix)) prefix += '_';
  let temps = 0;
  const temp = () => `${prefix}${temps++}`;
  const key = (name: string) => `[${JSON.stringify(name)}]`;
  // The wrapper's top level holds only generated names (these helpers, and
  // the require every record calls): in an async body the module's own
  // bindings, its imports' included, are inside the IIFE, so nothing it
  // declares (`import Object from "dep"`, `const require = createRequire(...)`)
  // reaches what these read.
  const requireRef = temp();
  const requireOf = (specifier: string) => `${requireRef}(${JSON.stringify(specifier)})`;
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

  // Before anything is emitted, since an export may name an import declared
  // after it: each import's module and, where it binds `default`, its
  // interop (the module if marked `__esModule`, else `{ default: module }`);
  // what the body reads for each named binding; and the edit to each use.
  const importModules = new Map<EsmRecord, { readonly mod: string; readonly interop: string | null }>();
  const reads = new Map<string, string>();
  const uses: SourceEdit[] = [];
  for (const record of records) {
    if (record.kind !== 'import' || record.bindings.length === 0) continue;
    const mod = temp();
    const interop = record.bindings.some((binding) => binding.kind === 'named' && binding.imported === 'default') ? temp() : null;
    importModules.set(record, { mod, interop });
    for (const binding of record.bindings) {
      if (binding.kind === 'namespace') continue;
      const read = binding.imported === 'default' ? `${interop}.default` : `${mod}${key(binding.imported)}`;
      reads.set(binding.local, read);
      for (const { start, end, use } of binding.references ?? []) {
        if (use === 'write') continue;
        uses.push({ start, end, text: use === 'call' ? `(0, ${read})` : use === 'shorthand' ? `${binding.local}: ${read}` : read });
      }
    }
  }
  const defaultExpressionUses = new Set<SourceEdit>();

  // In the body's scope, before it: a getter per export name in name order;
  // then, in source order, each requested module; then the bindings an
  // import declares (a namespace; a binding read once, where the reader saw
  // no scopes; a const a write to the import throws on, as the language's
  // assignment to an import does); then each `export *`'s names.
  const requires: string[] = [];
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
        const module = importModules.get(record);
        if (!module) {
          requires.push(`${requireOf(record.source)};`);
          break;
        }
        const { mod, interop } = module;
        requires.push(`const ${mod} = ${requireOf(record.source)};`);
        if (interop) requires.push(`const ${interop} = ${mod} && ${mod}.__esModule ? ${mod} : { default: ${mod} };`);
        for (const binding of record.bindings) {
          const { local } = binding;
          if (binding.kind === 'namespace') imported.push(`const ${local} = ${namespace(mod)};`);
          else if (binding.references === null) imported.push(`const ${local} = ${reads.get(local)};`);
          else if (binding.references.some(({ use }) => use === 'write')) imported.push(`const ${local} = void 0;`);
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
            getters.push([name.exported, reads.get(name.local) ?? name.local]);
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
        const { start, end } = record.expression;
        const within = uses.filter((use) => use.start >= start && use.end <= end);
        for (const use of within) defaultExpressionUses.add(use);
        const expression = applySourceEdits(source.slice(start, end), within.map((use) => ({ ...use, start: use.start - start, end: use.end - start })));
        edits.push({
          start: record.start, end: record.end,
          // Through a property named default, an anonymous function or class
          // is named `default`, as the language names an exported one.
          text: `var ${value} = ({ default: (${expression}) }).default;`,
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
  if (requires.length > 0) header.push(`const ${requireRef} = (specifier) => ${options.requireFunction ?? 'require'}(specifier);`);
  const installed = getters
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([exported, value]) => `${exportGetter}(${JSON.stringify(exported)}, () => ${value});`);
  const prologue = [...installed, ...requires, ...imported, ...stars].join(' ');
  const body = applySourceEdits(source, [...edits, ...uses.filter((use) => !defaultExpressionUses.has(use))]);
  return options.body === 'async'
    ? `${header.join('\n')}\nreturn (async () => { ${prologue}\n${body}\n})();\n`
    : `${header.join('\n')}\n${prologue}\n${body}\n`;
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
