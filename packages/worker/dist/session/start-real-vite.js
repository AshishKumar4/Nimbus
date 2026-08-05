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
import { CRED_KERNEL } from '../runtime/os-contracts.js';
import { EsbuildService } from '../runtime/esbuild-service.js';
import { rewriteCirrusViteConfigBundle } from '../runtime/cirrus-vite-config-rewriter.js';
import { CirrusReal } from '../facets/cirrus-real.js';
import { makeLongRunningPortStub } from '../runtime/long-running-handle.js';
import { acquireHeavyAlloc } from '../observability/heavy-alloc-coord.js';
import { VITE_CONFIG_KEY } from './keys.js';
/**
 * Boot a cirrus-real dev server on `self`, register its port, and persist the
 * config restore needs. `self` is the session host (RoutesHost/InitHost = any).
 */
export async function startRealVite(self, opts) {
    if (self.cirrusReal?.isRunning)
        self.cirrusReal.stop(self.ctx);
    const kernelFs = self.sqliteFs.as(CRED_KERNEL);
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
        let userConfigBundle = null;
        // Extra synthetic files to seed into the facet's fs snapshot (e.g.
        // plugin-react reads ./refreshUtils.js at transform time).
        const extraSyntheticFiles = {};
        const cfgPath = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']
            .map((name) => opts.configDir + '/' + name)
            .find((p) => kernelFs.exists(p)) ?? null;
        if (cfgPath) {
            try {
                if (!self.esbuildService)
                    self.esbuildService = new EsbuildService(self.sqliteFs);
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
                });
                const out = bundleResult.outputFiles?.[0];
                if (out) {
                    userConfigBundle = rewriteCirrusViteConfigBundle(String(out.contents));
                    if (bundleResult.errors?.length) {
                        console.warn('[vite-cmd] esbuild bundle errors:', bundleResult.errors);
                    }
                }
                else {
                    console.warn('[vite-cmd] esbuild.build produced no output');
                }
            }
            catch (e) {
                opts.onConfigError?.(e?.message || String(e));
            }
        }
        const cirrusReal = new CirrusReal({
            env: self.env,
            port: opts.port,
            root: opts.root,
            basePath: opts.basePath,
            vfs: self.sqliteFs,
            vfsEvents: self.sqliteFs.events,
            userConfigBundle,
            extraSyntheticFiles,
        });
        self.cirrusReal = cirrusReal;
        // Reserve a PID so `ps`/logs show it like any other facet.
        const entry = self.processes.spawn('vite (real, ' + opts.root + ')', [], opts.root, { longRunning: true });
        // start() is async — it ASSETS-fetches the Vite/plugin-react bundles on
        // first invocation (cached per-isolate after).
        await cirrusReal.start(self.ctx, entry.pid);
        // Primitive #3 — register the port the same way the Cirrus shim does; the
        // only difference is which handler.handleRequest the stub forwards into.
        const cirrusStub = makeLongRunningPortStub(cirrusReal);
        self.portRegistry.bindFacetStub(entry.pid, cirrusStub);
        self.portRegistry.register(opts.port, entry.pid);
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
            });
        }
        catch { /* persistence is best-effort; the server still serves now */ }
        return { cirrusReal, userConfigBundle, cfgPath };
    }
    finally {
        // Cirrus-real boot allocation done (or threw). Always restore the shared
        // capacity so queued allocators can resume.
        heavyAllocRelease();
    }
}
