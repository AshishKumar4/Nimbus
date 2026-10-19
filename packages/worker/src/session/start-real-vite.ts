/**
 * start-real-vite.ts — how the `vite` builtin boots a cirrus-real (real
 * `vite`) dev server (opt-in via NIMBUS_REAL_VITE=1 or `nimbusDevServer:
 * 'real'`). Booting is heavy: it pre-bundles the user's vite.config against
 * the VFS, allocates the facet payload, and launches the server as one of the
 * session's resident processes. A new incarnation of the session boots it
 * again by running the `vite` command again (dev-servers.ts).
 */

import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { ProcessRestart } from '@nimbus-sh/core/runtime/process-table.js';
import { supervisorEsbuildService } from '../facets/esbuild-transform.js';
import { rewriteCirrusViteConfigBundle } from '@nimbus-sh/core/runtime/cirrus-vite-config-rewriter.js';
import { CirrusReal } from '../facets/cirrus-real.js';
import { acquireHeavyAlloc } from '@nimbus-sh/platform/heavy-alloc-coord.js';
import { withRecall } from '@nimbus-sh/core/vfs/recall.js';

export interface StartRealViteOptions {
  /** VFS root the dev server serves from. */
  root: string;
  /** Virtual routing port the facet is registered on. */
  port: number;
  /** Mount base baked into the facet's vite `base` config. */
  basePath: string;
  /** Directory the user's vite.config.{ts,js,mjs} is searched in (the shell
   *  cwd at start). */
  configDir: string;
  /**
   * The process-table cwd+argv the dev server's pid is given — what the app
   * verbs derive its identity from — and who it runs as: the wrapper pid's
   * own, or the command's line, under its credential (devServerSpawn).
   * `execId` is the exec id the pid carries.
   */
  identity: DevServerIdentity;
  /** Optional abort signal threaded into the heavy-alloc gate. */
  signal?: AbortSignal;
  /** Called with a human message if vite.config pre-bundling fails (so the
   *  `vite` builtin can surface it on stderr). */
  onConfigError?: (message: string) => void;
}

/** Who a dev server's pid is: the cwd+argv its identity derives from, its credential, its exec id when it has one, and the process it restarts when it is a restore's. */
export interface DevServerIdentity {
  cwd: string;
  argv: string[];
  cred: VfsCred;
  execId?: string;
  restartedFrom?: ProcessRestart;
}


export interface StartRealViteResult {
  cirrusReal: CirrusReal;
  /** The bundled vite.config source, or null when there was none / it failed. */
  userConfigBundle: string | null;
  /** The resolved vite.config path, or null. */
  cfgPath: string | null;
}

/**
 * Boot a cirrus-real dev server on `self` as a resident process serving its
 * port. One already running is ended first. `self` is the session host
 * (InitHost = any).
 */
export async function startRealVite(self: any, opts: StartRealViteOptions): Promise<StartRealViteResult> {
  self.ensureFacetManager();
  if (self.cirrusReal?.isRunning) self.facetManager.kill(self.cirrusReal.pid, 'TERM');

  // The user's vite.config is found and bundled as the principal the server
  // runs as: a config importing a file that principal may not read is refused.
  const callerFs = self.sqliteFs!.as(opts.identity.cred);

  // Reserve the full supervisor allocation budget so a fire-and-forget
  // pre-bundle or VFS payload cannot overlap the cirrus-real boot payload
  // (user-vite-config esbuild bundle, plugin-react bundle, syntheticCode with
  // snapshotFiles inlined, the resident's module map). Peak pressure on a
  // shared isolate is what kills us, not steady state. Released in a finally so
  // a throw in the boot path doesn't permanently hold the shared budget.
  const heavyAllocRelease = await acquireHeavyAlloc(opts.signal, { owner: 'cirrus-real startup', session: self.ctx?.id?.toString() });
  try {
    // Pre-bundle the user's vite.config if present. Plugin imports
    // (@vitejs/plugin-react, vite-plugin-svgr, …) live in the project's
    // node_modules; esbuild resolves them against the VFS via EsbuildService,
    // then emits an ESM string the facet imports as user-vite-config.js.
    let userConfigBundle: string | null = null;
    // Extra synthetic files to seed into the facet's fs snapshot (e.g.
    // plugin-react reads ./refreshUtils.js at transform time).
    const extraSyntheticFiles: Record<string, string> = {};
    // A read of the project waits for a delegation it meets (withRecall; the bundle's reads wait in the build).
    const cfgPath = await withRecall(() => ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']
      .map((name) => opts.configDir + '/' + name)
      .find((p) => callerFs.exists(p)) ?? null);
    if (cfgPath) {
      try {
        if (!self.esbuildService) self.esbuildService = supervisorEsbuildService(self.ctx, self.env, self.getFilesystemAuthority().namespaceFs(CRED_SESSION_USER));
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
      namespace: self.getFilesystemAuthority().vfs,
      userConfigBundle,
      extraSyntheticFiles,
    });
    self.cirrusReal = cirrusReal;
    // The server's process answers its syscalls under the identity's
    // credential, and is up once Vite listens.
    await cirrusReal.start(self.ctx, self.facetManager, self.processes, opts.identity);

    return { cirrusReal, userConfigBundle, cfgPath };
  } finally {
    // Cirrus-real boot allocation done (or threw). Always restore the shared
    // capacity so queued allocators can resume.
    heavyAllocRelease();
  }
}
