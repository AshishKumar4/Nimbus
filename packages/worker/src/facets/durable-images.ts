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
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { base64, base64Decode } from '@nimbus-sh/core/_shared/crypto.js';
import { storeContentBlob, type ImageBlobStore } from '@nimbus-sh/fabric/image-store.js';
import { readContentBlob, ResidentCodeSpecSchema } from '@nimbus-sh/fabric/process-fabric.js';
import { z } from 'zod/v4';
import type { ResolvedWorkerLaunch, WorkerRecipe } from './manager.js';

/** The directory every durable application's image blobs live under. */
export const DURABLE_IMAGE_DIR = '.nimbus/images';

const imagePath = (digest: string) => `${DURABLE_IMAGE_DIR}/${digest}`;

/** An inline module as the launch has it, and as its application blob holds it. */
type InlineModule = string | { wasm: ArrayBuffer };
/** `{ wasm: {} }` is an ArrayBuffer an earlier release wrote as JSON. */
const StoredModuleSchema = z.union([z.string(), z.object({ wasm: z.union([z.base64(), z.strictObject({})]) })]);

/** The application blob, as persistDurableWorkerImage writes it. */
const ApplicationImageSchema = z.object({
  modules: z.record(z.string(), StoredModuleSchema).default({}),
  env: ResidentCodeSpecSchema.shape.env.nullable().default(null),
  vfsWasmModules: z.record(z.string(), z.string()).nullable().optional(),
  vfsTextModules: z.record(z.string(), z.string()).optional(),
  mainModule: z.string().optional(),
  startArgs: z.json().optional(),
});

/** The session's image disk as the kernel, for work no process does: an earlier release's images rewritten. */
export function kernelImageBlobs(vfs: SqliteVFS): ImageBlobStore {
  const kernel = vfs.as(CRED_KERNEL);
  return {
    mkdirp: (dir) => kernel.mkdir(dir, { recursive: true, mode: 0o755 }),
    sizeOf: (path) => (kernel.exists(path) ? kernel.stat(path).size : null),
    writeFile: (path, bytes) => kernel.writeFile(path, bytes),
    writeRange: (path, offset, bytes) => kernel.writeRange(path, offset, bytes),
    list: (dir) => kernel.readdir(dir).map((entry) => entry.name),
    unlink: (path) => kernel.unlink(path),
  };
}

/**
 * An application image an earlier release wrote with an environment in it,
 * written again without: what every process can read holds none (ask 62).
 * Answers the new image, the interpreter's process environment it held
 * (`startArgs.userEnv`, for the caller to keep where its host keeps
 * environments), and whether it held a binding env, which nothing in the
 * session can give back. Null when it holds neither, or is not there.
 */
export async function rewriteWithoutEnvironment(
  vfs: SqliteVFS,
  image: { runner: string; application: string },
): Promise<{ image: { runner: string; application: string }; processEnv?: Record<string, string>; bindingEnv: boolean } | null> {
  const kernel = vfs.as(CRED_KERNEL);
  if (!kernel.exists(imagePath(image.application))) return null;
  const bytes = await readContentBlob({ readFile: (path: string) => kernel.readFile(path) }, imagePath(image.application), image.application);
  const parsed = ApplicationImageSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  if (!parsed.success) return null;
  const held = z.looseObject({ userEnv: z.record(z.string(), z.string()) }).safeParse(parsed.data.startArgs);
  if (parsed.data.env === null && !held.success) return null;
  const { env, startArgs, ...rest } = parsed.data;
  let kept: unknown = startArgs;
  if (held.success) {
    const { userEnv: _userEnv, ...others } = held.data;
    kept = { ...others, runtimeEnv: {} };
  }
  // The members written as persistDurableWorkerImage writes them, so the
  // digest is what a launch with these inputs writes today.
  const payload = JSON.stringify({
    modules: rest.modules,
    env: null,
    vfsWasmModules: rest.vfsWasmModules ?? null,
    ...(rest.vfsTextModules !== undefined ? { vfsTextModules: rest.vfsTextModules } : {}),
    ...(rest.mainModule !== undefined ? { mainModule: rest.mainModule } : {}),
    ...(kept !== undefined ? { startArgs: kept } : {}),
  });
  const blobs = kernelImageBlobs(vfs);
  blobs.mkdirp(DURABLE_IMAGE_DIR);
  const application = await storeContentBlob(blobs, payload, imagePath);
  return {
    image: { runner: image.runner, application: application.digest },
    ...(held.success ? { processEnv: held.data.userEnv } : {}),
    bindingEnv: env !== null,
  };
}

/** Remove only the owner's blobs that no other retained recipe references. */
export function purgeDurableWorkerImages(
  vfs: SqliteVFS,
  owned: Iterable<{ runner: string; application: string }>,
  retained: Iterable<{ runner: string; application: string }>,
): number {
  const keep = new Set([...retained].flatMap((image) => [image.runner, image.application]));
  const candidates = new Set([...owned].flatMap((image) => [image.runner, image.application]));
  const kernel = vfs.as(CRED_KERNEL);
  let removed = 0;
  for (const digest of candidates) {
    if (keep.has(digest) || !/^[a-f0-9]{64}$/.test(digest)) continue;
    const path = imagePath(digest);
    if (!kernel.exists(path)) continue;
    kernel.unlink(path);
    removed += 1;
  }
  return removed;
}

