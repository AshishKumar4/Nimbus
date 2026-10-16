/**
 * installed-runtimes.ts — the runtimes a session already has, and the shell
 * commands they answer.
 *
 * `nimbus install <name>` unpacks a runtime into
 * `/usr/lib/nimbus/<name>/<version>/` (runtime-store.ts) and this is what
 * reads it back: the
 * manifests on disk, the runner each entrypoint names, and the registration
 * that turns the pair into an invokable command. It runs at install time and
 * again at every boot, because a Durable Object that was evicted comes back
 * with the filesystem and none of the registry.
 *
 * Nothing here fetches. Where a runtime came FROM is the caller's
 * RuntimeSource; a runtime that is already installed is the same runtime
 * whichever publisher put it there. Nothing here is process-global either:
 * the runner table and the singleflight live on the workspace's
 * RuntimeManager (runtime-manager.ts), because two workspaces in one process
 * must not share either.
 */

import { sha256Incremental } from '../_shared/crypto.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { RuntimePackageFs as CredentialedVfs } from './runtime-package.js';
import type { Command } from '../substrate/lifo/commands/types.js';
import type { ResolveContext } from '../substrate/lifo/commands/registry.js';
import {
  CRED_KERNEL,
  NIMBUS_ABI_TARGET,
  NIMBUS_RUNTIME_ABIS,
  NATIVE_UNSUPPORTED_ABI,
  type Awaitable,
  type RuntimePackageAbi,
} from './os-contracts.js';
import {
  parseRuntimeManifest,
  type ManifestEntrypoint,
  type RuntimeManifest,
} from './runtime-manifest.js';
import { RUNTIME_STORE, RUNTIME_STORE_DIRS, rootsOwn, runtimeTreeOwn } from './runtime-store.js';

/** Minimal shell-registry shape we depend on. */
export interface MinShellRegistry {
  register(name: string, handler: Command): void;
  unregister?(name: string): void;
  has?(name: string): boolean;
  resolve?(name: string, from?: ResolveContext): Promise<Command | null | undefined> | Command | null | undefined;
}

/** Runner-factory contract. Each registered runner produces a shell-
 *  command handler given the manifest + the installed root dir. The
 *  package manager invokes the factory at install-time + at boot-time
 *  rehydration. */
export type RunnerFactory = (
  manifest: RuntimeManifest,
  installRoot: string,
  binName: string,
  binKind: string | undefined,
) => Command | Promise<Command>;

/**
 * How a manifest entrypoint's `runner` key is resolved to code.
 * The map is owned by the workspace's RuntimeManager.
 */
export type RunnerLookup = (key: string) => RunnerFactory | undefined;

export interface RuntimeSummary {
  name: string;
  version: string;
  root: string;
  abi: RuntimePackageAbi;
  bins: string[];
  sizeBytes: number;
  license: string;
}

export function runtimeAbiForManifest(manifest: RuntimeManifest): RuntimePackageAbi {
  const byName = NIMBUS_RUNTIME_ABIS[manifest.name];
  if (byName) return byName;
  if (manifest.wasi_namespace) return NIMBUS_ABI_TARGET;
  if (manifest.entrypoints.some((entrypoint) => entrypoint.runner === 'clang-runner')) {
    return NIMBUS_ABI_TARGET;
  }
  return NATIVE_UNSUPPORTED_ABI;
}

/**
 * Commands a runtime provides beyond its manifest entrypoints. The
 * python/ruby package-manager front-ends (pip, gem, bundler) ride the
 * language runner rather than shipping as manifest files, and already-
 * deployed R2 manifests cannot retroactively declare them.
 *
 * This is the ONE hand-maintained command table: install aliasing
 * (`nimbus install pip` → python), command-not-found hints, and bin
 * registration all derive from `runtimeEntrypoints`, which merges this
 * with the catalog manifest. Catalog-declared aliases (python3, ruby3,
 * wasm-ld, …) come from manifest entrypoints and must NOT be repeated
 * here. Mechanically validated against `NIMBUS_RUNTIME_ABIS` by
 * tests/unit/runtime-command-aliases.mjs.
 *
 * A row names no runner: it rides the one the manifest's own entrypoints
 * name, the contract that build was made for (BASH_RUNNER, CPYTHON_RUNNER),
 * so an older build's pip is bound, or not, as its python is.
 */
