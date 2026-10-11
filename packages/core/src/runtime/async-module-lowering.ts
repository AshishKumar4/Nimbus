/**
 * ES module to CommonJS: the one emitter of the import/export interop every
 * Nimbus lowering shares, and its two module readers.
 *
 * A module's imports and exports are read into records (readEsmRecords, by
 * acorn's module parse, a statement at a time: no tree of the whole module
 * is held, so a multi-MiB bundle reads in bounded memory), and emitCommonJs
 * writes the CommonJS for them, as esbuild's and TypeScript's CommonJS
 * output behave, linking them as esm-interop.ts says (the interpreter links
 * a module it runs the same way): an import's bindings are read off its
 * module at each use, so they are live as Node's are (an `export let` its
 * module reassigns later reads as reassigned), a call with `this`
 * undefined; each export's getter is installed before the body runs, so a
 * binding the body assigns later (`export let db; db = await connect()`)
 * reads as assigned, and before the modules it requests are required, as
 * esbuild installs them, so a module in a cycle with it finds them (a
 * function it declares is there while the cycle evaluates, as Node hoists
 * it); `export default <expression>` evaluates where it stands, into a
 * binding its getter reads.
 *
 * Two bodies: `async` runs the module in an async IIFE, the body the
 * CommonJS cell gives a module with top-level await; `sync` is the module's
 * own statements at the wrapper's top level.
 *
 * Every line of the module stays where the source has it: what the emitter
 * adds goes on the first line, before the module (its `head`), and every
 * edit keeps the line breaks it replaces. Where an edit moves a column, the
 * emit's ColumnMap says so, for its frames to read the source's place.
 *
 * Acorn's parse gives the declarations: esbuild prints an import or export
 * clause across several lines when it is long (serve 14's `import {\n
 * resolve as resolvePath, ... } from "node:path"`), so no line or text
 * pattern can stand in for it.
 *
 * Runs in the transform facet (installed by oxc-facet/preamble.ts), in
 * esbuild-service.ts, and in the shell's `node` command.
 */
import { tokenizer, tokTypes, type ModuleDeclaration, type Statement } from 'acorn';
import { DYNAMIC_IMPORT_HELPER } from './dynamic-import-rewrite.js';
import {
  ESM_EXPORTS_HELPER, ESM_INTEROP_HELPER, ESM_NAMESPACE_HELPER, ESM_STAR_HELPER, esmLink, esmRecord, type EsmImportBinding,
  type EsmLists, type EsmRecord,
} from './esm-interop.js';
import { applySourceEdits, COMMONJS_WRAPPER_NAMES, MODULE_PARSE_OPTIONS, parseStatements, type SourceEdit } from './javascript-ast.js';
import { bindingScope, list, namesBinding, programNames, scoped, stringOf, type EsNode, type Scope } from './javascript-scope.js';
import { ES_MODULE_UNBOUND_NAMES, esModuleSource, type ModuleScope } from './module-format.js';

/** An import's binding (esm-interop.ts), a named one with its `references`: where the module uses it. */
export type EsmUsedBinding =
  | Extract<EsmImportBinding, { kind: 'namespace' }>
  | (Extract<EsmImportBinding, { kind: 'named' }> & { readonly references: readonly EsmReference[] });

/** A module's declaration as the emitter reads it: esm-interop.ts's, its named imports' uses found. */
export type EsmUsedRecord = EsmRecord<EsmUsedBinding>;

/**
 * A use of an imported binding: a read, a call (`this` stays undefined), one
 * that begins its expression statement (a leading-call), a shorthand property
 * (`{ n }`), or a write, which throws as the language's assignment to an
 * import does.
 */
export interface EsmReference {
  readonly start: number;
  readonly end: number;
  readonly use: 'read' | 'typeof' | 'call' | 'leading-call' | 'shorthand' | 'write';
}

/** The emitter's lists: ordinary arrays. */
const ARRAYS: EsmLists = { list: () => [], push: (list, value) => { list.push(value); } };

/** `text` as spaces, its line breaks kept. */
function blank(text: string): string {
  return text.replace(/[^\n\r\u2028\u2029]/g, ' ');
}

const GENERATED_NAME_PREFIX = '__nimbus_m';

