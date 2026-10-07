/**
 * module-format.ts — which module system Node runs a source under, as
 * doc/api/packages.md "Determining module system" defines it (Node 22, with
 * syntax detection on by default from v22.7.0).
 *
 * The answer decides whether a source is lowered to CommonJS before it runs
 * (every runtime here runs CommonJS: commonjs-cell.ts says why), so the shell's
 * `node`, the facet's entry and the lifo substrate's loader all ask it here.
 */
import { COMMONJS_WRAPPER_NAMES, containsModuleSyntax } from './javascript-ast.js';
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
 * module: as `--input-type` says, and without it by its syntax.
 */
export function isEsModuleInput(source: string, inputType: string | undefined): boolean {
  if (inputType === 'module') return true;
  if (inputType === 'commonjs') return false;
  return containsModuleSyntax(source);
}

/**
 * What a free reference to each CommonJS wrapper name becomes in an ES module
 * lowered to the CommonJS a facet runs (commonjs-cell.ts): a name bound
 * nowhere, so `typeof require` is 'undefined' and a call or read throws
 * ReferenceError, as in Node's ES module scope, while the lowering's own
 * require and module.exports still reach the wrapper's. The transform's
 * `define` (and the bounded rewrite's equivalent) applies it.
 */
export const ES_MODULE_UNBOUND_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  [...COMMONJS_WRAPPER_NAMES].map((name) => [name, `${name}_is_not_defined_in_ES_module_scope`]),
);

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
