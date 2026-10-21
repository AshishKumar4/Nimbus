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
import { base64, base64Decode, sha256Hex } from '@nimbus-sh/core/_shared/crypto.js';
import { storeContentBlob, type ImageBlobStore } from '@nimbus-sh/fabric/image-store.js';
import { readContentBlob, ResidentCodeSpecSchema } from '@nimbus-sh/fabric/process-fabric.js';
import { ensureKernelStoreRoot } from './kernel-store-root.js';
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

/** A durable blob's mode: the kernel's alone. */
export const DURABLE_IMAGE_MODE = 0o400;

/**
 * The durable store's disk, as the kernel. Its blobs are shared by content
 * across every durable application of the session, whichever uid it runs
 * as, and only the kernel reads them (resolveDurableWorkerImage): each is
 * the kernel's alone, and one not left so (an earlier release's, readable by
 * every account) is written again, never written over. Only below the
 * kernel's own store root (ensureKernelStoreRoot).
 */
export function kernelImageBlobs(vfs: SqliteVFS): ImageBlobStore {
  const kernel = vfs.as(CRED_KERNEL);
  const stat = (path: string) => (kernel.exists(path) ? kernel.lstat(path) : null);
  ensureKernelStoreRoot({ stat, mkdir: (path, mode) => kernel.mkdir(path, { mode }) });
  const conforming = (path: string): number | null => {
    const found = stat(path);
    return found?.type === 'file' && found.uid === CRED_KERNEL.uid && (found.mode & 0o777) === DURABLE_IMAGE_MODE ? found.size : null;
  };
  return {
    mkdirp: (dir) => kernel.mkdir(dir, { recursive: true, mode: 0o700 }),
    sizeOf: conforming,
    writeFile: (path, bytes) => {
      if (stat(path) !== null && conforming(path) === null) kernel.unlink(path);
      kernel.writeFile(path, bytes, { mode: DURABLE_IMAGE_MODE });
    },
    writeRange: (path, offset, bytes) => kernel.writeRange(path, offset, bytes),
    list: (dir) => kernel.readdir(dir).map((entry) => entry.name),
    unlink: (path) => kernel.unlink(path),
  };
}

/** An application blob an earlier release wrote with an environment in it. */
export interface ApplicationHoldingEnv {
  digest: string;
  /** What its launch's process ran with, its runtime's additions in it (`startArgs.userEnv`). */
  processEnv: Record<string, string> | null;
  /** Whether it held a binding env, which nothing in the session can give back. */
  bindingEnv: boolean;
}

const HeldUserEnvSchema = z.looseObject({ userEnv: z.record(z.string(), z.string()) });

/**
 * Every blob in the store, an earlier release's included, an index or row
 * naming it or not, read: the application blobs that hold an environment,
 * and the blobs whose bytes are not what their name says (a write a reset
 * cut short), which no reader can use, since every one verifies the digest.
 * A runner blob is code, not application JSON, and holds no environment.
 */
export async function readStoredImages(vfs: SqliteVFS): Promise<{ holdingEnv: ApplicationHoldingEnv[]; corrupt: string[] }> {
  const kernel = vfs.as(CRED_KERNEL);
  const holdingEnv: ApplicationHoldingEnv[] = [];
  const corrupt: string[] = [];
  if (!kernel.exists(DURABLE_IMAGE_DIR)) return { holdingEnv, corrupt };
  for (const { name } of kernel.readdir(DURABLE_IMAGE_DIR)) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const bytes = kernel.readFile(imagePath(name));
    if (await sha256Hex(bytes) !== name) { corrupt.push(name); continue; }
    const parsed = ApplicationImageSchema.safeParse(jsonOrNull(new TextDecoder().decode(bytes)));
    if (!parsed.success) continue;
    const held = HeldUserEnvSchema.safeParse(parsed.data.startArgs);
    if (parsed.data.env !== null || held.success) holdingEnv.push({ digest: name, processEnv: held.success ? held.data.userEnv : null, bindingEnv: parsed.data.env !== null });
  }
  return { holdingEnv, corrupt };
}

/** `text` parsed as JSON, or null when it is not JSON (a runner blob is code). */
function jsonOrNull(text: string): unknown {
  try { return JSON.parse(text); }
  catch { return null; }
}

