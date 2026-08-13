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
import { sha256Hex } from '../_shared/crypto.js';
import { installRoot } from './installed-runtimes.js';
import { parseRuntimeManifest, } from './runtime-manifest.js';
/**
 * Write a runtime package into the filesystem as an install.
 *
 * Idempotent on the same rule the package manager uses: a `manifest.json`
 * already at the install root means the install completed, and the root
 * carries the version, so a package upgrade lands beside its predecessor
 * rather than half over it.
 */
export async function seedRuntimePackage(vfs, homeDir, runtimePackage) {
    const manifest = parseRuntimeManifest(runtimePackage.manifest);
    const root = installRoot(homeDir, manifest.name, manifest.version);
    if (vfs.exists(`${root}/manifest.json`)) {
        return { name: manifest.name, version: manifest.version, root, written: false };
    }
    vfs.mkdir(root, { recursive: true });
    for (const file of manifest.files) {
        const target = `${root}/${file.path}`;
        const parent = target.slice(0, target.lastIndexOf('/'));
        if (!vfs.exists(parent))
            vfs.mkdir(parent, { recursive: true });
        vfs.writeFile(target, await verifiedBlob(manifest, runtimePackage, file));
    }
    // Last, where the R2 installer writes it first: that one has `--reinstall`
    // to force a redo, and this one has no verb at all, so a manifest sitting
    // beside a half-written tree would report a broken runtime as installed for
    // the life of the filesystem.
    vfs.writeFile(`${root}/manifest.json`, JSON.stringify(manifest, null, 2));
    return { name: manifest.name, version: manifest.version, root, written: true };
}
async function verifiedBlob(manifest, runtimePackage, file) {
    const bytes = await runtimePackage.readBlob(file);
    const actual = await sha256Hex(bytes);
    if (actual !== file.sha256) {
        throw new Error(`${manifest.name}@${manifest.version}: sha256 mismatch for ${file.path} — manifest expects `
            + `${file.sha256}, ${file.content} holds ${actual}`);
    }
    return bytes;
}
