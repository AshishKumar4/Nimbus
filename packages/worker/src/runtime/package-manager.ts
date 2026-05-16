/**
 * package-manager.ts — `nimbus install <runtime>` shell verb.
 *
 * Implements True-OS Wave-3's package-manager surface per
 * /workspace/.seal-internal/2026-05-10-true-os/plan.md §2.
 *
 * Subcommands (all under `nimbus install`):
 *
 *   nimbus install <name>                 install latest of <name>
 *   nimbus install <name>@<version>       install specific version
 *   nimbus install --list                 show installed runtimes
 *   nimbus install --available            show catalog of installables
 *   nimbus install --reinstall <name>     force refetch
 *   nimbus uninstall <name>               remove installed runtime
 *
 * Per-user-VFS layout (decision D-install-1 (a) baked):
 *
 *   ~/.nimbus/runtimes/<name>/<version>/
 *     manifest.json
 *     bin/<entry>
 *     share/<name>/...
 *     LICENSE
 *
 * Survives DO eviction (SqliteFS-backed). Boot-time rehydration reads
 * every `~/.nimbus/runtimes/STAR/STAR/manifest.json` and re-registers
 * each `entrypoints[].binName` as a shell command pointing at the
 * named runner factory.
 *
 * Anti-reqs (inherited from plan §8.1):
 *   - NO setTimeout / NO retry / NO defensive-catch in dispatch path.
 *   - Errors throw + bubble up to the user as a single diagnostic line.
 */

import { fetchCatalog, fetchManifest, fetchBlob, type RuntimeCatalogEnv, type RuntimeManifest } from './runtime-catalog.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';

/** Minimal shell ctx shape we depend on (matches existing handlers). */
interface ShellCtx {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
}

/** Minimal shell-registry shape we depend on. */
export interface MinShellRegistry {
  register(name: string, handler: (ctx: any) => Promise<number>): void;
  unregister?(name: string): void;
  resolve?(name: string): any;
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
) => (ctx: any) => Promise<number>;

/** Map of runner-key → factory. Populated by init.ts before install. */
const runnerFactories: Record<string, RunnerFactory> = {};

export function registerRunnerFactory(key: string, factory: RunnerFactory): void {
  runnerFactories[key] = factory;
}

