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

import { sha256Incremental } from '../_shared/crypto.js';
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
  mkdir(path: string, options?: { recursive?: boolean }): Awaitable<void>;
  readdir(path: string): Awaitable<{ name: string; type: string }[]>;
  unlink(path: string): Awaitable<void>;
  rmdir(path: string): Awaitable<void>;
}

type CredentialedVfs = RuntimePackageFs;
import type { RuntimePackageAbi } from './os-contracts.js';
import {
  installRoot,
  RUNTIME_BLOB_PIECE_BYTES,
  runtimeAbiForManifest,
  runtimeEntrypoints,
  runtimePayloadIntact,
} from './installed-runtimes.js';
import {
  parseRuntimeManifest,
  type ManifestFile,
  type RuntimeManifest,
} from './runtime-manifest.js';

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
  versions: Array<{ version: string; sizeBytes: number; license: string }>;
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

export function splitRuntimeSpec(spec: string): { name: string; versionOverride: string | null } {
  const atIdx = spec.indexOf('@');
  return {
    name: atIdx >= 0 ? spec.slice(0, atIdx) : spec,
    versionOverride: atIdx >= 0 ? spec.slice(atIdx + 1) : null,
  };
}

/**
 * Runtimes replaced by another implementation, keyed by the name users type.
 *
 * `python` was Pyodide and is now CPython for wasm32-wasi. The redirection
 * lives in code rather than a catalog `default` because the catalog is shared
 * with production deployments that still register the old runner. An explicit
 * `python@<version>` is a deliberate request and bypasses this entirely.
 */
export const SUPERSEDED_RUNTIMES: Readonly<Record<string, string>> = { python: 'cpython' };

/**
 * The runtime source made of packages an embedder already holds. Specs match
 * by name, by `name@version`, and by every bin `runtimeEntrypoints` declares —
 * so `python3`, `pip` and `wasm-ld` resolve to their runtime with no
 * hand-maintained alias map.
 */
export function suppliedRuntimeSource(packages: readonly RuntimePackage[]): RuntimeSource {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const superseded = (name: string): boolean =>
    SUPERSEDED_RUNTIMES[name] !== undefined && byName.has(SUPERSEDED_RUNTIMES[name]);
  return {
    async list() {
      return packages.map((pkg) => {
        const manifest = pkg.manifest;
        return {
          name: manifest.name,
          abi: runtimeAbiForManifest(manifest),
          defaultVersion: manifest.version,
          versions: [{
            version: manifest.version,
            sizeBytes: manifest.files.reduce((a, f) => a + f.size, 0),
            license: manifest.license,
          }],
        };
      });
    },
    async resolve(spec) {
      const { name, versionOverride } = splitRuntimeSpec(spec);
      const successor = SUPERSEDED_RUNTIMES[name];
      if (versionOverride === null && successor !== undefined && byName.has(successor)) {
        return byName.get(successor) ?? null;
      }
      const direct = byName.get(name);
      if (direct) {
        if (versionOverride !== null && direct.manifest.version !== versionOverride) return null;
        return direct;
      }
      for (const pkg of packages) {
        if (versionOverride === null && superseded(pkg.manifest.name)) continue;
        if (versionOverride !== null && pkg.manifest.version !== versionOverride) continue;
        if (runtimeEntrypoints(pkg.manifest).some((ep) => ep.binName === name)) return pkg;
      }
      return null;
    },
  };
}

/**
 * One source out of several: each spec tries every source in order and the
 * first non-null answer wins. Listing concatenates in the same order, so a
 * supplied package shadows a catalog entry of the same name.
 */
