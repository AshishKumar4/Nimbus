/**
 * package-manager.ts — `nimbus install <runtime>` shell verb.
 *
 * Subcommands (all under `nimbus install`):
 *
 *   nimbus install <name>                 install latest of <name>
 *   nimbus install <name>@<version>       install specific version
 *   nimbus install --list                 show installed runtimes
 *   nimbus install --available            show catalog of installables
 *   nimbus install --reinstall <name>     force refetch
 *   nimbus uninstall <name>               remove installed runtime
 *
 * Per-user VFS layout:
 *
 *   ~/.nimbus/runtimes/<name>/<version>/
 *     manifest.json
 *     bin/<entry>
 *     share/<name>/...
 *     LICENSE
 *
 * Survives DO eviction (SqliteFS-backed). Boot-time rehydration reads
 * every `~/.nimbus/runtimes/STAR/STAR/manifest.json` and re-registers
 * each `entrypoints[].binName` as a shell command pointing at the
 * named runner factory.
 *
 * Errors throw and bubble up to the user as a single diagnostic line.
 */
import { type RuntimeCatalogEnv, type RuntimeManifest } from './runtime-catalog.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
/** Minimal shell-registry shape we depend on. */
export interface MinShellRegistry {
    register(name: string, handler: (ctx: any) => Promise<number>): void;
    unregister?(name: string): void;
    resolve?(name: string): any;
}
/** Runner-factory contract. Each registered runner produces a shell-
 *  command handler given the manifest + the installed root dir. The
 *  package manager invokes the factory at install-time + at boot-time
 *  rehydration. */
export type RunnerFactory = (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) => (ctx: any) => Promise<number>;
export declare function registerRunnerFactory(key: string, factory: RunnerFactory): void;
export declare function getRegisteredRunners(): string[];
export interface RuntimeInstallSummary {
    spec: string;
    exitCode: number;
    stdout: string;
    stderr: string;
}
export interface RuntimeSummary {
    name: string;
    version: string;
    root: string;
    bins: string[];
    sizeBytes: number;
    license: string;
}
/** Compute the per-user install root for (name, version). Uses
 *  `process.env.HOME` if present; falls back to `/home/user`. */
export declare function installRoot(homeDir: string, name: string, version: string): string;
/** Read all installed manifests off SqliteFS. Used by both `--list`
 *  and boot-time rehydration. */
export declare function listInstalledManifests(vfs: SqliteVFS, homeDir: string): Array<{
    root: string;
    manifest: RuntimeManifest;
}>;
/**
 * Re-register every installed runtime's entrypoints in the shell
 * registry. Call once at session-init time after all runner factories
 * are registered (init.ts:registerRunnerFactory blocks).
 */
export declare function rehydrateInstalledRuntimes(vfs: SqliteVFS, registry: MinShellRegistry, homeDir: string): {
    count: number;
    bins: string[];
};
export declare function listInstalledRuntimes(vfs: SqliteVFS, homeDir: string): RuntimeSummary[];
export declare function listAvailableRuntimes(env: RuntimeCatalogEnv): Promise<Array<{
    name: string;
    defaultVersion: string;
    versions: Array<{
        version: string;
        sizeBytes: number;
        license: string;
    }>;
}>>;
export declare function installRuntimeProgrammatic(deps: {
    env: RuntimeCatalogEnv;
    vfs: SqliteVFS;
    registry: MinShellRegistry;
    getHome(): string;
}, spec: string, opts?: {
    force?: boolean;
}): Promise<RuntimeInstallSummary>;
export declare function ensureRuntimesProgrammatic(deps: {
    env: RuntimeCatalogEnv;
    vfs: SqliteVFS;
    registry: MinShellRegistry;
    getHome(): string;
}, specs: string[], opts?: {
    force?: boolean;
}): Promise<RuntimeInstallSummary[]>;
/**
 * Build the shell-command handler that implements `nimbus install …`,
 * `nimbus uninstall …`. Registered under the name `nimbus`.
 */
export declare function makeNimbusVerbHandler(deps: {
    env: RuntimeCatalogEnv;
    vfs: SqliteVFS;
    registry: MinShellRegistry;
    /** Returns `process.env.HOME` for the session. Computed by the
     *  caller (init.ts) from the shell env. */
    getHome(): string;
}): (ctx: any) => Promise<number>;
//# sourceMappingURL=package-manager.d.ts.map