export const RUNTIME_EXTRA_ENTRYPOINTS: Readonly<Record<string, readonly Omit<ManifestEntrypoint, 'runner'>[]>> = {
  bash: [
    { binName: '/bin/bash', args: [] },
    { binName: '/usr/bin/bash', args: [] },
  ],
  // `pip` belongs to whichever runtime provides the interpreter, and only one
  // may claim it. The python row went with python-runner: Pyodide's manifest
  // still names that runner, so it could not serve pip even if it were listed.
  cpython: [
    { binName: 'pip', kind: 'pip', args: [] },
    { binName: 'pip3', kind: 'pip', args: [] },
  ],
  ruby: [
    { binName: 'gem', kind: 'gem', args: [] },
    { binName: 'bundle', kind: 'bundle', args: [] },
    { binName: 'bundler', kind: 'bundle', args: [] },
  ],
};

export function runtimeEntrypoints(manifest: RuntimeManifest): RuntimeManifest['entrypoints'] {
  const out = [...manifest.entrypoints];
  const runner = out[0]?.runner;
  if (runner === undefined) return out;
  const seen = new Set(out.map((ep) => ep.binName));
  for (const ep of RUNTIME_EXTRA_ENTRYPOINTS[manifest.name] ?? []) {
    if (seen.has(ep.binName)) continue;
    out.push({ ...ep, runner });
    seen.add(ep.binName);
  }
  return out;
}

/** Where (name, version) is installed, as a key: `usr/lib/nimbus/<name>/<version>`. */
export function installRoot(name: string, version: string): string {
  return `${RUNTIME_STORE}/${name}/${version}`;
}

/** What the store is listed through: a view that can look at a name without following it. */
export type InstalledRuntimesFs = Pick<CredentialedVfs, 'exists' | 'readdir' | 'readFileString'> & {
  stat(path: string, options?: { follow?: boolean }): Awaitable<{ type: string; uid?: number; mode?: number } | null>;
};

/** Read all installed manifests off SqliteFS. Used by both `--list`
 *  and boot-time rehydration. */
export async function listInstalledManifests(vfs: SqliteVFS): Promise<Array<{ root: string; manifest: RuntimeManifest }>> {
  const kernel = vfs.as(CRED_KERNEL);
  return await listInstalledManifestsView({
    exists: (path) => kernel.exists(path),
    readdir: (path) => kernel.readdir(path),
    readFileString: (path) => kernel.readFileString(path),
    stat: (path, options) => kernel.statIfPresent(path, options?.follow !== false),
  });
}

/**
 * The runtimes in the store that are the system's: what the store, each
 * name's and each version's directory, and each directory its files are in,
 * are root's own (rootsOwn, looked at without following them), and a
 * manifest.json root wrote. Anything else
 * (a tree a user made in a store an earlier release left theirs, a link)
 * is not listed, so nothing binds, links or removes it as the kernel; a
 * store that is not root's lists nothing.
 */
export async function listInstalledManifestsView(fs: InstalledRuntimesFs): Promise<Array<{ root: string; manifest: RuntimeManifest }>> {
  const out: Array<{ root: string; manifest: RuntimeManifest }> = [];
  const own = async (path: string) => rootsOwn(await fs.stat(path, { follow: false }));
  for (const dir of RUNTIME_STORE_DIRS) {
    if (!(await own(dir))) return out;
  }
  // Each entry in the store is a <name>; each entry under that is a
  // <version>; each <version> dir has a manifest.json.
  for (const nameEntry of await fs.readdir(RUNTIME_STORE)) {
    const nameDir = `${RUNTIME_STORE}/${nameEntry.name}`;
    if (!(await own(nameDir))) continue;
    for (const verEntry of await fs.readdir(nameDir)) {
      const verDir = `${nameDir}/${verEntry.name}`;
      const manifestPath = `${verDir}/manifest.json`;
      if (!(await own(verDir))) continue;
      const marker = await fs.stat(manifestPath, { follow: false });
      if (marker?.type !== 'file' || marker.uid !== 0) continue;
      let manifest: RuntimeManifest;
      try {
        manifest = parseRuntimeManifest(JSON.parse(await fs.readFileString(manifestPath)));
      } catch {
        // Malformed manifest — skip silently. Surfacing via stderr
        // would require a ctx we don't have at boot-time rehydration.
        continue;
      }
      // Its files are reached through root's own directories only.
      if (await runtimeTreeOwn(fs, verDir, manifest)) out.push({ root: verDir, manifest });
    }
  }
  return out;
}
/**
 * Runtime blobs are read eight 64 KiB chunks at a time: a source's body is
 * coalesced into pieces this size, and an installed blob is re-verified a
 * ranged read this size at a time. Writing is not piecewise: each blob
 * streams into the filesystem as one file (runtime-package.ts).
 */