/**
 * Names for code generated around `source`: none of `names`, its identifiers
 * that start as they do, as the parse reads them (unicode escapes decoded);
 * by default its tokens'.
 */
export function generatedNames(source: string, names: ReadonlySet<string> = generatedLookingNames(source)): () => string {
  let count = 0;
  return () => {
    let name: string;
    do name = `${GENERATED_NAME_PREFIX}${count++}`; while (names.has(name));
    return name;
  };
}

function generatedLookingNames(source: string): Set<string> {
  const names = new Set<string>();
  try {
    for (const token of tokenizer(source, MODULE_PARSE_OPTIONS)) {
      const value: unknown = Reflect.get(token, 'value');
      if (token.type === tokTypes.name && typeof value === 'string' && value.startsWith(GENERATED_NAME_PREFIX)) names.add(value);
    }
  } catch (error) {
    // The parse after this reports the module's syntax error.
    if (!(error instanceof SyntaxError)) throw error;
  }
  return names;
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
  /** Further edits to the body, outside every record's range. */
  readonly edits?: readonly SourceEdit[];
  /**
   * The module's import.meta (each `metas` span) read from `metadata`, an
   * expression, and its import() calls (each at a `dynamicImports` start)
   * made through the process's loader, `loader(parentUrl, ...arguments)`
   * (by default dynamic-import-rewrite.ts's, as rewriteDynamicImports makes
   * a CommonJS module's).
   */
  readonly bind?: {
    readonly metadata: string;
    readonly parentUrl: string;
    readonly metas: readonly Span[];
    readonly dynamicImports: readonly number[];
    readonly loader?: string;
  };
  /** Where the module's own text ends in `source` (esModuleSource appends to it): the emit's `end`. */
  readonly sourceLength?: number;
}

interface Span { readonly start: number; readonly end: number }

/** `esm` lowered to the CommonJS function body of an async module. */
export function lowerAsyncModule(esm: string): string {
  return emitCommonJs(esm, readEsmRecords(esm), { body: 'async' });
}

/**
 * An ES module lowered to the CommonJS a cell runs (commonjs-cell.ts), at
 * `parentUrl`: the one lowering, which the transform facet runs for a module
 * under bundle-cell-transform.ts BUNDLED_ESM_REWRITE_MIN_BYTES and the
 * session for a larger one, read a statement at a time (bounded memory). Its
 * import.meta is the cell's module's, its import() the process loader's. In
 * Node's `scope` a free use of a CommonJS wrapper name binds nothing
 * (module-format.ts ES_MODULE_UNBOUND_NAMES; its typeof is 'undefined'); in
 * Bun's the module keeps them. `map` is the emit's EsModuleMap. Throws
 * acorn's SyntaxError for a module that does not parse.
 */
export function lowerEsModule(source: string, scope: ModuleScope, parentUrl: string): { code: string; map: string; warnings: [] } {
  const module = esModuleSource(source);
  const { records, wrapperUses, topLevelAwait, metas, dynamicImports, names } = readEsmModule(module);
  const unbound: SourceEdit[] = [];
  if (scope === 'node') for (const [name, references] of wrapperUses) {
    const to = ES_MODULE_UNBOUND_NAMES[name]!;
    for (const { start, end, use } of references) {
      unbound.push({ start, end, text: use === 'typeof' ? '(void 0)' : use === 'shorthand' ? `${name}: ${to}` : to });
    }
  }
  const { code, head, end, columns } = emitModule(module, records, {
    body: topLevelAwait ? 'async' : 'sync',
    names: generatedNames(module, names),
    exportsObject: 'arguments[2].exports',
    requireFunction: 'arguments[1]',
    edits: unbound,
    bind: { metadata: 'arguments[2].__nimbusImportMeta', parentUrl, metas, dynamicImports },
    sourceLength: source.length,
  });
  const map: EsModuleMap = { head, tail: code.length - end, columns };
  return { code, map: JSON.stringify(map), warnings: [] };
}

/**
 * What a lowered ES module's frames read back as its source's places: where
 * the module's own text starts (`head`) and ends (`tail` from the emit's end)
 * in its emit, and the ColumnMap of its edits.
 */
export interface EsModuleMap {
  readonly head: number;
  readonly tail: number;
  readonly columns: ColumnMap;
}

