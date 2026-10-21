/**
 * module-format.ts — which module system Node runs a source under, as
 * doc/api/packages.md "Determining module system" defines it (Node 22, with
 * syntax detection on by default from v22.7.0).
 *
 * The answer decides whether a source runs as an ES module (native-esm.ts)
 * or as CommonJS, so the shell's `node`, the facet's entry and the lifo
 * substrate's loader all ask it here.
 */
import { containsModuleSyntax } from './javascript-ast.js';
import { vfsPathExtension } from '../vfs/path.js';
import { stripsTypeScript } from '../_shared/typescript-specifiers.js';

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

/** Node 22.23.4's get_format.js for TypeScript; `stripped` is read only for a typeless `.ts`. */
export function typeScriptFormat(path: string, packageType: () => PackageType, stripped: () => string): 'module' | 'commonjs' | null {
  if (!stripsTypeScript(path)) return null;
  const ext = vfsPathExtension(path);
  if (ext === '.mts') return 'module';
  if (ext === '.cts') return 'commonjs';
  const type = packageType();
  if (type !== null) return type;
  return containsModuleSyntax(stripped()) ? 'module' : 'commonjs';
}

/**
 * TypeScript Node does not strip (`--no-experimental-strip-types`) run as the
 * program's entry: Node's ES loader takes it under `--import`, in a type:module
 * package or with module syntax (run_main.js), and refuses its extension;
 * otherwise its CommonJS loader runs it as JavaScript. Required, such a file is
 * the CommonJS loader's whatever its package (its .js handler reads the type of
 * .js alone): an ES module by its syntax.
 */
export function typeScriptEntryRefused(packageType: PackageType, source: string, imports: boolean): boolean {
  return imports || packageType === 'module' || containsModuleSyntax(source);
}

/** Node refuses to strip a file under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). */
export function typeScriptUnderNodeModules(path: string): boolean {
  return /(^|\/)node_modules\//.test(path);
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
 * Whose scope a runtime runs an ES module in. Node's binds none of
 * CommonJS's wrapper names. Bun's binds `require`, `__filename` and
 * `__dirname` in every module (bun.sh/docs/runtime/modules), which a staged
 * module imports from its meta instance (native-esm.ts EsModuleLink).
 */
export type ModuleScope = 'node' | 'bun';
