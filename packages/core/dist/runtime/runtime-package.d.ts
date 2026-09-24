/**
 * runtime-package.ts — a runtime that arrived with the code, rather than over
 * the network.
 *
 * `nimbus install <name>` reads a catalog out of R2 and writes the result into
 * `~/.nimbus/runtimes/<name>/<version>/`. That is the Cloudflare deployment's
 * answer to "where do the bytes come from", and it needs a bucket, a binding
 * and a colo cache. An embedder who ran `npm i @nimbus-sh/runtime-bash` has
 * already answered the same question: the bytes are on disk beside their
 * manifest, fetched and integrity-checked by npm before any of this ran.
 *
 * So this is the second publisher, not the second package manager. It writes
 * the SAME tree at the SAME path from the SAME manifest — `installRoot()`,
 * `parseRuntimeManifest()`, one file per `manifest.files` entry — so
 * `listInstalledManifests` and `rehydrateInstalledRuntimes` cannot tell which
 * one ran, and a workspace behaves identically either way.
 *
 * Trust: R2 is verified against a digest chain rooted in a build-time pin
 * because `caches.default` is shared across tenants and R2 keys are not
 * content-addressed. A runtime package's root of trust is npm's own tarball
 * integrity, which the install already checked; from there the manifest's
 * per-file digests are re-verified here for exactly the reason the R2 path
 * verifies them — these blobs are interpreters, so bytes that reach the
 * filesystem are bytes that execute.
 */
import type { Awaitable } from './os-contracts.js';
export interface RuntimePackageFs {
    exists(path: string): Awaitable<boolean>;
    readFile(path: string): Awaitable<Uint8Array>;
    readFileString(path: string): Awaitable<string>;
    /** Clamped at EOF; never pins the bytes in a content cache. */
    readRangeUncached(path: string, offset: number, length: number): Awaitable<Uint8Array>;
    writeFile(path: string, data: string | Uint8Array): Awaitable<void>;
    writeRange(path: string, offset: number, bytes: Uint8Array): Awaitable<unknown>;
    rename(from: string, to: string): Awaitable<void>;
    mkdir(path: string, options?: {
        recursive?: boolean;
    }): Awaitable<void>;
    readdir(path: string): Awaitable<{
        name: string;
        type: string;
    }[]>;
    unlink(path: string): Awaitable<void>;
    rmdir(path: string): Awaitable<void>;
}
type CredentialedVfs = RuntimePackageFs;
import type { RuntimePackageAbi } from './os-contracts.js';
import { type ManifestFile, type RuntimeManifest } from './runtime-manifest.js';
/**
 * An installed npm package holding one runtime.
 *
 * The published packages (`@nimbus-sh/runtime-bash`,
 * `@nimbus-sh/runtime-cpython`) are the implementations; each is a manifest,
 * the content-addressed blobs it names, and the eight lines of `node:fs` that
 * read them. The port is here rather than in those packages because the
 * FILESYSTEM is what a runtime is, and this is the half that knows it.
 *
 * `readBlob` takes the whole manifest entry rather than a bare key, mirroring
 * `fetchBlob` in the Cloudflare catalog: a key and the digest that vouches for
 * it never travel as separate arguments, so there is no call in which they can
 * disagree.
 *
 * A blob may be a stream. The installer holds a blob a piece at a time
 * either way, but only a stream spares the package holding it whole.
 */
export interface RuntimePackage {
    readonly manifest: RuntimeManifest;
    readBlob(file: ManifestFile): RuntimeBlob | Promise<RuntimeBlob>;
}
export type RuntimeBlob = Uint8Array | ReadableStream<Uint8Array>;
/**
 * A blob whose bytes do not hash to its manifest digest. The installer reads
 * such a blob once more before refusing it; a source that caches blobs
 * throws this from its stream after evicting the entry that failed.
 */
