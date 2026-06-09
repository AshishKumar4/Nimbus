import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { ResolvedPackage } from './resolver.js';
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
type VfsLike = Pick<SqliteVFS, 'exists' | 'isDirectory' | 'readFileString' | 'readdir'>;
type WritableVfsLike = VfsLike & Pick<SqliteVFS, 'mkdir' | 'writeFile'>;
export declare function npmBinDirPath(nodeModulesPath: string): string;
export declare function npmBinManifestPath(nodeModulesPath: string): string;
export declare function createNpmBinManifest(entries: NpmBinEntry[]): NpmBinManifest;
export declare function createNpmBinShim(entry: NpmBinEntry): string;
export declare function packageBinEntries(pkg: ResolvedPackage, nodeModulesPath: string): NpmBinEntry[];
export declare function resolveNpmBin(vfs: VfsLike, cwd: string, name: string): NpmBinResolution | null;
export declare function resolveNpmBinFromPath(vfs: VfsLike, cwd: string, envPath: string, name: string): NpmBinResolution | null;
export declare function materializeNpmBinShims(vfs: WritableVfsLike, nodeModulesPath: string, binDir: string): number;
export {};
//# sourceMappingURL=bin-links.d.ts.map