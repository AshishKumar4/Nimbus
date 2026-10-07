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
import type { Awaitable } from '../vfs/vfs.js';
/** The filesystem a resolution reads, by absolute `/`-rooted path. */
export interface BundlerResolveFs {
    isFile(path: string): Awaitable<boolean>;
    isDirectory(path: string): Awaitable<boolean>;
    /** The file's text, or null when it cannot be read. */
    readText(path: string): Awaitable<string | null>;
}
/**
 * The conditions for an import of `kind` (esbuild's ImportKind). A require
 * call selects `require`: a package that ships a CommonJS file beside an
 * ESM one for the same export (@babel/runtime/helpers/*, whose ESM file
 * declares only `export { fn as default }`) would otherwise hand a CommonJS
 * caller `{ default: fn }`, and calling what it required crashes.
 */
export declare function bundlerConditions(kind: string | undefined): string[];
/** The conditions of an import (and a pre-bundle's own build options). */
export declare const BUNDLER_IMPORT_CONDITIONS: string[];
export interface BundlerResolver {
    /** The file `base` names, by extension, TypeScript twin, then directory index. */
    resolveFile(base: string): Promise<string | null>;
    /** A `#name` from a module in `fromDir`. */
    resolvePackageImport(specifier: string, fromDir: string): Promise<string | null>;
    /** A bare specifier from a module in `fromDir`. */
    resolveBarePackage(specifier: string, fromDir: string, conditions: string[]): Promise<string | null>;
}
export declare function createBundlerResolver(fs: BundlerResolveFs): BundlerResolver;
//# sourceMappingURL=bundler-resolution.d.ts.map