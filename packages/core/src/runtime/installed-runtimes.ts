/**
 * installed-runtimes.ts — the runtimes a session already has, and the shell
 * commands they answer.
 *
 * `nimbus install <name>` unpacks a runtime into
 * `~/.nimbus/runtimes/<name>/<version>/` and this is what reads it back: the
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
import {
  BASH_RUNNER,
  CRED_KERNEL,
  NIMBUS_ABI_TARGET,
  NIMBUS_RUNTIME_ABIS,
  NATIVE_UNSUPPORTED_ABI,
  type RuntimePackageAbi,
} from './os-contracts.js';
import {
  parseRuntimeManifest,
  type ManifestEntrypoint,
  type RuntimeManifest,
} from './runtime-manifest.js';

/** Minimal shell-registry shape we depend on. */
export interface MinShellRegistry {
  register(name: string, handler: Command): void;
  unregister?(name: string): void;
  has?(name: string): boolean;
  resolve?(name: string): Promise<Command | null | undefined> | Command | null | undefined;
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
 */
export const RUNTIME_EXTRA_ENTRYPOINTS: Readonly<Record<string, readonly ManifestEntrypoint[]>> = {
  bash: [
    { binName: '/bin/bash', runner: BASH_RUNNER, args: [] },
    { binName: '/usr/bin/bash', runner: BASH_RUNNER, args: [] },
  ],
  // `pip` belongs to whichever runtime provides the interpreter, and only one
  // may claim it. The python row went with python-runner: Pyodide's manifest
  // still names that runner, so it could not serve pip even if it were listed.
  cpython: [
    { binName: 'pip', runner: 'cpython-runner', kind: 'pip', args: [] },
    { binName: 'pip3', runner: 'cpython-runner', kind: 'pip', args: [] },
  ],
  ruby: [
    { binName: 'gem', runner: 'ruby-runner', kind: 'gem', args: [] },
    { binName: 'bundle', runner: 'ruby-runner', kind: 'bundle', args: [] },
    { binName: 'bundler', runner: 'ruby-runner', kind: 'bundle', args: [] },
  ],
};

export function runtimeEntrypoints(manifest: RuntimeManifest): RuntimeManifest['entrypoints'] {
  const out = [...manifest.entrypoints];
  const seen = new Set(out.map((ep) => ep.binName));
  for (const ep of RUNTIME_EXTRA_ENTRYPOINTS[manifest.name] ?? []) {
    if (seen.has(ep.binName)) continue;
    out.push({ ...ep });
    seen.add(ep.binName);
  }
  return out;
}

/** Compute the per-user install root for (name, version). Uses
 *  `process.env.HOME` if present; falls back to `/home/user`. */
export function installRoot(homeDir: string, name: string, version: string): string {
  // Strip leading slash so SqliteFS sees a relative-looking VFS path,
  // matching the convention used elsewhere in src/session/init.ts.
  const home = homeDir.replace(/^\/+/, '').replace(/\/+$/, '');
  return `${home}/.nimbus/runtimes/${name}/${version}`;
}

/** Read all installed manifests off SqliteFS. Used by both `--list`
 *  and boot-time rehydration. */
export async function listInstalledManifests(
  vfs: SqliteVFS,
  homeDir: string,
): Promise<Array<{ root: string; manifest: RuntimeManifest }>> {
  return (await listInstalledManifestsView(vfs.as(CRED_KERNEL), homeDir));
}

export async function listInstalledManifestsView(
  fs: CredentialedVfs,
  homeDir: string,
): Promise<Array<{ root: string; manifest: RuntimeManifest }>> {
  const home = homeDir.replace(/^\/+/, '').replace(/\/+$/, '');
  const runtimesRoot = `${home}/.nimbus/runtimes`;
  const out: Array<{ root: string; manifest: RuntimeManifest }> = [];
  if (!await fs.exists(runtimesRoot)) return out;
  // Each entry under runtimesRoot is a <name>; each entry under that
  // is a <version>; each <version> dir has a manifest.json.
  for (const nameEntry of await fs.readdir(runtimesRoot)) {
    if (nameEntry.type !== 'directory') continue;
    const nameDir = `${runtimesRoot}/${nameEntry.name}`;
    for (const verEntry of await fs.readdir(nameDir)) {
      if (verEntry.type !== 'directory') continue;
      const verDir = `${nameDir}/${verEntry.name}`;
      const manifestPath = `${verDir}/manifest.json`;
      if (!await fs.exists(manifestPath)) continue;
      try {
        const manifest = parseRuntimeManifest(JSON.parse(await fs.readFileString(manifestPath)));
        out.push({ root: verDir, manifest });
      } catch {
        // Malformed manifest — skip silently. Surfacing via stderr
        // would require a ctx we don't have at boot-time rehydration.
      }
    }
  }
  return out;
}
/**
 * Runtime blobs are read and written in whole 64 KiB VFS chunks, eight at a
 * time: an append then touches no chunk it does not replace, and stays inside
 * one SQLite transaction's 1 MiB blob bound.
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
  vfs: CredentialedVfs,
  registry: MinShellRegistry,
  homeDir: string,
  runnerFor: RunnerLookup,
): Promise<{ count: number; bins: string[] }> {
  const bins: string[] = [];
  for (const { root, manifest } of await listInstalledManifestsView(vfs, homeDir)) {
    if (!await runtimePayloadIntact(vfs, root, manifest)) continue;
    for (const ep of runtimeEntrypoints(manifest)) {
      const factory = runnerFor(ep.runner);
      if (!factory) continue; // runner not registered yet — skip
      const handler = await factory(manifest, root, ep.binName, ep.kind);
      registry.register(ep.binName, handler);
      bins.push(ep.binName);
    }
  }
  return { count: bins.length, bins };
}

export async function listInstalledRuntimes(
  vfs: SqliteVFS,
  homeDir: string,
): Promise<RuntimeSummary[]> {
  return (await listInstalledManifests(vfs, homeDir)).map(({ root, manifest }) => ({
    name: manifest.name,
    version: manifest.version,
    root,
    abi: runtimeAbiForManifest(manifest),
    bins: runtimeEntrypoints(manifest).map((e) => e.binName),
    sizeBytes: manifest.files.reduce((a, f) => a + f.size, 0),
    license: manifest.license,
  }));
}
