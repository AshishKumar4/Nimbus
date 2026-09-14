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
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { ResidentCodeSpec } from '@nimbus-sh/fabric/process-fabric.js';
import type { ResolvedWorkerLaunch, WorkerRecipe } from './manager.js';
/** The directory every durable application's image blobs live under. */
export declare const DURABLE_IMAGE_DIR = ".nimbus/images";
/** Remove only the owner's blobs that no other retained recipe references. */
export declare function purgeDurableWorkerImages(vfs: SqliteVFS, owned: Iterable<{
    runner: string;
    application: string;
}>, retained: Iterable<{
    runner: string;
    application: string;
}>): number;
/**
 * Persist a launch's image blobs, minting their digests, for a self-owned
 * durable spawn. Reads and writes as CRED_KERNEL: the directory is session
 * kernel data, not user content, and a durable application's images must not
 * be writable — or deletable — by the user process they belong to.
 */
export declare function persistDurableWorkerImage(vfs: SqliteVFS, workerCode: string, payload: {
    modules: Record<string, string | {
        wasm: ArrayBuffer;
    }>;
    env?: ResidentCodeSpec['env'];
    vfsWasmModules?: Record<string, string>;
    startArgs?: unknown;
}): Promise<{
    runner: string;
    application: string;
}>;
/**
 * The default resolver a self-owned durable spawn answers through: read the
 * two blobs the spawn persisted, restore the env, and hand back the launch a
 * re-drive can boot. Returns null only when an image row has gone missing —
 * which a re-drive treats as 'the application is gone', exactly as an
 * embedder-owned launch whose embedder answers null.
 */
export declare function resolveDurableWorkerImage(vfs: SqliteVFS, recipe: WorkerRecipe): Promise<ResolvedWorkerLaunch | null>;
//# sourceMappingURL=durable-images.d.ts.map