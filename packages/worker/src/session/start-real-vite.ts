/**
 * start-real-vite.ts — the one place a cirrus-real (real `vite`) dev server is
 * booted.
 *
 * Two callers share it: the `vite` shell builtin (opt-in via NIMBUS_REAL_VITE=1
 * or `nimbusDevServer: 'real'`) and the hibernation-restore path in
 * session/routes.ts. Booting is heavy — it pre-bundles the user's vite.config
 * against the VFS, allocates the facet payload, and boots a dynamic-worker
 * facet — so it must not be duplicated: a woken session has to rebuild the
 * server exactly as the command did, or the two disagree on what real-vite
 * looks like.
 *
 * It also persists what restore needs into the SAME `vite-config` key the
 * Cirrus shim writes, tagged `devServer: 'real'` so restore rebuilds real-vite
 * rather than the shim. Before this, cirrus-real wrote nothing at all and every
 * such session was unrecoverable after eviction.
 */

import { CRED_KERNEL, isVfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { execIdField, type ProcessEntry } from '@nimbus-sh/core/runtime/process-table.js';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { supervisorEsbuildService } from '../facets/esbuild-transform.js';
import { rewriteCirrusViteConfigBundle } from '@nimbus-sh/core/runtime/cirrus-vite-config-rewriter.js';
import { CirrusReal } from '../facets/cirrus-real.js';
import { makeLongRunningPortStub } from '@nimbus-sh/core/runtime/long-running-handle.js';
import { acquireHeavyAlloc } from '@nimbus-sh/platform/heavy-alloc-coord.js';
import { VITE_CONFIG_KEY } from './keys.js';
import { registerServingPort } from './serving-port.js';

export interface StartRealViteOptions {
  /** VFS root the dev server serves from. */
  root: string;
  /** Virtual routing port the facet is registered on. */
  port: number;
  /** Mount base baked into the facet's vite `base` config. */
  basePath: string;
  /** Directory the user's vite.config.{ts,js,mjs} is searched in (the shell
   *  cwd at start). Persisted so restore can re-bundle it. */
  configDir: string;
  /**
   * The process-table cwd+argv the dev server's pid is given — what the app
   * verbs derive its identity from — and who it runs as. The `vite` builtin
   * passes the wrapper pid's own (or the argv it was invoked with, under the
   * command's credential); restore passes what was persisted, so the
   * restored server is the same application, run by the same principal.
   * `execId` is the exec id the pid carries: the `vite` command's, or what
   * restore persisted.
   */
  identity: DevServerIdentity;
  /** Optional abort signal threaded into the heavy-alloc gate. */
  signal?: AbortSignal;
  /** Called with a human message if vite.config pre-bundling fails (so the
   *  `vite` builtin can surface it on stderr). Restore passes nothing. */
  onConfigError?: (message: string) => void;
}

/** Who a dev server's pid is: the cwd+argv its identity derives from, its credential, and its exec id when it has one. */
export interface DevServerIdentity {
  cwd: string;
  argv: string[];
  cred: VfsCred;
  execId?: string;
}

/** What a dev server's pid is persisted as, and given back on restore. */
export function devServerIdentity(entry: ProcessEntry): DevServerIdentity {
  return { cwd: entry.cwd, argv: entry.argv, cred: entry.cred, ...execIdField(entry) };
}

/**
 * A persisted dev-server identity, read back; undefined for a config written
 * before it recorded who the server ran as, which is not restored: it would
 * read the project as someone else.
 */
export function persistedIdentity(value: unknown): DevServerIdentity | undefined {
  const identity = value as { cwd?: unknown; argv?: unknown; cred?: unknown; execId?: unknown } | null | undefined;
  if (typeof identity?.cwd !== 'string' || !Array.isArray(identity.argv)) return undefined;
  const cred = identity.cred;
  if (!isVfsCred(cred)) return undefined;
  return {
    cwd: identity.cwd,
    argv: identity.argv.map(String),
    cred,
    ...(typeof identity.execId === 'string' ? { execId: identity.execId } : {}),
  };
}


export interface StartRealViteResult {
  cirrusReal: CirrusReal;
  /** The bundled vite.config source, or null when there was none / it failed. */
  userConfigBundle: string | null;
  /** The resolved vite.config path, or null. */
  cfgPath: string | null;
}

/**
 * Boot a cirrus-real dev server on `self`, register its port, and persist the
 * config restore needs. `self` is the session host (RoutesHost/InitHost = any).
 */
export async function startRealVite(self: any, opts: StartRealViteOptions): Promise<StartRealViteResult> {
  if (self.cirrusReal?.isRunning) self.cirrusReal.stop(self.ctx);

  // The user's vite.config is found and bundled as the principal the server
  // runs as: a config importing a file that principal may not read is refused.
  const callerFs = self.sqliteFs!.as(opts.identity.cred);

  // Reserve the full supervisor allocation budget so a fire-and-forget
  // pre-bundle or VFS payload cannot overlap the cirrus-real boot payload
  // (user-vite-config esbuild bundle, plugin-react bundle, syntheticCode with
  // snapshotFiles inlined, LOADER.load worker bundle). Peak pressure on a
  // shared isolate is what kills us, not steady state. Released in a finally so
  // a throw in the boot path doesn't permanently hold the shared budget.
  const heavyAllocRelease = await acquireHeavyAlloc(opts.signal);
  try {
    // Pre-bundle the user's vite.config if present. Plugin imports
    // (@vitejs/plugin-react, vite-plugin-svgr, …) live in the project's
    // node_modules; esbuild resolves them against the VFS via EsbuildService,
    // then emits an ESM string the facet imports as user-vite-config.js.
    let userConfigBundle: string | null = null;
    // Extra synthetic files to seed into the facet's fs snapshot (e.g.
    // plugin-react reads ./refreshUtils.js at transform time).
    const extraSyntheticFiles: Record<string, string> = {};
    const cfgPath = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']
      .map((name) => opts.configDir + '/' + name)
      .find((p) => callerFs.exists(p)) ?? null;
    if (cfgPath) {
      try {
        if (!self.esbuildService) self.esbuildService = supervisorEsbuildService(self.ctx, self.env, self.getFilesystemAuthority().namespaceFs(CRED_KERNEL));
        const bundleResult = await self.esbuildService.build([cfgPath], {
          bundle: true,
          format: 'esm',
          target: 'es2022',
          platform: 'neutral',
          // Path C externals: vite + @vitejs/plugin-react are provided by the
          // facet as prebundled modules; anything else the user imports falls
          // through to esbuild bundling (works when assets fully inline).
          external: [
            'node:*', 'fs', 'path', 'url', 'util', 'os', 'crypto',
            'events', 'stream', 'buffer', 'module', 'perf_hooks',
            'esbuild', 'esbuild-wasm',
            'vite', 'vite/*',
            '@vitejs/plugin-react', '@vitejs/plugin-react/*',
          ],
          // Give bundled user config a stable module URL so plugins resolving
          // files relative to import.meta.url find their synthetic install.
          define: {
            'import.meta.url': JSON.stringify('file:///user-vite-config.js'),
          },
          keepNames: true,
          fs: callerFs,
        });
        const out = bundleResult.outputFiles?.[0];
        if (out) {
          userConfigBundle = rewriteCirrusViteConfigBundle(String(out.contents));
          if (bundleResult.errors?.length) {
            console.warn('[vite-cmd] esbuild bundle errors:', bundleResult.errors);
          }
        } else {
          console.warn('[vite-cmd] esbuild.build produced no output');
        }
      } catch (e: any) {
        opts.onConfigError?.(e?.message || String(e));
      }
    }

    const cirrusReal = new CirrusReal({
      env: self.env,
      port: opts.port,
      root: opts.root,
      basePath: opts.basePath,
      vfs: self.sqliteFs!,
      cred: opts.identity.cred,
      vfsEvents: self.sqliteFs!.events,
      userConfigBundle,
      extraSyntheticFiles,
      network: self.runtimeWorkspace!.network,
    });
    self.cirrusReal = cirrusReal;
    // Reserve a PID so `ps`/logs show it like any other facet.
    // Its facet's syscalls answer under this pid's credential.
    const entry = self.processes.spawn(
      'vite (real, ' + opts.root + ')', opts.identity.argv, opts.identity.cwd,
      { longRunning: true, cred: opts.identity.cred, execId: opts.identity.execId },
    );
    // start() is async — it ASSETS-fetches the Vite/plugin-react bundles on
    // first invocation (cached per-isolate after).
    await cirrusReal.start(self.ctx, entry.pid);
    // Primitive #3 — register the port the same way the Cirrus shim does; the
    // only difference is which handler.handleRequest the stub forwards into.
    const cirrusStub = makeLongRunningPortStub(cirrusReal);
    self.portRegistry.bindFacetStub(entry.pid, cirrusStub);
    await registerServingPort(self, entry.pid, opts.port);
    self._viteShimPid = entry.pid;
    self._viteShimPort = opts.port;

    // Persist so the session recovers after hibernation — same key the shim
    // uses, tagged so restore rebuilds real-vite. configDir is recorded so the
    // restore can re-bundle the same vite.config from the (persisted) VFS.
    try {
      await self.ctx.storage.put(VITE_CONFIG_KEY, {
        devServer: 'real',
        root: opts.root,
        port: opts.port,
        basePath: opts.basePath,
        configDir: opts.configDir,
        identity: devServerIdentity(entry),
      });
    } catch { /* persistence is best-effort; the server still serves now */ }

    return { cirrusReal, userConfigBundle, cfgPath };
  } finally {
    // Cirrus-real boot allocation done (or threw). Always restore the shared
    // capacity so queued allocators can resume.
    heavyAllocRelease();
  }
}
