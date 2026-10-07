/**
 * module-format.ts — which module system Node runs a source under, as
 * doc/api/packages.md "Determining module system" defines it (Node 22, with
 * syntax detection on by default from v22.7.0).
 *
 * The answer decides whether a source is lowered to CommonJS before it runs
 * (every runtime here runs CommonJS: commonjs-cell.ts says why), so the shell's
 * `node`, the facet's entry and the lifo substrate's loader all ask it here.
 */
import type { AnyNode } from 'acorn';
import { COMMONJS_WRAPPER_NAMES, applySourceEdits, containsModuleSyntax, parseStatements, type SourceEdit } from './javascript-ast.js';
import { vfsPathExtension } from '../vfs/path.js';

/** A package.json's "type", when it declares one. */
export type PackageType = 'module' | 'commonjs' | null;

/** The "type" a parsed package.json declares. */
export function packageTypeOf(pkg: unknown): PackageType {
  const type = typeof pkg === 'object' && pkg !== null && 'type' in pkg ? pkg.type : undefined;
  return type === 'module' || type === 'commonjs' ? type : null;
}

/** The "type" a package.json's text declares. */
export function declaredPackageType(packageJson: string): PackageType {
  try {
    return packageTypeOf(JSON.parse(packageJson));
  } catch { return null; }
}

/**
 * Whether Node runs the file at `path` as an ES module: `.mjs` always, `.cjs`
 * never, a `.js` or extensionless file as the nearest package.json's "type"
 * says (`packageType`, asked only for those), and otherwise by its syntax
 * (containsModuleSyntax), in node_modules as anywhere.
 */
export function isEsModuleFile(path: string, source: string, packageType: () => PackageType): boolean {
  const ext = vfsPathExtension(path);
  if (ext === '.mjs') return true;
  if (ext === '.cjs') return false;
  const type = ext === '.js' || ext === '' ? packageType() : null;
  return type === null ? containsModuleSyntax(source) : type === 'module';
}

/**
 * Whether Node runs `--eval` code or a program read from stdin as an ES
 * module: as `--input-type` says, and without it by its syntax, compiled as
 * Node compiles such code as CommonJS, where no wrapper binds a name.
 */
export function isEsModuleInput(source: string, inputType: string | undefined): boolean {
  if (inputType === 'module') return true;
  if (inputType === 'commonjs') return false;
  return containsModuleSyntax(source, 'eval');
}

/**
 * The global the guest defines (node-shims.ts) with an accessor for each
 * CommonJS wrapper name, which throws the ReferenceError V8 throws for a name
 * bound nowhere ("require is not defined"), from the frame that named it.
 */
export const ES_MODULE_SCOPE_GLOBAL = '__nimbusEsmScope';

/**
 * What a free reference to each CommonJS wrapper name becomes in an ES module
 * lowered to the CommonJS a facet runs (commonjs-cell.ts): its accessor on
 * ES_MODULE_SCOPE_GLOBAL, so reading, calling or assigning it throws as in
 * Node's ES module scope, which binds none of them, while the lowering's own
 * require and module.exports still reach the wrapper's. `typeof` of one is
 * 'undefined' (esModuleScopeTypeofs). The transform's `define` (and the
 * bounded rewrite's equivalent) applies it.
 */
export const ES_MODULE_UNBOUND_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  [...COMMONJS_WRAPPER_NAMES].map((name) => [name, `${ES_MODULE_SCOPE_GLOBAL}.${name}`]),
);

/**
 * A lowered ES module's code with `typeof` of each wrapper name 'undefined',
 * as `typeof` of a name bound nowhere is, where the define made the name an
 * accessor that throws when read: each `typeof` whose operand is one of
 * ES_MODULE_UNBOUND_NAMES' accessors, found in the code's syntax tree (not
 * one read further, as `typeof require.cache` reads require and throws; and
 * never text in a string, template, comment or regular expression).
 */
export function esModuleScopeTypeofs(code: string): string {
  if (!code.includes(ES_MODULE_SCOPE_GLOBAL)) return code;
  const edits: SourceEdit[] = [];
  parseStatements(code, { ecmaVersion: 'latest', sourceType: 'commonjs', allowHashBang: true }, {
    onNode: (node) => {
      const operand = node.type === 'UnaryExpression' && node.operator === 'typeof' ? node.argument : null;
      if (operand !== null && isUnboundNameAccessor(operand)) edits.push({ start: operand.start, end: operand.end, text: '(void 0)' });
    },
  });
  return applySourceEdits(code, edits);
}

/** `__nimbusEsmScope.<name>` for a CommonJS wrapper name: what the define made a free reference to one. */
function isUnboundNameAccessor(node: AnyNode): boolean {
  return node.type === 'MemberExpression' && !node.computed && !node.optional
    && node.object.type === 'Identifier' && node.object.name === ES_MODULE_SCOPE_GLOBAL
    && node.property.type === 'Identifier' && COMMONJS_WRAPPER_NAMES.has(node.property.name);
}

/**
 * `source`, which Node runs as an ES module, as one to the transform whatever
 * its syntax: strict (a directive after any hashbang, on the first line, so
 * line numbers stay), and a module (an empty export after it), so its
 * top-level `this` is undefined.
 */
export function esModuleSource(source: string): string {
  const hashbang = source.startsWith('#!') ? (source.indexOf('\n') + 1 || source.length) : 0;
  return source.slice(0, hashbang) + '"use strict";' + source.slice(hashbang) + '\nexport {};\n';
}
