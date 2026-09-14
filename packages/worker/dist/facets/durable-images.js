/**
 * facets/durable-images.ts — the durable application's boot-image store.
 *
 * A durable spawn's journal row carries only digests — the launch's code,
 * modules, and environment have to live somewhere a reset can still read
 * them, and that is the kernel-space VFS under `.nimbus/images/<sha256>`,
 * content-addressed so a re-drive with the same recipe reads the same bytes.
 *
 * The store is deliberately separate from the process boot-image sweep in
 * `image-store.ts`: that sweep is rooted at live pids and would collect an
 * application's image the moment its process ends — the precise condition a
 * durable spawn exists to survive. Durable images are kept for the
 * application's life and released only by explicit removal.
 *
 * Two blobs per launch: `runner` is the worker.js source text, `application`
 * is a JSON payload of `{ modules, env, vfsWasmModules }`. The digests in the
 * journal's `recipe.image` are sha256 hashes of those two payloads, and a
 * self-owned spawn mints them at spawn time; an embedder-owned spawn is given
 * them by its own bookkeeping instead.
 */
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
/** The directory every durable application's image blobs live under. */
export const DURABLE_IMAGE_DIR = '.nimbus/images';
const imagePath = (digest) => `${DURABLE_IMAGE_DIR}/${digest}`;
/** Remove only the owner's blobs that no other retained recipe references. */
export function purgeDurableWorkerImages(vfs, owned, retained) {
    const keep = new Set([...retained].flatMap((image) => [image.runner, image.application]));
    const candidates = new Set([...owned].flatMap((image) => [image.runner, image.application]));
    const kernel = vfs.as(CRED_KERNEL);
    let removed = 0;
    for (const digest of candidates) {
        if (keep.has(digest) || !/^[a-f0-9]{64}$/.test(digest))
            continue;
        const path = imagePath(digest);
        if (!kernel.exists(path))
            continue;
        kernel.unlink(path);
        removed += 1;
    }
    return removed;
}
async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
/**
 * Persist a launch's image blobs, minting their digests, for a self-owned
 * durable spawn. Reads and writes as CRED_KERNEL: the directory is session
 * kernel data, not user content, and a durable application's images must not
 * be writable — or deletable — by the user process they belong to.
 */
export async function persistDurableWorkerImage(vfs, workerCode, payload) {
    const kernel = vfs.as(CRED_KERNEL);
    kernel.mkdir(DURABLE_IMAGE_DIR, { recursive: true });
    const runner = await sha256Hex(workerCode);
    kernel.writeFile(imagePath(runner), workerCode);
    const applicationPayload = JSON.stringify({
        modules: payload.modules,
        env: payload.env ?? null,
        vfsWasmModules: payload.vfsWasmModules ?? null,
        ...(payload.startArgs !== undefined ? { startArgs: payload.startArgs } : {}),
    });
    const application = await sha256Hex(applicationPayload);
    kernel.writeFile(imagePath(application), applicationPayload);
    return { runner, application };
}
/**
 * The default resolver a self-owned durable spawn answers through: read the
 * two blobs the spawn persisted, restore the env, and hand back the launch a
 * re-drive can boot. Returns null only when an image row has gone missing —
 * which a re-drive treats as 'the application is gone', exactly as an
 * embedder-owned launch whose embedder answers null.
 */
export async function resolveDurableWorkerImage(vfs, recipe) {
    const kernel = vfs.as(CRED_KERNEL);
    let runnerBytes;
    let applicationBytes;
    try {
        runnerBytes = kernel.readFile(imagePath(recipe.image.runner));
        applicationBytes = kernel.readFile(imagePath(recipe.image.application));
    }
    catch {
        return null;
    }
    const runner = new TextDecoder().decode(runnerBytes);
    const { modules = {}, env = null, vfsWasmModules = undefined, startArgs } = JSON.parse(new TextDecoder().decode(applicationBytes));
    return {
        env: env ?? null,
        globalOutbound: undefined,
        modules: { 'worker.js': runner, ...modules },
        ...(startArgs !== undefined ? { startArgs } : {}),
        ...(vfsWasmModules !== null ? { vfsWasmModules } : {}),
    };
}
