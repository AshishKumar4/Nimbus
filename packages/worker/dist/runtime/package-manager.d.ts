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
import { type RuntimeCatalogEnv } from './runtime-catalog.js';
import { type RuntimeManifest } from '@nimbus-sh/core/runtime/runtime-manifest.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { type RuntimePackageAbi } from '@nimbus-sh/core/runtime/os-contracts.js';
import { type MinShellRegistry } from '@nimbus-sh/core/runtime/installed-runtimes.js';
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
export interface RuntimeWarmTarget {
    name: string;
    version: string;
    root: string;
    manifest: RuntimeManifest;
}
export type RuntimeWarmHook = (target: RuntimeWarmTarget, ctx: ShellCtx) => Promise<void>;
export interface RuntimeInstallSummary {
    spec: string;
    exitCode: number;
    stdout: string;
    stderr: string;
}
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
export declare function createRuntimeCommandHintResolver(env: RuntimeCatalogEnv): (command: string) => Promise<RuntimeCommandHint | null>;
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