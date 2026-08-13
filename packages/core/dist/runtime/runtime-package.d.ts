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
import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
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
 */
export interface RuntimePackage {
    readonly manifest: RuntimeManifest;
    readBlob(file: ManifestFile): Uint8Array | Promise<Uint8Array>;
}
export interface SeededRuntime {
    readonly name: string;
    readonly version: string;
    /** VFS path of the install root, e.g. `home/user/.nimbus/runtimes/bash/5.2.37`. */
    readonly root: string;
    /** False when the runtime was already installed at `root` and nothing was written. */
    readonly written: boolean;
}
/**
 * Write a runtime package into the filesystem as an install.
 *
 * Idempotent on the same rule the package manager uses: a `manifest.json`
 * already at the install root means the install completed, and the root
 * carries the version, so a package upgrade lands beside its predecessor
 * rather than half over it.
 */
export declare function seedRuntimePackage(vfs: CredentialedVfs, homeDir: string, runtimePackage: RuntimePackage): Promise<SeededRuntime>;
//# sourceMappingURL=runtime-package.d.ts.map