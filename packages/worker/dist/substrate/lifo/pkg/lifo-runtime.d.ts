/**
 * Lifo Runtime -- enhanced execution context for lifo-native packages.
 *
 * Packages with a "lifo" field in package.json get this runtime instead of
 * the plain CJS node runner.  It provides:
 *   - lifo.import()   – load ESM modules from a configurable CDN (default esm.sh)
 *   - lifo.loadWasm() – load startup-registered WebAssembly modules
 *   - lifo.resolve()  – resolve a path relative to cwd
 */
import type { Command } from '../commands/types.js';
import type { VFS } from '../kernel/vfs/index.js';
export interface LifoPackageManifest {
    commands: Record<string, string>;
}
export interface LifoAPI {
    /** Import an ESM module from CDN.  Cached after first load. */
    import(specifier: string): Promise<unknown>;
    /** Load a WebAssembly module registered during Worker startup. */
    loadWasm(url: string): Promise<WebAssembly.Module>;
    /** Resolve a path relative to the command's cwd. */
    resolve(path: string): string;
    /** The CDN base URL currently in use. */
    readonly cdn: string;
}
export declare function registerLifoWasmModule(url: string, module: WebAssembly.Module): void;
/**
 * Create a Command that executes a lifo-native package entry.
 *
 * Supports two module formats:
 *   - ESM: import/export syntax → loaded through a data URL module
 *   - CJS: module.exports = async function(ctx, lifo) { ... }
 */
export declare function createLifoCommand(entryPath: string, vfs: VFS): Command;
export interface LifoPackageJson {
    name?: string;
    version?: string;
    lifo?: LifoPackageManifest;
    bin?: string | Record<string, string>;
}
/**
 * Read a package.json and return the lifo manifest if present.
 */
export declare function readLifoManifest(vfs: VFS, pkgDir: string): LifoPackageManifest | null;
//# sourceMappingURL=lifo-runtime.d.ts.map