/** A use of a name an import may bind, before the module's imports are all known. */
interface NamedUse extends EsmReference {
  readonly name: string;
}

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
export function readEsmRecords(source: string): EsmUsedRecord[] {
  return readEsmModule(source).records;
}

/**
 * readEsmRecords, and where the module uses a name the CommonJS wrapper
 * binds (`require`, `module`, `exports`, `__filename`, `__dirname`) that
 * neither its top level nor any scope around the use declares: no binding
 * at all in an ES module's scope, which a lowering to CommonJS must keep so
 * (module-format.ts ES_MODULE_UNBOUND_NAMES).
 */
export function readEsmModule(source: string): {
  records: EsmUsedRecord[];
  wrapperUses: ReadonlyMap<string, readonly EsmReference[]>;
  /** An `await` (or `for await`) outside every function. */
  topLevelAwait: boolean;
  /** Every import.meta, and where each import() starts. */
  metas: readonly Span[];
  dynamicImports: readonly number[];
  /** Every identifier's name that starts as a generated one does (generatedNames), unicode escapes decoded. */
  names: ReadonlySet<string>;
} {
  const first = readModule(source, null);
  const read = first.importsAfterCode ? readModule(source, first.imported) : first;
  const { records, wrapperUses, topLevelAwait, metas, dynamicImports, names } = read;
  return { records, wrapperUses, topLevelAwait, metas, dynamicImports, names };
}

