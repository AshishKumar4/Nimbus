/**
 * facets/durable-images.ts — the durable application's boot-image store.
 *
 * A durable spawn's journal row carries only digests — the launch's code,
 * modules, and environment have to live somewhere a reset can still read
 * them, and that is the kernel-space VFS under `.nimbus/images/<sha256>`,
 * content-addressed so a re-drive with the same recipe reads the same bytes.
 *
 * Its blobs are written and read by the same content-addressed protocol as
 * process boot images (image-store.ts storeContentBlob, process-fabric.ts
 * readContentBlob), but they live outside that store's sweep: the sweep is
 * rooted at live pids and would collect an application's image the moment its
 * process ends — the precise condition a durable spawn exists to survive.
 * Durable images are kept for the application's life and released only by
 * explicit removal.
 *
 * Two blobs per launch: `runner` is the main module's source text,
 * `application` is a JSON payload of `{ modules, env, vfsWasmModules }` plus,
 * when the launch set them, `vfsTextModules`, `mainModule` and `startArgs`.
 * A text module is its text there, and an inline wasm module `{ wasm }` its
 * bytes in base64, restored as an ArrayBuffer: JSON writes an ArrayBuffer as
 * `{}`, and a re-drive booted a module that could not compile. An image
 * written that way has lost those bytes, unless its by-path maps supply the
 * same module, which the loader takes in place of the inline one.
 * The digests in the journal's `recipe.image` are sha256 hashes of those two
 * payloads, and a self-owned spawn mints them at spawn time; an
 * embedder-owned spawn is given them by its own bookkeeping instead.
 */
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { type ImageBlobStore } from '@nimbus-sh/fabric/image-store.js';
import type { ResolvedWorkerLaunch, WorkerRecipe } from './manager.js';
import { type InterpreterEnvFacts } from '@nimbus-sh/core/runtime/interpreter-env.js';
/** The directory every durable application's image blobs live under. */
export declare const DURABLE_IMAGE_DIR = ".nimbus/images";
/** An inline module as the launch has it, and as its application blob holds it. */
type InlineModule = string | {
    wasm: ArrayBuffer;
};
/** An application blob an earlier release wrote with an environment in it. */
export interface ApplicationHoldingEnv {
    digest: string;
    /** What its launch's process ran with, the runtime's additions in it (`startArgs.userEnv`). */
    processEnv: Record<string, string> | null;
    /** Whether it held a binding env, which nothing in the session can give back. */
    bindingEnv: boolean;
}
/**
 * Every application blob in the store (an earlier release's included, an
 * index or row naming it or not), read: the ones that hold an environment,
 * and every path any of them names (`vfsTextModules`, `vfsWasmModules`),
 * which their launches read. Runner blobs are code, not application JSON,
 * and are not read.
 */
export declare function readApplicationImages(vfs: SqliteVFS): Promise<{
    holdingEnv: ApplicationHoldingEnv[];
    namedPaths: Set<string>;
}>;
/**
 * `application`, written again without an environment: what every process
 * can read holds none (ask 62). An interpreter's environment is kept as the
 * facts it was built from (`envFacts`, read back from it for `runtime`), as
 * a launch writes it today. Answers the new application digest.
 */
export declare function rewriteWithoutEnvironment(vfs: SqliteVFS, application: string, runtime: InterpreterEnvFacts['runtime'] | null): Promise<string>;
/** Remove only the owner's blobs that no other retained recipe references. */
export declare function purgeDurableWorkerImages(vfs: SqliteVFS, owned: Iterable<{
    runner: string;
    application: string;
}>, retained: Iterable<{
    runner: string;
    application: string;
}>): number;
/** Unlink the blobs of `digests` that are there; answers how many. */
export declare function unlinkDurableImages(vfs: SqliteVFS, digests: Iterable<string>): number;
/**
 * Persist a launch's image blobs, minting their digests, for a self-owned
 * durable spawn, through the session's image disk (written as CRED_KERNEL):
 * the directory is session kernel data, not user content, and a durable
 * application's images must not be writable — or deletable — by the user
 * process they belong to.
 */
export declare function persistDurableWorkerImage(blobs: ImageBlobStore, workerCode: string, payload: {
    modules: Record<string, InlineModule>;
    vfsWasmModules?: Record<string, string>;
    vfsTextModules?: Record<string, string>;
    /** Recorded only when the launch named one; absent means `worker.js`. */
    mainModule?: string;
    startArgs?: unknown;
}): Promise<{
    runner: string;
    application: string;
}>;
/**
 * The default resolver a self-owned durable spawn answers through: read the
 * two blobs the spawn persisted, each verified against its digest, restore the
 * env, and hand back the launch a re-drive can boot. Returns null only when an
 * image row has gone missing — which a re-drive treats as 'the application is
 * gone', exactly as an embedder-owned launch whose embedder answers null.
 */
export declare function resolveDurableWorkerImage(vfs: SqliteVFS, recipe: WorkerRecipe): Promise<ResolvedWorkerLaunch | null>;
export {};
//# sourceMappingURL=durable-images.d.ts.map