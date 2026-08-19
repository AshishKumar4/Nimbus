/**
 * installed-runtimes.ts — the runtimes a session already has, and the shell
 * commands they answer.
 *
 * `nimbus install <name>` unpacks a runtime into
 * `~/.nimbus/runtimes/<name>/<version>/` and this is what reads it back: the
 * manifests on disk, the runner each entrypoint names, and the registration
 * that turns the pair into an invokable command. It runs at install time and
 * again at every boot, because a Durable Object that was evicted comes back
 * with the filesystem and none of the registry.
 *
 * Nothing here fetches. Where a runtime came FROM — an R2 bucket and a digest
 * chain in the Cloudflare deployment — is `@nimbus-sh/worker`'s
 * `runtime/package-manager.ts`; a runtime that is already installed is the
 * same runtime whichever publisher put it there, so an embedder that seeds the
 * tree itself gets working commands out of this with nothing else in play.
 */
import type { CredentialedVfs, SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { Command } from '../substrate/lifo/commands/types.js';
import { type RuntimePackageAbi } from './os-contracts.js';
import { type ManifestEntrypoint, type RuntimeManifest } from './runtime-manifest.js';
/** Minimal shell-registry shape we depend on. */
export interface MinShellRegistry {
    register(name: string, handler: Command): void;
    unregister?(name: string): void;
    resolve?(name: string): Promise<Command | null | undefined> | Command | null | undefined;
}
/** Runner-factory contract. Each registered runner produces a shell-
 *  command handler given the manifest + the installed root dir. The
 *  package manager invokes the factory at install-time + at boot-time
 *  rehydration. */
export type RunnerFactory = (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) => Command;
/**
 * How a manifest entrypoint's `runner` key is resolved to code.
 *
 * A parameter rather than a fixed lookup because the process-global table
 * below is a property of the Cloudflare session, not of the idea: a factory
 * closes over one session's filesystem and one session's facet host, so an
 * embedder holding two workspaces in one process must be able to give each its
 * own without the second silently retargeting the first.
 */
export type RunnerLookup = (key: string) => RunnerFactory | undefined;
export declare function registerRunnerFactory(key: string, factory: RunnerFactory): void;
export declare function getRegisteredRunners(): string[];
/** The factory a manifest entrypoint's `runner` names, or undefined. */
export declare function runnerFactoryFor(key: string): RunnerFactory | undefined;
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
export declare function runtimeEntrypoints(manifest: RuntimeManifest): RuntimeManifest['entrypoints'];
/** Compute the per-user install root for (name, version). Uses
 *  `process.env.HOME` if present; falls back to `/home/user`. */
export declare function installRoot(homeDir: string, name: string, version: string): string;
/** Read all installed manifests off SqliteFS. Used by both `--list`
 *  and boot-time rehydration. */
export declare function listInstalledManifests(vfs: SqliteVFS, homeDir: string): Array<{
    root: string;
    manifest: RuntimeManifest;
}>;
export declare function listInstalledManifestsView(fs: CredentialedVfs, homeDir: string): Array<{
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
export declare function rehydrateInstalledRuntimesView(vfs: CredentialedVfs, registry: MinShellRegistry, homeDir: string, runnerFor: RunnerLookup): {
    count: number;
    bins: string[];
};
export declare function listInstalledRuntimes(vfs: SqliteVFS, homeDir: string): RuntimeSummary[];
//# sourceMappingURL=installed-runtimes.d.ts.map