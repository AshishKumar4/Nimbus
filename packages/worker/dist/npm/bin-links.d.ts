import type { ProjectFs } from '../runtime/project-fs.js';
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
type VfsLike = Pick<ProjectFs, 'exists' | 'isDirectory' | 'readFileString' | 'readdir'>;
type WritableVfsLike = VfsLike & Pick<ProjectFs, 'mkdir' | 'writeFile' | 'chmod'>;
export declare function npmBinDirPath(nodeModulesPath: string): string;
export declare function npmBinManifestPath(nodeModulesPath: string): string;
export declare function createNpmBinManifest(entries: NpmBinEntry[]): NpmBinManifest;
export declare function createNpmBinShim(entry: NpmBinEntry, shimDir: string): string;
export declare function packageBinEntries(pkg: ResolvedPackage, nodeModulesPath: string): NpmBinEntry[];
export declare function resolveNpmBin(vfs: VfsLike, cwd: string, name: string): Promise<NpmBinResolution | null>;
export declare function resolveNpmBinFromPath(vfs: VfsLike, cwd: string, envPath: string, name: string): Promise<NpmBinResolution | null>;
/** A path-shaped invocation of an executable entry in a `node_modules/.bin` directory; null otherwise. */
export declare function resolveNpmBinPath(vfs: VfsLike & Pick<ProjectFs, 'stat'>, cwd: string, path: string): Promise<NpmBinResolution | null>;
export declare function materializeNpmBinShims(vfs: WritableVfsLike, nodeModulesPath: string, binDir: string): Promise<number>;
export {};
//# sourceMappingURL=bin-links.d.ts.map