export const RUNTIME_BLOB_PIECE_BYTES = 512 * 1024;

/**
 * An installed tree is trustworthy when its manifest parses and every payload
 * file it declares is present with the digest the manifest vouches for.
 *
 * Digest-verified rather than size-verified because the tree's manifest is
 * what rehydration binds commands to: a same-size corruption or a rewritten
 * entrypoints table is a different runtime than the one that was installed,
 * trusting it would run bytes nobody published. One piece of one file at a
 * time — these are interpreters, tens of megabytes each.
 */
export async function runtimePayloadIntact(
  fs: CredentialedVfs,
  root: string,
  manifest: RuntimeManifest,
): Promise<boolean> {
  try {
    for (const file of manifest.files) {
      const target = `${root}/${file.path}`;
      if (!await fs.exists(target)) return false;
      const digest = sha256Incremental();
      for (let offset = 0; ;) {
        const piece = await fs.readRangeUncached(target, offset, RUNTIME_BLOB_PIECE_BYTES);
        if (piece.length === 0) break;
        await digest.update(piece);
        offset += piece.length;
      }
      if (await digest.hex() !== file.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-register every VERIFIED installed runtime's entrypoints in the shell
 * registry. A tree that fails the payload check is not bound: it may be a
 * legacy manifest-first install interrupted mid-write or a corruption, and
 * the manager's install path repairs it on demand rather than running it.
 */
export async function rehydrateInstalledRuntimesView(
  vfs: CredentialedVfs & InstalledRuntimesFs,
  registry: MinShellRegistry,
  runnerFor: RunnerLookup,
  /** Each verified runtime, once its commands are registered: their handlers, by name (its launchers are linked). */
  bound?: (root: string, manifest: RuntimeManifest, handlers: ReadonlyMap<string, Command>) => Promise<void>,
): Promise<{ count: number; bins: string[] }> {
  const bins: string[] = [];
  for (const { root, manifest } of await listInstalledManifestsView(vfs)) {
    if (!await runtimePayloadIntact(vfs, root, manifest)) continue;
    const handlers = await bindRuntimeCommands(registry, runnerFor, root, manifest);
    bins.push(...handlers.keys());
    await bound?.(root, manifest, handlers);
  }
  return { count: bins.length, bins };
}

/**
 * Registers the commands of the runtime `manifest` describes, installed at
 * `root`: each entrypoint's handler, made by its runner's factory; one whose
 * runner is not registered yet is left out. Its handlers, by name.
 */
export async function bindRuntimeCommands(
  registry: MinShellRegistry,
  runnerFor: RunnerLookup,
  root: string,
  manifest: RuntimeManifest,
): Promise<Map<string, Command>> {
  const handlers = new Map<string, Command>();
  for (const ep of runtimeEntrypoints(manifest)) {
    const factory = runnerFor(ep.runner);
    if (!factory) continue;
    const handler = await factory(manifest, root, ep.binName, ep.kind);
    registry.register(ep.binName, handler);
    handlers.set(ep.binName, handler);
  }
  return handlers;
}

/** The installed runtime at `root`, as `runtime list` shows it. */
export function runtimeSummary(root: string, manifest: RuntimeManifest): RuntimeSummary {
  return {
    name: manifest.name,
    version: manifest.version,
    root,
    abi: runtimeAbiForManifest(manifest),
    bins: runtimeEntrypoints(manifest).map((e) => e.binName),
    sizeBytes: manifest.files.reduce((a, f) => a + f.size, 0),
    license: manifest.license,
  };
}

export async function listInstalledRuntimes(vfs: SqliteVFS): Promise<RuntimeSummary[]> {
  return (await listInstalledManifests(vfs)).map(({ root, manifest }) => runtimeSummary(root, manifest));
}