function readModule(source: string, known: ReadonlySet<string> | null): {
  records: EsmUsedRecord[];
  imported: Set<string>;
  importsAfterCode: boolean;
  wrapperUses: Map<string, EsmReference[]>;
  topLevelAwait: boolean;
  metas: Span[];
  dynamicImports: number[];
  names: Set<string>;
} {
  const imported = new Set<string>(known ?? []);
  // Their uses are tracked as an import's are; a top-level declaration of
  // one (Vite's `const require = createRequire(import.meta.url)`) binds it.
  const tracked = new Set<string>([...imported, ...COMMONJS_WRAPPER_NAMES]);
  const declared = new Set<string>();
  const records: EsmRecord[] = [];
  const uses = new Map<string, EsmReference[]>();
  let code = false;
  let importsAfterCode = false;
  // Where each await finished so far starts; a function, once finished, takes back its own.
  const awaits: number[] = [];
  // Where an expression statement starts with a tracked name: a call there is a leading-call.
  const statementStarts = new Set<number>();
  const metas: Span[] = [];
  const dynamicImports: number[] = [];
  const names = new Set<string>();

  const outside: Scope = { names: new Set(), parent: null };
  // Where an identifier spelled as an imported name starts, in order: code
  // with none in it uses no import, and is not walked.
  const mentions: number[] = [];
  const mentioned = (start: number, end: number): boolean => {
    let low = 0;
    let high = mentions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (mentions[middle]! < start) low = middle + 1;
      else high = middle;
    }
    return low < mentions.length && mentions[low]! < end;
  };
  // Each function's uses its own scopes leave free.
  const freeIn = new WeakMap<EsNode, readonly NamedUse[]>();
  const freeUses = (root: EsNode): readonly NamedUse[] => {
    const own = freeIn.get(root);
    if (own) return own;
    const free: NamedUse[] = [];
    if (!mentioned(root.start, root.end)) return free;
    // A pattern's properties, as the walk reaches them: a value there is written.
    const patternProperties = new Set<EsNode>();
    for (const [node, scope, parent, key] of scoped(root, outside, false, false, null, '', (n) => n !== root && freeIn.has(n))) {
      const inner = node === root ? undefined : freeIn.get(node);
      if (inner) {
        for (const use of inner) if (bindingScope(scope, use.name) === null) free.push(use);
        continue;
      }
      if (node.type === 'ObjectPattern') for (const property of list(node, 'properties')) patternProperties.add(property);
      const name = node.type === 'Identifier' ? stringOf(node, 'name') : null;
      if (name === null || !tracked.has(name) || parent === null || !namesBinding(parent, key)) continue;
      if (bindingScope(scope, name) !== null) continue;
      free.push({ name, start: node.start, end: node.end, use: useOf(parent, key, patternProperties) });
    }
    return free;
  };

  const onIdentifier = (identifier: EsNode) => {
    const name = stringOf(identifier, 'name');
    if (name === null) return;
    if (name.startsWith(GENERATED_NAME_PREFIX)) names.add(name);
    if (!tracked.has(name)) return;
    // Identifiers finish in source order; one out of it is put in its place.
    let at = mentions.length;
    while (at > 0 && mentions[at - 1]! > identifier.start) at--;
    mentions.splice(at, 0, identifier.start);
  };
  const onStatement = (node: Statement | ModuleDeclaration) => {
    for (const name of programNames(node as unknown as EsNode)) declared.add(name);
    if (node.type !== 'ImportDeclaration') {
      // A top-level statement's free uses are its imports' (none redeclares one).
      for (const { name, start, end, use } of freeUses(node as unknown as EsNode)) {
        const found = uses.get(name) ?? [];
        uses.set(name, found);
        found.push({ start, end, use });
      }
    }
    const record = esmRecord(node, ARRAYS);
    if (record?.kind === 'import') {
      for (const binding of record.bindings) {
        if (binding.kind === 'namespace') continue;
        if (code && !imported.has(binding.local)) importsAfterCode = true;
        imported.add(binding.local);
        tracked.add(binding.local);
      }
      records.push(record);
      return;
    }
    if (record) records.push(record);
    code = true;
  };
  parseStatements(source, MODULE_PARSE_OPTIONS, {
    onStatement: (statement) => onStatement(statement as Statement | ModuleDeclaration),
    onNode: (node) => {
      if (node.type === 'Identifier') onIdentifier(node);
      else if (node.type === 'ExpressionStatement') {
        if (mentioned(node.start, node.start + 1)) statementStarts.add(node.start);
      } else if (node.type === 'ImportExpression') {
        dynamicImports.push(node.start);
      } else if (node.type === 'MetaProperty') {
        if (node.meta.name === 'import') metas.push({ start: node.start, end: node.end });
      } else if (node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await)) awaits.push(node.start);
      // A function, once finished: its free uses, before its body is dropped.
      else if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
        freeIn.set(node, freeUses(node));
        while (awaits.length > 0 && awaits[awaits.length - 1]! >= node.start) awaits.pop();
      }
    },
  });
  const leading = (references: readonly EsmReference[]) => references.map((reference) => (
    reference.use === 'call' && statementStarts.has(reference.start) ? { ...reference, use: 'leading-call' as const } : reference
  ));
  const withUses = records.map((record): EsmUsedRecord => record.kind !== 'import' ? record : {
    ...record,
    bindings: record.bindings.map((binding): EsmUsedBinding => binding.kind === 'namespace' ? binding : { ...binding, references: leading(uses.get(binding.local) ?? []) }),
  });
  const wrapperUses = new Map<string, EsmReference[]>();
  for (const name of COMMONJS_WRAPPER_NAMES) {
    const found = uses.get(name);
    if (found && !declared.has(name)) wrapperUses.set(name, found);
  }
  return { records: withUses, imported, importsAfterCode, wrapperUses, topLevelAwait: awaits.length > 0, metas, dynamicImports, names };
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
    case 'UnaryExpression':
      return parent.operator === 'typeof' ? 'typeof' : 'read';
    case 'TaggedTemplateExpression':
      return key === 'tag' ? 'call' : 'read';
    default:
      return 'read';
  }
}

/** The CommonJS for ES module `source`, whose import and export declarations are `records`. */
export function emitCommonJs(source: string, records: readonly EsmUsedRecord[], options: CommonJsEmitOptions): string {
  return emitModule(source, records, options).code;
}

/**
 * The emit, with where its first line's generated code ends (`head`, which
 * the cell wrapper adds to its own) and the columns its edits moved
 * (ColumnMap): what a frame of it reads back as the source's places.
 */
