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
import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
import type { RuntimePackageAbi } from './os-contracts.js';
import {
  installRoot,
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

/** What the catalog can offer, without fetching one blob of it. */
export interface RuntimeAvailability {
  name: string;
  abi: RuntimePackageAbi;
  defaultVersion: string;
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

  if (!options?.force && vfs.exists(marker)) {
    if (await runtimeManifestIntact(vfs, root, manifest)) {
      return { name: manifest.name, version: manifest.version, root, written: false };
    }
  }
  // Marker first: whatever happens below, a tree without manifest.json was
  // never a completed install. Everything else stays where it is.
  if (vfs.exists(marker)) vfs.unlink(marker);
  if (!vfs.exists(root)) vfs.mkdir(root, { recursive: true });

  // Parent dirs ahead of the workers so none of them race mkdir.
  const parents = new Set<string>();
  for (const file of manifest.files) {
    const slash = `${root}/${file.path}`.lastIndexOf('/');
    if (slash > 0) parents.add(`${root}/${file.path}`.slice(0, slash));
  }
  for (const parent of parents) {
    if (!vfs.exists(parent)) vfs.mkdir(parent, { recursive: true });
  }

  // Three in flight, as the R2 installer ran: blob reads dominate wall-clock
  // and bounded overlap beats head-of-line batches. A failure stops the
  // dequeue, but `Promise.all` still waits for every started worker — no
  // `readBlob` is left running when the throw escapes, so a retry never
  // contends with the attempt that just failed.
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
        vfs.writeFile(`${root}/${file.path}`, await verifiedBlob(manifest, runtimePackage, file));
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

  vfs.writeFile(marker, JSON.stringify(manifest, null, 2));
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
    const onDisk = parseRuntimeManifest(JSON.parse(vfs.readFileString(`${root}/manifest.json`)));
    if (JSON.stringify(onDisk) !== JSON.stringify(manifest)) return false;
    return await runtimePayloadIntact(vfs, root, onDisk);
  } catch {
    return false;
  }
}


async function verifiedBlob(
  manifest: RuntimeManifest,
  runtimePackage: RuntimePackage,
  file: ManifestFile,
): Promise<Uint8Array> {
  const bytes = await runtimePackage.readBlob(file);
  const actual = await sha256Hex(bytes);
  if (actual !== file.sha256) {
    throw new Error(
      `${manifest.name}@${manifest.version}: sha256 mismatch for ${file.path} — manifest expects `
      + `${file.sha256}, ${file.content} holds ${actual}`,
    );
  }
  return bytes;
}