type ApplicationImage = z.infer<typeof ApplicationImageSchema>;
/** An application as a rewrite leaves it: its start payload any JSON it read back. */
type RewrittenApplication = Omit<ApplicationImage, 'startArgs'> & { startArgs?: unknown };

/** `application`, written again as `edit` changes it; answers the new application digest. */
async function rewriteApplication(vfs: SqliteVFS, application: string, edit: (image: ApplicationImage) => RewrittenApplication): Promise<string> {
  const kernel = vfs.as(CRED_KERNEL);
  const bytes = await readContentBlob({ readFile: (path: string) => kernel.readFile(path) }, imagePath(application), application);
  const image = edit(ApplicationImageSchema.parse(JSON.parse(new TextDecoder().decode(bytes))));
  // The members written as persistDurableWorkerImage writes them, so the
  // digest is what a launch with these inputs writes today.
  const payload = JSON.stringify({
    modules: image.modules,
    env: image.env,
    vfsWasmModules: image.vfsWasmModules ?? null,
    ...(image.vfsTextModules !== undefined ? { vfsTextModules: image.vfsTextModules } : {}),
    ...(image.mainModule !== undefined ? { mainModule: image.mainModule } : {}),
    ...(image.startArgs !== undefined ? { startArgs: image.startArgs } : {}),
  });
  const blobs = kernelImageBlobs(vfs);
  blobs.mkdirp(DURABLE_IMAGE_DIR);
  return (await storeContentBlob(blobs, payload, imagePath)).digest;
}

/**
 * `application`, written again without an environment: what every process
 * can read holds none (ask 62). It keeps no facts to build an interpreter's
 * environment from: an earlier release kept the environment whole, so its
 * relaunch runs with the host's answer as it is (the session's keeping holds
 * that whole environment). Answers the new application digest.
 */
export function rewriteWithoutEnvironment(vfs: SqliteVFS, application: string): Promise<string> {
  return rewriteApplication(vfs, application, ({ startArgs, ...rest }) => {
    const held = HeldUserEnvSchema.safeParse(startArgs);
    if (!held.success) return { ...rest, env: null, startArgs };
    const { userEnv: _userEnv, ...others } = held.data;
    return { ...rest, env: null, startArgs: others };
  });
}

/** Every application blob in the store whose wasm modules read a path `reads` holds. */
export async function applicationsNaming(vfs: SqliteVFS, reads: (path: string) => boolean): Promise<string[]> {
  const kernel = vfs.as(CRED_KERNEL);
  if (!kernel.exists(DURABLE_IMAGE_DIR)) return [];
  const naming: string[] = [];
  for (const { name } of kernel.readdir(DURABLE_IMAGE_DIR)) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const parsed = ApplicationImageSchema.safeParse(jsonOrNull(new TextDecoder().decode(kernel.readFile(imagePath(name)))));
    if (parsed.success && Object.values(parsed.data.vfsWasmModules ?? {}).some(reads)) naming.push(name);
  }
  return naming;
}

/** `application`, written again with each wasm module path in `moved` read from where it moved. */
export function rewriteWasmPaths(vfs: SqliteVFS, application: string, moved: ReadonlyMap<string, string>): Promise<string> {
  return rewriteApplication(vfs, application, (image) => ({
    ...image,
    vfsWasmModules: image.vfsWasmModules === null || image.vfsWasmModules === undefined ? image.vfsWasmModules
      : Object.fromEntries(Object.entries(image.vfsWasmModules).map(([name, path]) => [name, moved.get(path) ?? path])),
  }));
}

/** Remove only the owner's blobs that no other retained recipe references. */
export function purgeDurableWorkerImages(
  vfs: SqliteVFS,
  owned: Iterable<{ runner: string; application: string }>,
  retained: Iterable<{ runner: string; application: string }>,
): number {
  const keep = new Set([...retained].flatMap((image) => [image.runner, image.application]));
  return unlinkDurableImages(vfs, [...owned].flatMap((image) => [image.runner, image.application]).filter((digest) => !keep.has(digest)));
}

/** Unlink the blobs of `digests` that are there; answers how many. */
export function unlinkDurableImages(vfs: SqliteVFS, digests: Iterable<string>): number {
  const kernel = vfs.as(CRED_KERNEL);
  let removed = 0;
  for (const digest of new Set(digests)) {
    if (!/^[a-f0-9]{64}$/.test(digest)) continue;
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