function emitModule(source: string, records: readonly EsmUsedRecord[], options: CommonJsEmitOptions): { code: string; head: number; end: number; columns: ColumnMap } {
  const temp = options.names ?? generatedNames(source);
  const key = (name: string) => `[${JSON.stringify(name)}]`;
  const link = esmLink(records, ARRAYS);
  // The wrapper's top level holds only generated names (the helpers, and
  // the require every request calls): in an async body the module's own
  // bindings, its imports' included, are inside the IIFE, so nothing it
  // declares (`import Object from "dep"`, `const require = createRequire(...)`)
  // reaches what these read.
  const header: string[] = [];
  const helpers = new Map<string, string>();
  const helper = (text: string): string => {
    let name = helpers.get(text);
    if (name === undefined) {
      name = temp();
      helpers.set(text, name);
      header.push(`const ${name} = ${text};`);
    }
    return name;
  };
  let requireRef = '';
  if (link.requests.length > 0) {
    requireRef = temp();
    header.push(`const ${requireRef} = (specifier) => ${options.requireFunction ?? 'require'}(specifier);`);
  }
  // An ES module's exports object, marked so (ESM_EXPORTS_HELPER) when it
  // declares any export, `export {}` included (esModuleSource gives every
  // lowered module one).
  let exportsRef = '';
  let exportGetter = '';
  if (records.some((record) => record.kind !== 'import')) {
    exportsRef = temp();
    exportGetter = temp();
    header.push(`const ${exportsRef} = ${options.exportsObject ?? 'module.exports'}; const ${exportGetter} = (${ESM_EXPORTS_HELPER})(${exportsRef});`);
  }

  // Each requested module, and a default import's interop, as it is
  // required; what the body reads for each named binding.
  const requires: string[] = [];
  const modules: string[] = [];
  const reads = new Map<string, string>();
  for (const request of link.requests) {
    if (!request.kept) {
      requires.push(`${requireRef}(${JSON.stringify(request.source)});`);
      modules.push('');
      continue;
    }
    const mod = temp();
    modules.push(mod);
    requires.push(`const ${mod} = ${requireRef}(${JSON.stringify(request.source)});`);
    const interop = request.interop ? temp() : null;
    if (interop) requires.push(`const ${interop} = ${helper(ESM_INTEROP_HELPER)}(${mod});`);
    for (const binding of request.bindings) {
      if (binding.kind === 'named') reads.set(binding.local, binding.imported === 'default' ? `${interop}.default` : `${mod}${key(binding.imported)}`);
    }
  }

  // An import's namespace once every request is required; a re-export's
  // (`export * as`) when first read, once.
  const imported: string[] = [];
  const lazy: string[] = [];
  const namespaces = link.namespaces.map(({ request, local }) => {
    const namespace = helper(ESM_NAMESPACE_HELPER);
    if (local !== null) {
      imported.push(`const ${local} = ${namespace}(${modules[request]});`);
      return local;
    }
    const value = temp();
    lazy.push(`let ${value};`);
    return `${value} ??= ${namespace}(${modules[request]})`;
  });

  // The edit to each use of an import; a const a write to the import throws
  // on, as the language's assignment to an import does.
  const uses: ColumnEdit[] = [];
  const useImports = (bindings: readonly EsmUsedBinding[]) => {
    for (const binding of bindings) {
      if (binding.kind === 'namespace') continue;
      const read = reads.get(binding.local)!;
      for (const { start, end, use } of binding.references) {
        if (use === 'write') continue;
        // `(` would continue a statement before it that has no `;`; `void` cannot.
        const callee = use === 'call' ? `(0, ${read})` : use === 'leading-call' ? `void 0, (0, ${read})` : null;
        uses.push(callee === null
          ? { start, end, text: use === 'shorthand' ? `${binding.local}: ${read}` : read }
          : { start, end, text: callee, call: true });
      }
      if (binding.references.some(({ use }) => use === 'write')) imported.push(`const ${binding.local} = void 0;`);
    }
  };
  const edits: SourceEdit[] = [...(options.edits ?? [])];
  // A hashbang is only valid as the first line of a script; the body moves
  // into a function. Kept as a comment so line numbers stay put.
  if (source.startsWith('#!')) edits.push({ start: 0, end: 2, text: '//' });
  // A declaration is a statement: a `;` in its place ends one before it that has none.
  const remove = (start: number, end: number) => edits.push({ start, end, text: ';' + blank(source.slice(start + 1, end)) });
  let defaultValue = '';
  for (const record of records) {
    if (record.kind !== 'export-default') {
      remove(record.start, record.end);
      if (record.kind === 'import') useImports(record.bindings);
      continue;
    }
    defaultValue = temp();
    const { start, end } = record.expression;
    // Through a property named default, an anonymous function or class
    // is named `default`, as the language names an exported one. The
    // expression, and every edit in it, stays where the source has it.
    const keyword = blank(source.slice(record.start, start));
    const lineBreak = keyword.search(/[\n\r\u2028\u2029]/);
    edits.push({ start: record.start, end: start, text: `var ${defaultValue} = ({ default: (` + (lineBreak === -1 ? '' : keyword.slice(lineBreak)) });
    edits.push({ start: end, end: record.end, text: ') }).default;' + blank(source.slice(end, record.end)) });
  }

  // Before the requests: each export's getter, in name order.
  const installed = link.exports.map((entry) => {
    const read = entry.kind === 'binding' ? reads.get(entry.local) ?? entry.local
      : entry.kind === 'default' ? defaultValue
        : entry.kind === 'reexport' ? `${modules[entry.request]}${key(entry.name)}`
          : namespaces[entry.namespace];
    return `${exportGetter}(${JSON.stringify(entry.exported)}, () => ${read});`;
  });
  const stars = link.stars.map((request) => `${helper(ESM_STAR_HELPER)}(${exportsRef}, ${exportGetter}, ${modules[request]});`);
  const bind = options.bind;
  if (bind && bind.metas.length > 0) {
    const meta = temp();
    header.push(`const ${meta} = ${bind.metadata};`);
    for (const { start, end } of bind.metas) edits.push({ start, end, text: meta + blank(source.slice(start, end)).replace(/ /g, '') });
  }
  if (bind && bind.dynamicImports.length > 0) {
    const load = temp();
    header.push(`const ${load} = (...args) => ${bind.loader ?? DYNAMIC_IMPORT_HELPER}(${JSON.stringify(bind.parentUrl)}, ...args);`);
    for (const start of bind.dynamicImports) edits.push({ start, end: start + 'import'.length, text: load });
  }
  const allEdits = [...edits, ...uses];
  const prologue = [...lazy, ...installed, ...requires, ...imported, ...stars].join(' ');
  // An ES module is strict: the directive opens the first line, where the
  // wrapper finds it (commonjs-cell.ts).
  const lead = options.body === 'async'
    ? `"use strict";${header.join(' ')} return (async () => { ${prologue}`
    : `"use strict";${header.join(' ')} ${prologue}`;
  const code = lead + applySourceEdits(source, allEdits) + (options.body === 'async' ? '\n})();\n' : '\n');
  const sourceLength = options.sourceLength ?? source.length;
  let end = lead.length + sourceLength;
  for (const edit of allEdits) if (edit.end <= sourceLength) end += edit.text.length - (edit.end - edit.start);
  return { code, head: lead.length, end, columns: columnMap(source, allEdits) };
}

