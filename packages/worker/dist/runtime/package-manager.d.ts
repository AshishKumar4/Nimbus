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
import { type RuntimeCatalogEnv, type RuntimeManifest, type ManifestEntrypoint } from './runtime-catalog.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { type RuntimePackageAbi } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CommandContext } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
/** Minimal shell ctx shape we depend on (matches existing handlers). */
export interface ShellCtx extends Pick<CommandContext, 'pid' | 'cred' | 'setUmask' | 'runAs'> {
    args: string[];
    env: Record<string, string>;
    cwd: string;
    stdout: {
        write(s: string): void;
    };
    stderr: {
        write(s: string): void;
    };
}
/** Minimal shell-registry shape we depend on. */
export interface MinShellRegistry {
    register(name: string, handler: (ctx: any) => Promise<number>): void;
    unregister?(name: string): void;
    resolve?(name: string): any;
}
export interface RuntimeWarmTarget {
    name: string;
    version: string;
    root: string;
    manifest: RuntimeManifest;
}
export type RuntimeWarmHook = (target: RuntimeWarmTarget, ctx: ShellCtx) => Promise<void>;
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
    abi: RuntimePackageAbi;
    bins: string[];
    sizeBytes: number;
    license: string;
}
export declare function runtimeAbiForManifest(manifest: RuntimeManifest): RuntimePackageAbi;
export interface RuntimeInstallTarget {
    runtimeName: string;
    versionOverride: string | null;
    requestedName: string;
}
export interface RuntimeCommandHint {
    command: string;
    runtimeName: string;
    installSpec: string;
}
/**
 * Commands a runtime provides beyond its manifest entrypoints. The
 * python/ruby package-manager front-ends (pip, gem, bundler) ride the
 * language runner rather than shipping as manifest files, and already-
 * deployed R2 manifests cannot retroactively declare them.
 *
 * This is the ONE hand-maintained command table: install aliasing
 * (`nimbus install pip` → python), command-not-found hints, and bin
 * registration all derive from `runtimeEntrypoints`, which merges this
 * with the catalog manifest. Catalog-declared aliases (python3, ruby3,
 * wasm-ld, …) come from manifest entrypoints and must NOT be repeated
 * here. Mechanically validated against `NIMBUS_RUNTIME_ABIS` by
 * tests/unit/runtime-command-aliases.mjs.
 */
export declare const RUNTIME_EXTRA_ENTRYPOINTS: Readonly<Record<string, readonly ManifestEntrypoint[]>>;
export declare function createRuntimeCommandHintResolver(env: RuntimeCatalogEnv): (command: string) => Promise<RuntimeCommandHint | null>;
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
    abi: RuntimePackageAbi;
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
    warmRuntime?: RuntimeWarmHook;
}): (ctx: any) => Promise<number>;
//# sourceMappingURL=package-manager.d.ts.map