export function composeRuntimeSources(sources: readonly RuntimeSource[]): RuntimeSource {
  return {
    async list() {
      const out: RuntimeAvailability[] = [];
      const names = new Set<string>();
      for (const source of sources) {
        for (const entry of await source.list()) {
          if (names.has(entry.name)) continue;
          names.add(entry.name);
          out.push(entry);
        }
      }
      return out;
    },
    async resolve(spec) {
      for (const source of sources) {
        const pkg = await source.resolve(spec);
        if (pkg) return pkg;
      }
      return null;
    },
  };
}

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
export async function seedRuntimePackage(
  vfs: CredentialedVfs,
  homeDir: string,
  runtimePackage: RuntimePackage,
  options?: {
    force?: boolean;
    /** One line per payload file, as it lands. */
    onProgress?: (line: string) => void;
  },
): Promise<SeededRuntime> {
  const manifest = parseRuntimeManifest(runtimePackage.manifest);
  const root = installRoot(homeDir, manifest.name, manifest.version);
  const marker = `${root}/manifest.json`;

  if (!options?.force && (await vfs.exists(marker))) {
    if (await runtimeManifestIntact(vfs, root, manifest)) {
      return { name: manifest.name, version: manifest.version, root, written: false };
    }
  }
  // Marker first: whatever happens below, a tree without manifest.json was
  // never a completed install. Everything else stays where it is.
  if ((await vfs.exists(marker))) (await vfs.unlink(marker));
  if (!(await vfs.exists(root))) (await vfs.mkdir(root, { recursive: true }));

  // Parent dirs ahead of the workers so none of them race mkdir.
  const parents = new Set<string>();
  for (const file of manifest.files) {
    const slash = `${root}/${file.path}`.lastIndexOf('/');
    if (slash > 0) parents.add(`${root}/${file.path}`.slice(0, slash));
  }
  for (const parent of parents) {
    if (!(await vfs.exists(parent))) (await vfs.mkdir(parent, { recursive: true }));
  }

  // Three in flight, as the R2 installer ran: blob reads dominate wall-clock
  // and bounded overlap beats head-of-line batches. Each blob streams, so
  // three in flight hold three pieces, not three blobs. A failure stops the
  // dequeue, but `Promise.all` still waits for every started worker — no
  // read is left running when the throw escapes, so a retry never contends
  // with the attempt that just failed.
  const files = manifest.files;
  let next = 0;
  let completed = 0;
  let failure: Error | null = null;
  const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
    while (failure === null) {
      const i = next++;
      if (i >= files.length) return;
      const file = files[i];
      try {
        await writeVerifiedBlob(vfs, manifest, runtimePackage, file, `${root}/${file.path}`);
        completed++;
        options?.onProgress?.(
          `[${manifest.name}] fetched ${file.path} (${(file.size / 1024 / 1024).toFixed(2)} MiB) ${completed}/${files.length}`,
        );
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failure !== null) throw failure;

  (await vfs.writeFile(marker, JSON.stringify(manifest, null, 2)));
  return { name: manifest.name, version: manifest.version, root, written: true };
}

/** The on-disk manifest parses to exactly this manifest and every payload
 *  file verifies against its digest — the gate for reusing a tree that may
 *  have been written manifest-first by an older installer, or rewritten
 *  by anything else with filesystem access. */
async function runtimeManifestIntact(
  vfs: CredentialedVfs,
  root: string,
  manifest: RuntimeManifest,
): Promise<boolean> {
  try {
    const onDisk = parseRuntimeManifest(JSON.parse((await vfs.readFileString(`${root}/manifest.json`))));
    if (JSON.stringify(onDisk) !== JSON.stringify(manifest)) return false;
    return await runtimePayloadIntact(vfs, root, onDisk);
  } catch {
    return false;
  }
}

async function writeVerifiedBlob(
  vfs: CredentialedVfs,
  manifest: RuntimeManifest,
  runtimePackage: RuntimePackage,
  file: ManifestFile,
  target: string,
): Promise<void> {
  const partial = `${target}.nimbus-partial`;
  // Left behind by an attempt that died mid-write; appending to it would
  // keep its tail.
  if (await vfs.exists(partial)) await vfs.unlink(partial);
  try {
    await vfs.writeFile(partial, new Uint8Array(0));
    const digest = sha256Incremental();
    let offset = 0;
    for await (const piece of blobPieces(await runtimePackage.readBlob(file))) {
      await vfs.writeRange(partial, offset, piece);
      offset += piece.length;
      await digest.update(piece);
    }
    const actual = await digest.hex();
    if (actual !== file.sha256) {
      throw new Error(
        `${manifest.name}@${manifest.version}: sha256 mismatch for ${file.path} — manifest expects `
        + `${file.sha256}, ${file.content} holds ${actual}`,
      );
    }
    await vfs.rename(partial, target);
  } catch (error) {
    if (await vfs.exists(partial)) await vfs.unlink(partial);
    throw error;
  }
}

/** A blob in {@link RUNTIME_BLOB_PIECE_BYTES} pieces; a stream abandoned
 *  partway is cancelled, so no read outlives the install that started it. */
export async function* blobPieces(blob: RuntimeBlob): AsyncGenerator<Uint8Array> {
  if (blob instanceof Uint8Array) {
    for (let at = 0; at < blob.length; at += RUNTIME_BLOB_PIECE_BYTES) {
      yield blob.subarray(at, at + RUNTIME_BLOB_PIECE_BYTES);
    }
    return;
  }
  const byob = byteStreamReader(blob);
  yield* byob ? byteStreamPieces(byob) : chunkPieces(blob.getReader());
}

/** The standard `min` read option, which workers-types does not declare yet. */
type MinByobReader = {
  read(view: Uint8Array, options: { min: number }): Promise<ReadableStreamReadResult<Uint8Array>>;
};

/** A BYOB reader when `stream` has a byte source; only those accept one. */
function byteStreamReader(stream: ReadableStream<Uint8Array>): ReadableStreamBYOBReader | null {
  try {
    return stream.getReader({ mode: 'byob' });
  } catch {
    return null;
  }
}

// workerd hands R2 and cache bodies to JavaScript 4 KiB at a time; `min`
// fills a whole piece natively instead of once per chunk in JavaScript.
async function* byteStreamPieces(reader: ReadableStreamBYOBReader): AsyncGenerator<Uint8Array> {
  const filling = reader as unknown as MinByobReader;
  let done = false;
  try {
    while (!done) {
      const next = await filling.read(new Uint8Array(RUNTIME_BLOB_PIECE_BYTES), { min: RUNTIME_BLOB_PIECE_BYTES });
      done = next.done;
      if (next.value?.length) yield next.value;
    }
  } finally {
    if (!done) await reader.cancel();
    reader.releaseLock();
  }
}

async function* chunkPieces(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Uint8Array> {
  let done = false;
  try {
    let piece = new Uint8Array(RUNTIME_BLOB_PIECE_BYTES);
    let filled = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        break;
      }
      let chunk = next.value;
      // A source already cut into whole pieces (the catalog's) is passed on, not copied.
      if (filled === 0 && chunk.length === RUNTIME_BLOB_PIECE_BYTES) {
        yield chunk;
        continue;
      }
      while (chunk.length > 0) {
        const take = Math.min(chunk.length, piece.length - filled);
        piece.set(chunk.subarray(0, take), filled);
        filled += take;
        chunk = chunk.subarray(take);
        if (filled === piece.length) {
          yield piece;
          piece = new Uint8Array(RUNTIME_BLOB_PIECE_BYTES);
          filled = 0;
        }
      }
    }
    if (filled > 0) yield piece.subarray(0, filled);
  } finally {
    if (!done) await reader.cancel();
    reader.releaseLock();
  }
}
