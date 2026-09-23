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
 * Nothing here fetches. Where a runtime came FROM is the caller's
 * RuntimeSource; a runtime that is already installed is the same runtime
 * whichever publisher put it there. Nothing here is process-global either:
 * the runner table and the singleflight live on the workspace's
 * RuntimeManager (runtime-manager.ts), because two workspaces in one process
 * must not share either.
 */
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { RuntimePackageFs as CredentialedVfs } from './runtime-package.js';
import type { Command } from '../substrate/lifo/commands/types.js';
import { type RuntimePackageAbi } from './os-contracts.js';
import { type ManifestEntrypoint, type RuntimeManifest } from './runtime-manifest.js';
/** Minimal shell-registry shape we depend on. */
export interface MinShellRegistry {
    register(name: string, handler: Command): void;
    unregister?(name: string): void;
    has?(name: string): boolean;
    resolve?(name: string): Promise<Command | null | undefined> | Command | null | undefined;
}
/** Runner-factory contract. Each registered runner produces a shell-
 *  command handler given the manifest + the installed root dir. The
 *  package manager invokes the factory at install-time + at boot-time
 *  rehydration. */
export type RunnerFactory = (manifest: RuntimeManifest, installRoot: string, binName: string, binKind: string | undefined) => Command | Promise<Command>;
/**
 * How a manifest entrypoint's `runner` key is resolved to code.
 * The map is owned by the workspace's RuntimeManager.
 */
export type RunnerLookup = (key: string) => RunnerFactory | undefined;
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
export declare function listInstalledManifests(vfs: SqliteVFS, homeDir: string): Promise<Array<{
    root: string;
    manifest: RuntimeManifest;
}>>;
export declare function listInstalledManifestsView(fs: CredentialedVfs, homeDir: string): Promise<Array<{
    root: string;
    manifest: RuntimeManifest;
}>>;
/**
 * Runtime blobs are read and written in whole 64 KiB VFS chunks, eight at a
 * time: an append then touches no chunk it does not replace, and stays inside
 * one SQLite transaction's 1 MiB blob bound.
 */
export declare const RUNTIME_BLOB_PIECE_BYTES: number;
/**
 * An installed tree is trustworthy when its manifest parses and every payload
 * file it declares is present with the digest the manifest vouches for.
 *
 * Digest-verified rather than size-verified because the tree's manifest is
 * what rehydration binds commands to: a same-size corruption or a rewritten
 * entrypoints table is a different runtime than the one that was installed,
 * trusting it would run bytes nobody published. One piece of one file at a
 * time — these are interpreters, tens of megabytes each.
 */
export declare function runtimePayloadIntact(fs: CredentialedVfs, root: string, manifest: RuntimeManifest): Promise<boolean>;
/**
 * Re-register every VERIFIED installed runtime's entrypoints in the shell
 * registry. A tree that fails the payload check is not bound: it may be a
 * legacy manifest-first install interrupted mid-write or a corruption, and
 * the manager's install path repairs it on demand rather than running it.
 */
export declare function rehydrateInstalledRuntimesView(vfs: CredentialedVfs, registry: MinShellRegistry, homeDir: string, runnerFor: RunnerLookup): Promise<{
    count: number;
    bins: string[];
}>;
export declare function listInstalledRuntimes(vfs: SqliteVFS, homeDir: string): Promise<RuntimeSummary[]>;
//# sourceMappingURL=installed-runtimes.d.ts.map