export function getRegisteredRunners(): string[] {
  return Object.keys(runnerFactories);
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
export function listInstalledManifests(
  vfs: SqliteVFS,
  homeDir: string,
): Array<{ root: string; manifest: RuntimeManifest }> {
  const home = homeDir.replace(/^\/+/, '').replace(/\/+$/, '');
  const runtimesRoot = `${home}/.nimbus/runtimes`;
  const out: Array<{ root: string; manifest: RuntimeManifest }> = [];
  if (!vfs.exists(runtimesRoot)) return out;
  // Each entry under runtimesRoot is a <name>; each entry under that
  // is a <version>; each <version> dir has a manifest.json.
  for (const nameEntry of vfs.readdir(runtimesRoot)) {
    if (nameEntry.type !== 'directory') continue;
    const nameDir = `${runtimesRoot}/${nameEntry.name}`;
    for (const verEntry of vfs.readdir(nameDir)) {
      if (verEntry.type !== 'directory') continue;
      const verDir = `${nameDir}/${verEntry.name}`;
      const manifestPath = `${verDir}/manifest.json`;
      if (!vfs.exists(manifestPath)) continue;
      try {
        const manifest = JSON.parse(vfs.readFileString(manifestPath)) as RuntimeManifest;
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
 * Re-register every installed runtime's entrypoints in the shell
 * registry. Call once at session-init time after all runner factories
 * are registered (init.ts:registerRunnerFactory blocks).
 */
export function rehydrateInstalledRuntimes(
  vfs: SqliteVFS,
  registry: MinShellRegistry,
  homeDir: string,
): { count: number; bins: string[] } {
  const bins: string[] = [];
  for (const { root, manifest } of listInstalledManifests(vfs, homeDir)) {
    for (const ep of manifest.entrypoints) {
      const factory = runnerFactories[ep.runner];
      if (!factory) continue; // runner not registered yet — skip
      const handler = factory(manifest, root, ep.binName, ep.kind);
      registry.register(ep.binName, handler);
      bins.push(ep.binName);
    }
  }
  return { count: bins.length, bins };
}

/**
 * Build the shell-command handler that implements `nimbus install …`,
 * `nimbus uninstall …`. Registered under the name `nimbus`.
 */
export function makeNimbusVerbHandler(deps: {
  env: RuntimeCatalogEnv;
  vfs: SqliteVFS;
  registry: MinShellRegistry;
  /** Returns `process.env.HOME` for the session. Computed by the
   *  caller (init.ts) from the shell env. */
  getHome(): string;
}): (ctx: any) => Promise<number> {
  const { env, vfs, registry, getHome } = deps;

  return async function nimbus(ctx: ShellCtx): Promise<number> {
    const argv = ctx.args || [];
    const verb = argv[0];
    const rest = argv.slice(1);

    if (verb === 'install') {
      return runInstall(rest, ctx, { env, vfs, registry, getHome });
    }
    if (verb === 'uninstall') {
      return runUninstall(rest, ctx, { vfs, registry, getHome });
    }

    // Unknown verb.
    ctx.stderr.write(`nimbus: unknown subcommand '${verb || '(none)'}'\n`);
    ctx.stderr.write(`usage: nimbus install <name>[@<version>] | nimbus install --list | nimbus install --available | nimbus uninstall <name>\n`);
    return 2;
  };
}

// ── install ──────────────────────────────────────────────────────────

async function runInstall(
  args: string[],
  ctx: ShellCtx,
  deps: { env: RuntimeCatalogEnv; vfs: SqliteVFS; registry: MinShellRegistry; getHome(): string },
): Promise<number> {
  // Flag parsing.
  const listOnly = args.includes('--list');
  const availOnly = args.includes('--available');
  const force = args.includes('--reinstall') || args.includes('--force');
  const positional = args.filter((a) => !a.startsWith('--'));

  if (listOnly) return runList(ctx, deps);
  if (availOnly) return runAvailable(ctx, deps);

  if (positional.length === 0) {
    ctx.stderr.write('nimbus install: missing runtime name\n');
    ctx.stderr.write('usage: nimbus install <name>[@<version>]\n');
    return 2;
  }

  // Parse `<name>` or `<name>@<version>`.
  const spec = positional[0];
  const atIdx = spec.indexOf('@');
  const name = atIdx >= 0 ? spec.slice(0, atIdx) : spec;
  const versionOverride = atIdx >= 0 ? spec.slice(atIdx + 1) : null;

  // Fetch catalog.
  let catalog;
  try {
    catalog = await fetchCatalog(deps.env);
  } catch (e: any) {
    ctx.stderr.write(`nimbus install: ${e?.message || e}\n`);
    return 1;
  }

  const runtimeEntry = catalog.runtimes[name];
  if (!runtimeEntry) {
    ctx.stderr.write(`nimbus install: '${name}' is not in catalog\n`);
    ctx.stderr.write(`nimbus install: try 'nimbus install --available' to see installable runtimes\n`);
    return 1;
  }

  const version = versionOverride || runtimeEntry.default;
  const versionEntry = runtimeEntry.versions[version];
  if (!versionEntry) {
    ctx.stderr.write(`nimbus install: '${name}@${version}' not in catalog\n`);
    return 1;
  }

  const home = deps.getHome();
  const root = installRoot(home, name, version);

  // Idempotent: if manifest already on disk + sha-equivalent, skip.
  if (!force && deps.vfs.exists(`${root}/manifest.json`)) {
    // We could re-verify all blob sha256s, but that's expensive. The
    // manifest's presence implies the install completed; we trust it.
    ctx.stdout.write(`[${name}] already installed at ${root} (use --reinstall to refetch)\n`);
    // Still re-register bins in case the registry lost them — idempotent.
    rehydrateInstalledRuntimes(deps.vfs, deps.registry, home);
    return 0;
  }

  // Fetch manifest from R2.
  ctx.stdout.write(`[${name}] fetching manifest...\n`);
  let manifest: RuntimeManifest;
  try {
    manifest = await fetchManifest(deps.env, versionEntry.manifest);
  } catch (e: any) {
    ctx.stderr.write(`nimbus install: ${e?.message || e}\n`);
    return 1;
  }

  // Pre-flight: budget check.
  const totalBytes = manifest.files.reduce((a, f) => a + f.size, 0);
  ctx.stdout.write(`[${name}] manifest: ${manifest.files.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB\n`);

  // Create install root.
  deps.vfs.mkdir(root, { recursive: true });

  // Write manifest.json first (so a partial install can be retried
  // and the manifest is the source of truth).
  deps.vfs.writeFile(`${root}/manifest.json`, JSON.stringify(manifest, null, 2));

  // W2: bounded-parallel blob fetch (concurrency=3).
  //
  // Pre-W2 this was a serial for-loop awaiting fetchBlob one at a time.
  // For multi-blob bundles (clang has 5 blobs with the two largest
  // dominating wall-clock at ~31 MB + ~19 MB), overlap of network/L2
  // reads cuts cold-install wall-clock by 30-50%. Concurrency capped
  // at 3 to bound memory peak: worst-case clang holds 3 in-flight
  // blobs ≈ ~50-60 MB; well under the DO's 128 MB cap. Memory peak
  // is further bounded by sqlite-vfs.ts pendingWrites auto-flush at
  // 500 chunks / ~32 MiB (`src/vfs/sqlite-vfs.ts:606`).
  //
  // mkdir-parent is hoisted OUT of the worker body so concurrent
  // workers don't race against vfs.mkdir for the same parent. Each
  // unique parent dir is created exactly once, synchronously, BEFORE
  // any worker starts.
  //
  // Manifest-first invariant preserved: this loop runs AFTER the
  // manifest.json write above. Partial-install detection unchanged.
  //
  // Progress UX: with parallel workers, lines arrive in completion
  // order, not start order. The final "[name] installed at … (Y MiB)"
  // line is still the authoritative completion signal.
  const FETCH_CONCURRENCY = 3;

  // Pre-compute + create all unique parent dirs sync. Avoids a
  // mkdir race between workers and is faster than per-blob exists()
  // checks.
  const uniqueParents = new Set<string>();
  for (const f of manifest.files) {
    const target = `${root}/${f.path}`;
    const lastSlash = target.lastIndexOf('/');
    if (lastSlash > 0) {
      uniqueParents.add(target.slice(0, lastSlash));
    }
  }
  for (const parent of uniqueParents) {
    if (!deps.vfs.exists(parent)) deps.vfs.mkdir(parent, { recursive: true });
  }

  // Hand-rolled worker pool: N workers consume indices off a shared
  // cursor until the queue is empty. Avoids head-of-line blocking
  // that chunked Promise.all suffers (a slow blob in batch i doesn't
  // delay blob i+N from starting).
  const files = manifest.files;
  const total = files.length;
  let nextIdx = 0;
  let completed = 0;
  const workers = Array.from(
    { length: Math.min(FETCH_CONCURRENCY, total) },
    async () => {
      while (true) {
        const i = nextIdx++;
        if (i >= total) return;
        const f = files[i];
        const target = `${root}/${f.path}`;
        const bytes = await fetchBlob(deps.env, f.content, f.sha256);
        deps.vfs.writeFile(target, bytes);
        completed++;
        ctx.stdout.write(
          `[${name}] fetched ${f.path} (${(f.size / 1024 / 1024).toFixed(2)} MiB) ${completed}/${total}\n`,
        );
      }
    },
  );
  await Promise.all(workers);

  // Register entrypoints.
  for (const ep of manifest.entrypoints) {
    const factory = runnerFactories[ep.runner];
    if (!factory) {
      ctx.stderr.write(`[${name}] warning: runner '${ep.runner}' not registered; bin '${ep.binName}' will not be invokable\n`);
      continue;
    }
    const handler = factory(manifest, root, ep.binName, ep.kind);
    deps.registry.register(ep.binName, handler);
  }

  ctx.stdout.write(`[${name}] installed at ${root} (${(totalBytes / 1024 / 1024).toFixed(1)} MiB)\n`);
  return 0;
}

// ── --list ───────────────────────────────────────────────────────────

async function runList(
  ctx: ShellCtx,
  deps: { vfs: SqliteVFS; getHome(): string },
): Promise<number> {
  const home = deps.getHome();
  const installed = listInstalledManifests(deps.vfs, home);
  if (installed.length === 0) {
    ctx.stdout.write('(no runtimes installed)\n');
    return 0;
  }
  ctx.stdout.write(`installed runtimes (${installed.length}):\n`);
  for (const { root, manifest } of installed) {
    const totalBytes = manifest.files.reduce((a, f) => a + f.size, 0);
    const bins = manifest.entrypoints.map((e) => e.binName).join(', ');
    ctx.stdout.write(`  ${manifest.name}@${manifest.version}  ${(totalBytes / 1024 / 1024).toFixed(1)} MiB  bins=[${bins}]  ${root}\n`);
  }
  return 0;
}

// ── --available ──────────────────────────────────────────────────────

async function runAvailable(
  ctx: ShellCtx,
  deps: { env: RuntimeCatalogEnv },
): Promise<number> {
  let catalog;
  try {
    catalog = await fetchCatalog(deps.env);
  } catch (e: any) {
    ctx.stderr.write(`nimbus install --available: ${e?.message || e}\n`);
    return 1;
  }
  const names = Object.keys(catalog.runtimes).sort();
  if (names.length === 0) {
    ctx.stdout.write('(no runtimes in catalog)\n');
    return 0;
  }
  ctx.stdout.write(`available runtimes (${names.length}):\n`);
  for (const name of names) {
    const r = catalog.runtimes[name];
    const versions = Object.keys(r.versions);
    ctx.stdout.write(`  ${name}  default=${r.default}  versions=[${versions.join(', ')}]\n`);
    for (const v of versions) {
      const ve = r.versions[v];
      ctx.stdout.write(`    ${v}  ${(ve.size_bytes / 1024 / 1024).toFixed(1)} MiB  license=${ve.license}\n`);
    }
  }
  return 0;
}

// ── uninstall ────────────────────────────────────────────────────────

async function runUninstall(
  args: string[],
  ctx: ShellCtx,
  deps: { vfs: SqliteVFS; registry: MinShellRegistry; getHome(): string },
): Promise<number> {
  if (args.length === 0 || args[0].startsWith('--')) {
    ctx.stderr.write('nimbus uninstall: missing runtime name\n');
    return 2;
  }
  const spec = args[0];
  const atIdx = spec.indexOf('@');
  const name = atIdx >= 0 ? spec.slice(0, atIdx) : spec;
  const versionOverride = atIdx >= 0 ? spec.slice(atIdx + 1) : null;

  const home = deps.getHome();
  const installed = listInstalledManifests(deps.vfs, home);
  const matches = installed.filter((x) =>
    x.manifest.name === name && (!versionOverride || x.manifest.version === versionOverride),
  );
  if (matches.length === 0) {
    ctx.stderr.write(`nimbus uninstall: '${name}' is not installed\n`);
    return 1;
  }

  for (const m of matches) {
    // Unregister bins.
    for (const ep of m.manifest.entrypoints) {
      // We don't have a guaranteed `unregister`; bins shadowing is OK
      // because boot-rehydration only re-registers what's still on disk.
      if (typeof deps.registry.unregister === 'function') {
        deps.registry.unregister(ep.binName);
      }
    }
    // Recursive delete via VFS — readdir + unlink + rmdir.
    rmrfVfs(deps.vfs, m.root);
    ctx.stdout.write(`[${m.manifest.name}@${m.manifest.version}] uninstalled (removed ${m.root})\n`);
  }

  // Clean up empty parent dirs (~/.nimbus/runtimes/<name>/ if no
  // versions left; runtimes/ if no runtimes left).
  const runtimeDir = `${home.replace(/^\/+/, '').replace(/\/+$/, '')}/.nimbus/runtimes/${name}`;
  cleanupEmpty(deps.vfs, runtimeDir);
  cleanupEmpty(deps.vfs, `${home.replace(/^\/+/, '').replace(/\/+$/, '')}/.nimbus/runtimes`);

  return 0;
}

function rmrfVfs(vfs: SqliteVFS, path: string): void {
  if (!vfs.exists(path)) return;
  for (const entry of vfs.readdir(path)) {
    const child = `${path}/${entry.name}`;
    if (entry.type === 'directory') {
      rmrfVfs(vfs, child);
    } else {
      vfs.unlink(child);
    }
  }
  vfs.rmdir(path);
}

function cleanupEmpty(vfs: SqliteVFS, path: string): void {
  if (!vfs.exists(path)) return;
  if (vfs.readdir(path).length === 0) {
    vfs.rmdir(path);
  }
}
