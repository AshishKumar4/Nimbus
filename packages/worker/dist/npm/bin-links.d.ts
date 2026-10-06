import { type ProjectFs } from '../runtime/project-fs.js';
import type { ResolvedPackage } from './resolver.js';
/**
 * A staged-artifact bin target (`nimbus-staged:<artifact>`) is a sentinel,
 * not a VFS path: the runnable bundle lives in the static-assets layer and is
 * fetched at exec time. It must NOT be resolved against the VFS.
 */
export declare function isStagedArtifactTarget(target: string): boolean;
export declare function stagedArtifactId(target: string): string;
/** The bin manifest a `.nimbus-bin-map.json` holds; null when it is not one, or names a file outside `.bin`. */
export declare function parseNpmBinManifest(text: string): NpmBinManifest | null;
export declare const NPM_BIN_MANIFEST_VERSION = 1;
export declare const NPM_BIN_MANIFEST_NAME = ".nimbus-bin-map.json";
export interface NpmBinEntry {
    name: string;
    packageName: string;
    packageVersion: string;
    packagePath: string;
    targetPath: string;
}
export interface NpmBinManifest {
    version: typeof NPM_BIN_MANIFEST_VERSION;
    bins: Record<string, NpmBinEntry>;
}
export interface NpmBinResolution extends NpmBinEntry {
    shimPath: string;
}
/**
 * What bins are looked up and linked through: a project's filesystem as the
 * caller (see runtime/project-fs.ts), each call answered at once by the
 * engine or awaited through the caller's view of the namespace.
 */
type VfsLike = Pick<ProjectFs, 'exists' | 'isDirectory' | 'readFileString' | 'readdir' | 'lstat'>;
type WritableVfsLike = VfsLike & Pick<ProjectFs, 'mkdir' | 'writeFile' | 'chmod'>;
/** What validating a bin's target reads. */
type BinTargetFs = Pick<VfsLike, 'exists' | 'isDirectory'>;
export declare function npmBinDirPath(nodeModulesPath: string): string;
export declare function npmBinManifestPath(nodeModulesPath: string): string;
export declare function createNpmBinManifest(entries: NpmBinEntry[]): NpmBinManifest;
export declare function createNpmBinShim(entry: NpmBinEntry, shimDir: string): string;
export declare function packageBinEntries(pkg: ResolvedPackage, nodeModulesPath: string): NpmBinEntry[];
/**
 * The names the package at `packagePath` declares in `bin`, as npm reads its
 * package.json (npmBinMap), whether or not their targets exist: what an
 * install links, and what removing the package unlinks.
 */
export declare function declaredPackageBins(vfs: Pick<VfsLike, 'readFileString'>, packagePath: string): Promise<string[]>;
/**
 * The bin `npx` runs from the package at `packagePath` for `binName`, as a
 * linked bin is validated (target present, `.js`/`.cjs`/`.mjs` probed, a
 * staged-artifact sentinel passed through). A package that maps `bin` names
 * runs its first entry when none is `binName`, as npm runs a single-binary
 * package; a string `bin` runs only under the package's own name.
 */
export declare function npxPackageBin(vfs: BinTargetFs & Pick<VfsLike, 'readFileString'>, packagePath: string, binName: string): Promise<NpmBinEntry | null>;
export declare function resolveNpmBin(vfs: VfsLike, cwd: string, name: string): Promise<NpmBinResolution | null>;
/**
 * A path-shaped invocation of an npm bin shim: an executable entry of a
 * `node_modules/.bin` directory, or one a bin directory's manifest names
 * (where `npm i -g` links them onto PATH); null for any other file.
 */
export declare function resolveNpmBinPath(vfs: VfsLike & Pick<ProjectFs, 'stat'>, cwd: string, path: string): Promise<NpmBinResolution | null>;
export declare function materializeNpmBinShims(vfs: WritableVfsLike, nodeModulesPath: string, binDir: string): Promise<number>;
export {};
//# sourceMappingURL=bin-links.d.ts.map