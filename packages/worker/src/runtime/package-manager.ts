/**
 * package-manager.ts — `nimbus install <runtime>` shell verb.
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
 * Per-user VFS layout:
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
 * Errors throw and bubble up to the user as a single diagnostic line.
 */

import { fetchCatalog, fetchManifest, fetchBlob, parseRuntimeManifest, type RuntimeCatalogEnv, type RuntimeCatalog, type RuntimeManifest, type ManifestEntrypoint } from './runtime-catalog.js';
import type { CredentialedVfs, SqliteVFS } from '../vfs/sqlite-vfs.js';
import { CRED_KERNEL, NIMBUS_ABI_TARGET, NIMBUS_RUNTIME_ABIS, NATIVE_UNSUPPORTED_ABI, type RuntimePackageAbi } from './os-contracts.js';
import type { CommandContext } from '../substrate/lifo/commands/types.js';

/** Minimal shell ctx shape we depend on (matches existing handlers). */
export interface ShellCtx extends Pick<CommandContext, 'pid' | 'cred' | 'setUmask' | 'runAs'> {
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

export interface RuntimeWarmTarget {
  name: string;
  version: string;
  root: string;
  manifest: RuntimeManifest;
}

export type RuntimeWarmHook = (target: RuntimeWarmTarget, ctx: ShellCtx) => Promise<void>;

interface RuntimeInstallDeps {
  env: RuntimeCatalogEnv;
  vfs: CredentialedVfs;
  registry: MinShellRegistry;
  getHome(): string;
  warmRuntime?: RuntimeWarmHook;
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

export interface RuntimeInstallSummary {
  spec: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

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

function runtimeAbiForCatalogName(name: string): RuntimePackageAbi {
  return NIMBUS_RUNTIME_ABIS[name] ?? NATIVE_UNSUPPORTED_ABI;
}

export interface RuntimeInstallTarget {
  runtimeName: string;
  versionOverride: string | null;
  requestedName: string;
}

export interface RuntimeCommandHint {
  command: string;
  runtimeName: string;
  installSpec: string;
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
    { binName: '/bin/bash', runner: 'bash-runner', args: [] },
    { binName: '/usr/bin/bash', runner: 'bash-runner', args: [] },
  ],
  python: [
    { binName: 'pip', runner: 'python-runner', kind: 'pip', args: [] },
    { binName: 'pip3', runner: 'python-runner', kind: 'pip', args: [] },
  ],
  ruby: [
    { binName: 'gem', runner: 'ruby-runner', kind: 'gem', args: [] },
    { binName: 'bundle', runner: 'ruby-runner', kind: 'bundle', args: [] },
    { binName: 'bundler', runner: 'ruby-runner', kind: 'bundle', args: [] },
  ],
};

function runtimeEntrypoints(manifest: RuntimeManifest): RuntimeManifest['entrypoints'] {
  const out = [...manifest.entrypoints];
  const seen = new Set(out.map((ep) => ep.binName));
  for (const ep of RUNTIME_EXTRA_ENTRYPOINTS[manifest.name] ?? []) {
    if (seen.has(ep.binName)) continue;
    out.push({ ...ep });
    seen.add(ep.binName);
  }
  return out;
}

function splitRuntimeSpec(spec: string): { name: string; versionOverride: string | null } {
  const atIdx = spec.indexOf('@');
  return {
    name: atIdx >= 0 ? spec.slice(0, atIdx) : spec,
    versionOverride: atIdx >= 0 ? spec.slice(atIdx + 1) : null,
  };
}

async function resolveRuntimeInstallTarget(
  env: RuntimeCatalogEnv,
  catalog: RuntimeCatalog,
  spec: string,
): Promise<RuntimeInstallTarget | null> {
  const parsed = splitRuntimeSpec(spec);
  if (catalog.runtimes[parsed.name]) {
    return {
      runtimeName: parsed.name,
      versionOverride: parsed.versionOverride,
      requestedName: parsed.name,
    };
  }

  // Command-name aliasing is catalog-driven: any command a runtime
  // provides (manifest entrypoints + RUNTIME_EXTRA_ENTRYPOINTS) resolves
  // to that runtime, so `nimbus install python3|pip|gem|wasm-ld` all
  // work without a hand-maintained alias map.
  for (const [runtimeName, entry] of Object.entries(catalog.runtimes)) {
    const version = entry.default;
    const versionEntry = entry.versions[version];
    if (!versionEntry) continue;
    try {
      const manifest = await fetchManifest(env, versionEntry);
      if (runtimeEntrypoints(manifest).some((ep) => ep.binName === parsed.name)) {
        return {
          runtimeName,
          versionOverride: parsed.versionOverride,
          requestedName: parsed.name,
        };
      }
    } catch {
      // A bad manifest should not prevent canonical catalog names from
      // resolving; it only suppresses bin-name aliasing for that runtime.
    }
  }
  return null;
}

export function createRuntimeCommandHintResolver(env: RuntimeCatalogEnv): (command: string) => Promise<RuntimeCommandHint | null> {
  let hintsPromise: Promise<Map<string, RuntimeCommandHint>> | null = null;
  const loadHints = async (): Promise<Map<string, RuntimeCommandHint>> => {
    const catalog = await fetchCatalog(env);
    const hints = new Map<string, RuntimeCommandHint>();
    const add = (command: string, runtimeName: string) => {
      if (!command || command.includes('/')) return;
      if (!hints.has(command)) {
        hints.set(command, { command, runtimeName, installSpec: command });
      }
    };

    for (const runtimeName of Object.keys(catalog.runtimes)) {
      add(runtimeName, runtimeName);
    }

    for (const [runtimeName, entry] of Object.entries(catalog.runtimes)) {
      const versionEntry = entry.versions[entry.default];
      if (!versionEntry) continue;
      try {
        const manifest = await fetchManifest(env, versionEntry);
        for (const ep of runtimeEntrypoints(manifest)) add(ep.binName, runtimeName);
      } catch {
        // Hints are best-effort UX. Install itself still surfaces the
        // manifest/catalog error through the normal package-manager path.
      }
    }
    return hints;
  };

  return async (command: string): Promise<RuntimeCommandHint | null> => {
    if (!command || command.includes('/')) return null;
    if (!hintsPromise) {
      hintsPromise = loadHints().catch((e) => {
        hintsPromise = null;
        throw e;
      });
    }
    const hints = await hintsPromise;
    return hints.get(command) ?? null;
  };
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
  return listInstalledManifestsView(vfs.as(CRED_KERNEL), homeDir);
}

function listInstalledManifestsView(
  fs: CredentialedVfs,
  homeDir: string,
): Array<{ root: string; manifest: RuntimeManifest }> {
  const home = homeDir.replace(/^\/+/, '').replace(/\/+$/, '');
  const runtimesRoot = `${home}/.nimbus/runtimes`;
  const out: Array<{ root: string; manifest: RuntimeManifest }> = [];
  if (!fs.exists(runtimesRoot)) return out;
  // Each entry under runtimesRoot is a <name>; each entry under that
  // is a <version>; each <version> dir has a manifest.json.
  for (const nameEntry of fs.readdir(runtimesRoot)) {
    if (nameEntry.type !== 'directory') continue;
    const nameDir = `${runtimesRoot}/${nameEntry.name}`;
    for (const verEntry of fs.readdir(nameDir)) {
      if (verEntry.type !== 'directory') continue;
      const verDir = `${nameDir}/${verEntry.name}`;
      const manifestPath = `${verDir}/manifest.json`;
      if (!fs.exists(manifestPath)) continue;
      try {
        const manifest = parseRuntimeManifest(JSON.parse(fs.readFileString(manifestPath)));
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
  return rehydrateInstalledRuntimesView(vfs.as(CRED_KERNEL), registry, homeDir);
}

function rehydrateInstalledRuntimesView(
  vfs: CredentialedVfs,
  registry: MinShellRegistry,
  homeDir: string,
): { count: number; bins: string[] } {
  const bins: string[] = [];
  for (const { root, manifest } of listInstalledManifestsView(vfs, homeDir)) {
    for (const ep of runtimeEntrypoints(manifest)) {
      const factory = runnerFactories[ep.runner];
      if (!factory) continue; // runner not registered yet — skip
      const handler = factory(manifest, root, ep.binName, ep.kind);
      registry.register(ep.binName, handler);
      bins.push(ep.binName);
    }
  }
  return { count: bins.length, bins };
}

export function listInstalledRuntimes(
  vfs: SqliteVFS,
  homeDir: string,
): RuntimeSummary[] {
  return listInstalledManifests(vfs, homeDir).map(({ root, manifest }) => ({
    name: manifest.name,
    version: manifest.version,
    root,
    abi: runtimeAbiForManifest(manifest),
    bins: runtimeEntrypoints(manifest).map((e) => e.binName),
    sizeBytes: manifest.files.reduce((a, f) => a + f.size, 0),
    license: manifest.license,
  }));
}

export async function listAvailableRuntimes(env: RuntimeCatalogEnv): Promise<Array<{
  name: string;
  abi: RuntimePackageAbi;
  defaultVersion: string;
  versions: Array<{ version: string; sizeBytes: number; license: string }>;
}>> {
  const catalog = await fetchCatalog(env);
  return Object.entries(catalog.runtimes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({
      name,
      abi: runtimeAbiForCatalogName(name),
      defaultVersion: entry.default,
      versions: Object.entries(entry.versions)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([version, v]) => ({
          version,
          sizeBytes: v.size_bytes,
          license: v.license,
        })),
    }));
}

export async function installRuntimeProgrammatic(deps: {
  env: RuntimeCatalogEnv;
  vfs: SqliteVFS;
  registry: MinShellRegistry;
  getHome(): string;
}, spec: string, opts: { force?: boolean } = {}): Promise<RuntimeInstallSummary> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let programmaticCred = CRED_KERNEL;
  const ctx: ShellCtx = {
    pid: 0,
    get cred() { return programmaticCred; },
    setUmask: (umask) => { programmaticCred = { ...programmaticCred, umask }; },
    runAs: async () => 126,
    args: [],
    env: {},
    cwd: deps.getHome(),
    stdout: { write: (s: string) => stdout.push(String(s)) },
    stderr: { write: (s: string) => stderr.push(String(s)) },
  };
  const args = opts.force ? ['--reinstall', spec] : [spec];
  const exitCode = await runInstall(args, ctx, { ...deps, vfs: deps.vfs.as(CRED_KERNEL) });
  return {
    spec,
    exitCode,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
  };
}

export async function ensureRuntimesProgrammatic(deps: {
  env: RuntimeCatalogEnv;
  vfs: SqliteVFS;
  registry: MinShellRegistry;
  getHome(): string;
}, specs: string[], opts: { force?: boolean } = {}): Promise<RuntimeInstallSummary[]> {
  const results: RuntimeInstallSummary[] = [];
  for (const spec of specs) {
    results.push(await installRuntimeProgrammatic(deps, spec, opts));
  }
  return results;
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
  warmRuntime?: RuntimeWarmHook;
}): (ctx: any) => Promise<number> {
  const { env, registry, getHome, warmRuntime } = deps;
  const vfs = deps.vfs.as(CRED_KERNEL);

  return async function nimbus(ctx: ShellCtx): Promise<number> {
    const argv = ctx.args || [];
    const verb = argv[0];
    const rest = argv.slice(1);

    if (verb === 'install') {
      return runInstall(rest, ctx, { env, vfs, registry, getHome, warmRuntime });
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
  deps: RuntimeInstallDeps,
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

  const spec = positional[0];

  // Fetch catalog.
  let catalog: RuntimeCatalog;
  try {
    catalog = await fetchCatalog(deps.env);
  } catch (e: any) {
    ctx.stderr.write(`nimbus install: ${e?.message || e}\n`);
    return 1;
  }

  const target = await resolveRuntimeInstallTarget(deps.env, catalog, spec);
  if (!target) {
    const parsed = splitRuntimeSpec(spec);
    ctx.stderr.write(`nimbus install: '${parsed.name}' is not in catalog\n`);
    ctx.stderr.write(`nimbus install: try 'nimbus install --available' to see installable runtimes\n`);
    return 1;
  }
  const name = target.runtimeName;
  const runtimeEntry = catalog.runtimes[name];

  const version = target.versionOverride || runtimeEntry.default;
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
    rehydrateInstalledRuntimesView(deps.vfs, deps.registry, home);
    let manifest: RuntimeManifest | null = null;
    try {
      manifest = parseRuntimeManifest(JSON.parse(deps.vfs.readFileString(`${root}/manifest.json`)));
    } catch {
      manifest = null;
    }
    if (manifest) {
      await warmRuntimeIfConfigured(ctx, deps, {
        name,
        version,
        root,
        manifest,
      });
    }
    return 0;
  }

  // Fetch manifest from R2.
  ctx.stdout.write(`[${name}] fetching manifest...\n`);
  let manifest: RuntimeManifest;
  try {
    manifest = await fetchManifest(deps.env, versionEntry);
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
  // blobs ≈ ~50-60 MB; well under the DO's 128 MB cap.
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
        const bytes = await fetchBlob(deps.env, f);
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
  for (const ep of runtimeEntrypoints(manifest)) {
    const factory = runnerFactories[ep.runner];
    if (!factory) {
      ctx.stderr.write(`[${name}] warning: runner '${ep.runner}' not registered; bin '${ep.binName}' will not be invokable\n`);
      continue;
    }
    const handler = factory(manifest, root, ep.binName, ep.kind);
    deps.registry.register(ep.binName, handler);
  }

  ctx.stdout.write(`[${name}] installed at ${root} (${(totalBytes / 1024 / 1024).toFixed(1)} MiB)\n`);
  await warmRuntimeIfConfigured(ctx, deps, {
    name,
    version,
    root,
    manifest,
  });
  return 0;
}

async function warmRuntimeIfConfigured(
  ctx: ShellCtx,
  deps: RuntimeInstallDeps,
  target: RuntimeWarmTarget,
): Promise<void> {
  if (!deps.warmRuntime) return;
  try {
    await deps.warmRuntime(target, ctx);
  } catch (e: any) {
    ctx.stderr.write(`[${target.name}] warning: runtime warm-up failed: ${e?.message || e}\n`);
  }
}

// ── --list ───────────────────────────────────────────────────────────

async function runList(
  ctx: ShellCtx,
  deps: { vfs: CredentialedVfs; getHome(): string },
): Promise<number> {
  const home = deps.getHome();
  const installed = listInstalledManifestsView(deps.vfs, home);
  if (installed.length === 0) {
    ctx.stdout.write('(no runtimes installed)\n');
    return 0;
  }
  ctx.stdout.write(`installed runtimes (${installed.length}):\n`);
  for (const { root, manifest } of installed) {
    const totalBytes = manifest.files.reduce((a, f) => a + f.size, 0);
    const bins = runtimeEntrypoints(manifest).map((e) => e.binName).join(', ');
    ctx.stdout.write(`  ${manifest.name}@${manifest.version}  abi=${runtimeAbiForManifest(manifest)}  ${(totalBytes / 1024 / 1024).toFixed(1)} MiB  bins=[${bins}]  ${root}\n`);
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
    ctx.stdout.write(`  ${name}  abi=${runtimeAbiForCatalogName(name)}  default=${r.default}  versions=[${versions.join(', ')}]\n`);
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
  deps: { vfs: CredentialedVfs; registry: MinShellRegistry; getHome(): string },
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
  const installed = listInstalledManifestsView(deps.vfs, home);
  const matches = installed.filter((x) =>
    x.manifest.name === name && (!versionOverride || x.manifest.version === versionOverride),
  );
  if (matches.length === 0) {
    ctx.stderr.write(`nimbus uninstall: '${name}' is not installed\n`);
    return 1;
  }

  for (const m of matches) {
    // Unregister bins.
    for (const ep of runtimeEntrypoints(m.manifest)) {
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

function rmrfVfs(vfs: CredentialedVfs, path: string): void {
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

function cleanupEmpty(vfs: CredentialedVfs, path: string): void {
  if (!vfs.exists(path)) return;
  if (vfs.readdir(path).length === 0) {
    vfs.rmdir(path);
  }
}