export declare class RuntimeBlobDigestMismatch extends Error {
    readonly name = "RuntimeBlobDigestMismatch";
}
export interface SeededRuntime {
    readonly name: string;
    readonly version: string;
    /** VFS path of the install root, e.g. `home/user/.nimbus/runtimes/bash/5.2.37`. */
    readonly root: string;
    /** False when the runtime was already installed at `root` and nothing was written. */
    readonly written: boolean;
}
/** What the catalog can offer, without fetching one blob of it. */
export interface RuntimeAvailability {
    name: string;
    abi: RuntimePackageAbi;
    defaultVersion: string;
    /** In publish order, oldest first: version strings carry no order of their own. */
    versions: Array<{
        version: string;
        sizeBytes: number;
        license: string;
    }>;
}
/**
 * Where a runtime comes from. `resolve` answers a spec (`name`,
 * `name@version`, or any bin the runtime provides) with the package that
 * satisfies it, or null when nothing does.
 */
export interface RuntimeSource {
    list(): Promise<RuntimeAvailability[]>;
    resolve(spec: string): Promise<RuntimePackage | null>;
}
export declare function splitRuntimeSpec(spec: string): {
    name: string;
    versionOverride: string | null;
};
/**
 * Runtimes replaced by another implementation, keyed by the name users type.
 *
 * `python` was Pyodide and is now CPython for wasm32-wasi. The redirection
 * lives in code rather than a catalog `default` because the catalog is shared
 * with production deployments that still register the old runner. An explicit
 * `python@<version>` is a deliberate request and bypasses this entirely.
 */
export declare const SUPERSEDED_RUNTIMES: Readonly<Record<string, string>>;
/**
 * The runtime source made of packages an embedder already holds. Specs match
 * by name, by `name@version`, and by every bin `runtimeEntrypoints` declares —
 * so `python3`, `pip` and `wasm-ld` resolve to their runtime with no
 * hand-maintained alias map.
 */
export declare function suppliedRuntimeSource(packages: readonly RuntimePackage[]): RuntimeSource;
/**
 * One source out of several: each spec tries every source in order and the
 * first non-null answer wins. Listing concatenates in the same order, so a
 * supplied package shadows a catalog entry of the same name.
 */
export declare function composeRuntimeSources(sources: readonly RuntimeSource[]): RuntimeSource;
/**
 * Write a runtime package into the filesystem as an install.
 *
 * `manifest.json` is written LAST: its presence is what
 * `listInstalledManifests` takes as "install completed", so a tree that stops
 * partway lists as nothing and retries cleanly. Before any payload write the
 * marker is invalidated — `force` and a previously-interrupted tree share
 * this path — but the tree itself is NEVER removed: an install root may hold
 * files the manifest does not declare (pip's site-packages, a host's own
 * additions), and the old R2 installer's `--reinstall` never deleted them
 * either. A manifest already at the root is reused only when it parses to
 * the identical manifest and every payload file verifies against its digest
 * — the legacy R2 installer wrote the manifest first, so its interrupted
 * trees fail this check and are rewritten rather than reported as installed.
 *
 * Each blob streams through a digest into a sibling `.nimbus-partial` file
 * that is renamed into place only once its digest matches: an install holds
 * pieces of blobs, never a whole one, and bytes that fail their digest never
 * sit at a path a runner would execute.
 */
export declare function seedRuntimePackage(vfs: CredentialedVfs, homeDir: string, runtimePackage: RuntimePackage, options?: {
    force?: boolean;
    /** One line per payload file, as it lands. */
    onProgress?: (line: string) => void;
}): Promise<SeededRuntime>;
/** A blob in {@link RUNTIME_BLOB_PIECE_BYTES} pieces; a stream abandoned
 *  partway is cancelled, so no read outlives the install that started it. */
export declare function blobPieces(blob: RuntimeBlob): AsyncGenerator<Uint8Array>;
export {};
//# sourceMappingURL=runtime-package.d.ts.map