/**
 * Persist a launch's image blobs, minting their digests, for a self-owned
 * durable spawn, through the session's image disk (written as CRED_KERNEL):
 * the directory is session kernel data, not user content, and a durable
 * application's images must not be writable — or deletable — by the user
 * process they belong to.
 */
export async function persistDurableWorkerImage(
  blobs: ImageBlobStore,
  workerCode: string,
  payload: {
    modules: Record<string, InlineModule>;
    vfsWasmModules?: Record<string, string>;
    vfsTextModules?: Record<string, string>;
    /** Recorded only when the launch named one; absent means `worker.js`. */
    mainModule?: string;
    startArgs?: unknown;
  },
): Promise<{ runner: string; application: string }> {
  blobs.mkdirp(DURABLE_IMAGE_DIR);
  const runner = await storeContentBlob(blobs, workerCode, imagePath);
  // Optional members are omitted rather than written null so an unchanged
  // launch keeps the digest it had before the member existed.
  const modules = Object.fromEntries(Object.entries(payload.modules).map(([name, member]) =>
    [name, typeof member === 'string' ? member : { wasm: base64(new Uint8Array(member.wasm)) }]));
  // Never an env: every process can read this blob (ask 62). The member is
  // written null so an unchanged launch keeps the digest it had.
  const applicationPayload = JSON.stringify({
    modules,
    env: null,
    vfsWasmModules: payload.vfsWasmModules ?? null,
    ...(payload.vfsTextModules !== undefined ? { vfsTextModules: payload.vfsTextModules } : {}),
    ...(payload.mainModule !== undefined ? { mainModule: payload.mainModule } : {}),
    ...(payload.startArgs !== undefined ? { startArgs: payload.startArgs } : {}),
  });
  const application = await storeContentBlob(blobs, applicationPayload, imagePath);
  return { runner: runner.digest, application: application.digest };
}

/**
 * The default resolver a self-owned durable spawn answers through: read the
 * two blobs the spawn persisted, each verified against its digest, restore the
 * env, and hand back the launch a re-drive can boot. Returns null only when an
 * image row has gone missing — which a re-drive treats as 'the application is
 * gone', exactly as an embedder-owned launch whose embedder answers null.
 */
export async function resolveDurableWorkerImage(
  vfs: SqliteVFS,
  recipe: WorkerRecipe,
): Promise<ResolvedWorkerLaunch | null> {
  const kernel = vfs.as(CRED_KERNEL);
  const { runner: runnerDigest, application: applicationDigest } = recipe.image;
  if (!kernel.exists(imagePath(runnerDigest)) || !kernel.exists(imagePath(applicationDigest))) return null;
  const disk = { readFile: (path: string) => kernel.readFile(path) };
  const runnerBytes = await readContentBlob(disk, imagePath(runnerDigest), runnerDigest);
  const applicationBytes = await readContentBlob(disk, imagePath(applicationDigest), applicationDigest);
  const runner = new TextDecoder().decode(runnerBytes);
  const parsed = ApplicationImageSchema.safeParse(JSON.parse(new TextDecoder().decode(applicationBytes)));
  if (!parsed.success) {
    throw new Error(`Nimbus: the application image ${applicationDigest} cannot be restored: ${z.prettifyError(parsed.error)}`);
  }
  const { env, vfsWasmModules, vfsTextModules, mainModule, startArgs } = parsed.data;
  const modules: Record<string, InlineModule> = {};
  for (const [name, member] of Object.entries(parsed.data.modules)) {
    if (typeof member === 'string') modules[name] = member;
    else if (typeof member.wasm === 'string') modules[name] = { wasm: base64Decode(member.wasm).buffer };
    // The loader takes a by-path module in place of an inline one of its name
    // (process-fabric.ts residentLoaderConfig), so its lost bytes cost nothing.
    else if (!Object.hasOwn(vfsWasmModules ?? {}, name) && !Object.hasOwn(vfsTextModules ?? {}, name)) {
      throw new Error(`Nimbus: the application image ${applicationDigest} cannot be restored: an earlier release wrote its `
        + `inline wasm module '${name}' without its bytes; spawn the application again`);
    }
  }
  // The recipe's own record of the main module wins when the blob predates
  // the member; both say the same thing for any launch written since.
  const main = mainModule ?? recipe.mainModule ?? 'worker.js';
  return {
    env,
    globalOutbound: undefined,
    modules: { ...modules, [main]: runner },
    mainModule: main,
    ...(startArgs !== undefined ? { startArgs } : {}),
    ...(vfsWasmModules !== null ? { vfsWasmModules } : {}),
    ...(vfsTextModules !== undefined ? { vfsTextModules } : {}),
  };
}