/** An edit of the module's text; a call's (`(0, m.f)(…)`) is placed by V8 at its end, where the source's is at its start. */
type ColumnEdit = SourceEdit & { call?: true };

/**
 * Where a module's edits change a line, by line: [line, source column,
 * generated length, source text], and 1 for a call (commonjs-cell.ts
 * __nimbusSourceColumn, __nimbusSourceLine).
 */
export type ColumnMap = Array<[number, number, number, string] | [number, number, number, string, 1]>;

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/** The ColumnMap of `edits`, each of which keeps the module's line breaks: each line of the source is a line of the emit. */
function columnMap(source: string, edits: readonly ColumnEdit[]): ColumnMap {
  const entries: ColumnMap = [];
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  let line = 1;
  let lineStart = 0;
  let scanned = 0;
  for (const edit of ordered) {
    const before = source.slice(scanned, edit.start).split(LINE_BREAK);
    if (before.length > 1) {
      line += before.length - 1;
      lineStart = edit.start - before[before.length - 1]!.length;
    }
    scanned = edit.start;
    const from = source.slice(edit.start, edit.end).split(LINE_BREAK);
    const to = edit.text.split(LINE_BREAK);
    for (let i = 0; i < from.length; i++) {
      const column = i === 0 ? edit.start - lineStart : 0;
      const text = i === from.length - 1 ? to.slice(i).join('') : to[i]!;
      if (text === from[i]) continue;
      entries.push(edit.call && i === from.length - 1 ? [line + i, column, text.length, from[i]!, 1] : [line + i, column, text.length, from[i]!]);
    }
  }
  return entries;
}
