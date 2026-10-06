/**
 * bundler-resolution.ts — how Nimbus's bundles resolve a module: the
 * pre-bundle of an npm package (prebundle-slice.ts, over the slice it was
 * handed) and EsbuildService's builds (its VFS plugin, over the session's
 * filesystem). One algorithm over either filesystem, so the two cannot
 * disagree about which file an import names.
 *
 * Bundler policy, not Node's CommonJS one (require-resolution.ts): a file
 * as named, then with each of EXTS appended (TypeScript before JavaScript);
 * a `.js`-family name whose file is not there is tried as its TypeScript
 * twin (moduleResolution "bundler"); then a directory's index. A bare
 * specifier walks up `node_modules`, selecting by `exports` under the
 * import's conditions (`require` for a require call, `import` otherwise, and
 * `browser` either way), then a subpath as a file, then `index`. A `#name`
 * resolves against the `imports` of the nearest package.json alone, as Node
 * and esbuild read it.
 */

import { resolveExports, resolvePackageEntry, type ResolvablePackageJson } from '../_shared/exports-resolver.js';
import { normalizeVfsPath } from '../vfs/path.js';
import type { Awaitable } from '../vfs/vfs.js';

/** The filesystem a resolution reads, by absolute `/`-rooted path. */
export interface BundlerResolveFs {
  isFile(path: string): Awaitable<boolean>;
  isDirectory(path: string): Awaitable<boolean>;
  /** The file's text, or null when it cannot be read. */
  readText(path: string): Awaitable<string | null>;
}

const BUNDLER_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cjs', '.json', '.css'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs'];
/** A `.js`-family name's TypeScript twins, in the order TypeScript tries them. */
const TYPESCRIPT_TWINS: Record<string, string[]> = { js: ['.ts', '.tsx'], jsx: ['.tsx', '.ts'], mjs: ['.mts', '.ts'], cjs: ['.cts', '.ts'] };

/**
 * The conditions for an import of `kind` (esbuild's ImportKind). A require
 * call selects `require`: a package that ships a CommonJS file beside an
 * ESM one for the same export (@babel/runtime/helpers/*, whose ESM file
 * declares only `export { fn as default }`) would otherwise hand a CommonJS
 * caller `{ default: fn }`, and calling what it required crashes.
 */
export function bundlerConditions(kind: string | undefined): string[] {
  return kind === 'require-call' || kind === 'require-resolve' ? BUNDLER_REQUIRE_CONDITIONS : BUNDLER_IMPORT_CONDITIONS;
}

/** The conditions of an import (and a pre-bundle's own build options). */
export const BUNDLER_IMPORT_CONDITIONS = ['import', 'module', 'browser', 'default'];
const BUNDLER_REQUIRE_CONDITIONS = ['require', 'node', 'browser', 'default'];

export interface BundlerResolver {
  /** The file `base` names, by extension, TypeScript twin, then directory index. */
  resolveFile(base: string): Promise<string | null>;
  /** A `#name` from a module in `fromDir`. */
  resolvePackageImport(specifier: string, fromDir: string): Promise<string | null>;
  /** A bare specifier from a module in `fromDir`. */
  resolveBarePackage(specifier: string, fromDir: string, conditions: string[]): Promise<string | null>;
}

export function createBundlerResolver(fs: BundlerResolveFs): BundlerResolver {
  const packageJson = async (path: string): Promise<(ResolvablePackageJson & { imports?: unknown }) | null> => {
    if (!(await fs.isFile(path))) return null;
    const text = await fs.readText(path);
    if (text === null) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed !== null && typeof parsed === 'object' ? parsed as ResolvablePackageJson : null;
    } catch {
      return null;
    }
  };

  const resolveFile = async (base: string): Promise<string | null> => {
    const path = '/' + normalizeVfsPath(base);
    for (const ext of BUNDLER_EXTENSIONS) if (await fs.isFile(path + ext)) return path + ext;
    const named = /\.(js|mjs|cjs|jsx)$/.exec(path);
    if (named) {
      const stem = path.slice(0, path.length - named[0].length);
      for (const ext of TYPESCRIPT_TWINS[named[1]]) if (await fs.isFile(stem + ext)) return stem + ext;
    }
    if (await fs.isDirectory(path)) {
      for (const index of INDEX_FILES) if (await fs.isFile(path + '/' + index)) return path + '/' + index;
    }
    return null;
  };

  /** `/`-rooted `dir` and each directory above it, the root excluded. */
  const ancestors = function* (dir: string): Generator<string> {
    for (let at = normalizeVfsPath(dir); at; at = at.slice(0, Math.max(0, at.lastIndexOf('/')))) yield '/' + at;
  };

  return {
    resolveFile,

    async resolvePackageImport(specifier, fromDir) {
      for (const dir of ancestors(fromDir)) {
        if (!(await fs.isFile(dir + '/package.json'))) continue;
        const pkg = await packageJson(dir + '/package.json');
        const target = pkg?.imports ? resolveExports(pkg.imports as ResolvablePackageJson['exports'], specifier) : null;
        return target ? resolveFile(dir + '/' + target.replace(/^\.\//, '')) : null;
      }
      return null;
    },

    async resolveBarePackage(specifier, fromDir, conditions) {
      const parts = specifier.split('/');
      const nameLength = specifier.startsWith('@') ? 2 : 1;
      const name = parts.slice(0, nameLength).join('/');
      const subpath = parts.slice(nameLength).join('/');
      for (const dir of ancestors(fromDir)) {
        const packageDir = dir + '/node_modules/' + name;
        if (!(await fs.isDirectory(packageDir))) continue;
        const pkg = await packageJson(packageDir + '/package.json');
        const entry = pkg ? resolvePackageEntry(pkg, subpath ? './' + subpath : '.', conditions) : null;
        const resolved = (entry && await resolveFile(packageDir + '/' + entry.replace(/^\.\//, '')))
          || (subpath && await resolveFile(packageDir + '/' + subpath))
          || await resolveFile(packageDir + '/index');
        if (resolved) return resolved;
      }
      return null;
    },
  };
}
