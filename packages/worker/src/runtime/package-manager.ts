/**
 * package-manager.ts — the Worker's edge of runtime installation.
 *
 * The policy moved: installs, singleflight, bin registration and the `nimbus`
 * verb itself live in `@nimbus-sh/core` (`runtime/runtime-manager.ts`,
 * `runtime/nimbus-command.ts`) because a library workspace owns them too.
 * What remains here is what only a Cloudflare host can answer:
 *
 *   - `runtimeCatalogSource(env)` — the R2-backed RuntimeSource (the digest
 *     chain stays in runtime-catalog.ts beside this file's fetchers);
 *   - the programmatic entry points the SDK surface calls;
 *   - the command-not-found hint resolver init.ts wires into exec dispatch.
 */

import {
  fetchCatalog,
  fetchManifest,
  runtimeCatalogSource,
  type RuntimeCatalogEnv,
} from './runtime-catalog.js';
import { runtimeEntrypoints } from '@nimbus-sh/core/runtime/installed-runtimes.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { RuntimeManager } from '@nimbus-sh/core/runtime/runtime-manager.js';
import type { RuntimeAvailability } from '@nimbus-sh/core/runtime/runtime-package.js';
import {
  runNimbusInstall,
  type NimbusShellCtx,
  type NimbusVerbDeps,
  type RuntimeWarmHook,
} from '@nimbus-sh/core/runtime/nimbus-command.js';
import type { MinShellRegistry } from '@nimbus-sh/core/runtime/installed-runtimes.js';

export { runtimeCatalogSource };
export type { RuntimeWarmHook };

export interface RuntimeInstallSummary {
  spec: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RuntimeCommandHint {
  command: string;
  runtimeName: string;
  installSpec: string;
}

/**
 * `nimbus install` without a shell: the same `runNimbusInstall` path the verb
 * runs, with output captured instead of written to a terminal. Deps take the
 * workspace's RuntimeManager — which already holds the source, the registry
 * and the runner factories — rather than a catalog env.
 */
export async function installRuntimeProgrammatic(deps: {
  runtimes: RuntimeManager;
  registry: MinShellRegistry;
  vfs: CredentialedVfs;
  getHome(): string;
  warmRuntime?: RuntimeWarmHook;
}, spec: string, opts: { force?: boolean } = {}): Promise<RuntimeInstallSummary> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let programmaticCred = CRED_KERNEL;
  const ctx: NimbusShellCtx = {
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
  const verbDeps: NimbusVerbDeps = {
    runtimes: deps.runtimes,
    registry: deps.registry,
    vfs: deps.vfs,
    warmRuntime: deps.warmRuntime,
  };
  const args = opts.force ? ['--reinstall', spec] : [spec];
  const exitCode = await runNimbusInstall(args, ctx, verbDeps);
  return {
    spec,
    exitCode,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
  };
}

export async function ensureRuntimesProgrammatic(deps: {
  runtimes: RuntimeManager;
  registry: MinShellRegistry;
  vfs: CredentialedVfs;
  getHome(): string;
  warmRuntime?: RuntimeWarmHook;
}, specs: string[], opts: { force?: boolean } = {}): Promise<RuntimeInstallSummary[]> {
  const results: RuntimeInstallSummary[] = [];
  for (const spec of specs) {
    results.push(await installRuntimeProgrammatic(deps, spec, opts));
  }
  return results;
}

export async function listAvailableRuntimes(env: RuntimeCatalogEnv): Promise<RuntimeAvailability[]> {
  return runtimeCatalogSource(env).list();
}

/**
 * Command-not-found hints, catalog-driven: a bare name the shell could not
 * resolve is answered with the runtime that provides it, so `python3` hints
 * at cpython and `wasm-ld` at clang. Loaded once and memoized; a fetch
 * failure drops the memo so the next unknown command retries.
 */
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
