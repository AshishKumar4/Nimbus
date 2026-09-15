/**
 * session/vite-command.ts — the `vite` builtin command.
 *
 * Extracted from init.ts so the handler can be driven through the
 * command registry in unit tests — the module's only session coupling
 * is `self`, the same InitHost view initSession passes to every other
 * registration.
 *
 * Subcommands: `vite` (dev server), `vite build`, `vite preview`,
 * `vite stop`. Build honours build.outDir with Vite parity: output
 * writes to the resolved path, only an outDir strictly inside the
 * project root is emptied first, and the bundle is validated before
 * old output is cleared.
 */

import { normalizeVfsPath, parentVfsPath, resolveVfsPath, stripLeadingSlashes } from '@nimbus-sh/core/vfs/path.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { parseViteConfigSource, viteBuildBlockingPlugins, unhandledVitePlugins, type ParsedViteConfig } from '@nimbus-sh/core/runtime/vite-config-parser.js';
import { findHtmlScriptEntrypoint, rewriteViteBuildHtml } from '../runtime/html-entrypoint.js';
import { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { ViteDevServer } from '../facets/vite-dev-server.js';
import { shouldUseRealVite } from '../facets/cirrus-real.js';
import {
  makeLongRunningPortStub,
  resolveLongRunningPort,
  expandArgvShellDefaults,
} from '@nimbus-sh/core/runtime/long-running-handle.js';
import {
  checkNodeModulesGuard,
  withLoudTimeout,
  VITE_BUILD_TIMEOUT_MS,
} from './helpers.js';
import { startRealVite } from './start-real-vite.js';
import { notifyTerminalEvent } from '../runtime/process-logs-api.js';
import { VITE_CONFIG_KEY } from './keys.js';
import { registerServingPort } from './serving-port.js';

type ViteHost = any;

export function createViteCommand(self: ViteHost) {
  return async (ctx: any): Promise<number> => {
    const args: string[] = ctx.args || [];
    const cwd = normalizeVfsPath(ctx.cwd || '/home/user');

    if (args.includes('--help') || args.includes('-h')) {
      ctx.stdout.write('Usage: vite [command] [options]\n\n');
      ctx.stdout.write('Commands:\n');
      ctx.stdout.write('  (default)   Start dev server\n');
      ctx.stdout.write('  build       Build for production\n');
      ctx.stdout.write('  preview     Serve the built dist/\n');
      ctx.stdout.write('  stop        Stop dev server\n\n');
      ctx.stdout.write('Options:\n');
      ctx.stdout.write('  --root <dir>  Project root\n');
      ctx.stdout.write('  --port <n>    Server port\n');
      return 0;
    }

    self.ensureSqliteFs();
    const kernelFs = self.sqliteFs!.as(CRED_KERNEL);

    const viteConfig: ParsedViteConfig = {};
    for (const cfgName of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
      const cfgPath = cwd + '/' + cfgName;
      if (kernelFs.exists(cfgPath)) {
        try {
          let cfgCode = kernelFs.readFileString(cfgPath);
          // Transform TS to JS
          if (cfgName.endsWith('.ts')) {
            if (!self.esbuildService) self.esbuildService = new EsbuildService(kernelFs);
            const t = await self.esbuildService.transform(cfgCode, { loader: 'ts', format: 'esm' });
            cfgCode = t.code;
          }
          Object.assign(viteConfig, parseViteConfigSource(cfgCode));
        } catch (e: any) {
          ctx.stderr.write(`Warning: could not parse ${cfgName}: ${e?.message}\n`);
        }
        break;
      }
    }

    // ── vite build ──
    if (args[0] === 'build') {
      // Capability gate: the built-in builder is esbuild underneath and
      // never evaluates vite.config `plugins`. Only framework plugins
      // (SvelteKit, Vue, Solid) mean the project is not a plain-Vite
      // app — they would die deep in esbuild on an entry point that
      // does not exist or framework syntax the JS loader cannot parse,
      // so say what is actually wrong. Every other plugin is a
      // warning, not a refusal.
      const blockingPlugins = viteBuildBlockingPlugins(viteConfig);
      if (blockingPlugins.length) {
        ctx.stderr.write(
          '\x1b[31m✘\x1b[0m vite build: this project needs Vite plugins the built-in build server cannot run' +
          ' (' + blockingPlugins.join(', ') + ').\n' +
          '  The built-in Vite server supports plain Vite projects (React, JSX/TS, CSS, and asset imports);\n' +
          '  framework projects like SvelteKit, Vue, Solid, or Astro require a real Vite —\n' +
          '  Nimbus does not run one for `vite build` yet.\n'
        );
        return 1;
      }
      const buildSkippedPlugins = unhandledVitePlugins(viteConfig);
      if (buildSkippedPlugins.length) {
        ctx.stderr.write(
          '\x1b[33m!\x1b[0m vite build: skipping plugins the built-in build cannot run' +
          ' (' + buildSkippedPlugins.join(', ') + '); output is the plain-Vite bundle.\n'
        );
      }

      if (!self.esbuildService) self.esbuildService = new EsbuildService(kernelFs);
      const htmlPath = cwd + '/index.html';
      let entryPoint = cwd + '/src/main.tsx';
      let origHtml = '';
      try {
        origHtml = kernelFs.readFileString(htmlPath);
        const htmlEntrypoint = await findHtmlScriptEntrypoint(origHtml);
        if (htmlEntrypoint) entryPoint = cwd + '/' + stripLeadingSlashes(htmlEntrypoint);
      } catch { ctx.stderr.write('Warning: no index.html\n'); }
      if (!kernelFs.exists(entryPoint)) {
        const alts = [cwd+'/src/main.tsx', cwd+'/src/main.ts', cwd+'/src/index.tsx', cwd+'/src/index.ts'];
        entryPoint = alts.find(p => kernelFs.exists(p)) || entryPoint;
      }
      if (!kernelFs.exists(entryPoint)) {
        ctx.stderr.write(
          '\x1b[31m✘\x1b[0m vite build: no entry point — index.html declares no <script src> and none of\n' +
          '  src/main.{tsx,ts} or src/index.{tsx,ts} exists. The built-in build server handles plain\n' +
          '  Vite apps; projects with other layouts need a real Vite.\n'
        );
        return 1;
      }

      ctx.stdout.write('Building for production...\n');
      ctx.stdout.write('  Entry: ' + entryPoint + '\n');
      const t0 = Date.now();

      try {
        // Vite parity: build writes to the resolved outDir wherever it
        // lands inside the VFS — the common monorepo layout builds the
        // frontend into ../server/public. Only the empty step is gated:
        // an outDir not strictly inside the project root is never
        // emptied (outDir == root is not inside), and Vite's warning is
        // printed verbatim.
        const outDir = viteConfig.outDir || 'dist';
        const resolvedOutDir = resolveVfsPath(outDir, cwd);
        const insideRoot = resolvedOutDir.length > cwd.length && resolvedOutDir.startsWith(cwd + '/');
        const distDir = resolvedOutDir;
        if (!insideRoot) {
          ctx.stderr.write(
            `\x1b[33m(!)\x1b[0m outDir ${resolvedOutDir} is not inside project root and will not be emptied.\n`,
          );
        }
        const publicDir = cwd + '/public';
        const hasPublic = kernelFs.exists(publicDir) && kernelFs.isDirectory(publicDir);

        // Detect which packages are installed vs need CDN
        const nmDir = cwd + '/node_modules';
        const externals: string[] = [];
        const cdnPackages: string[] = [];
        for (const pkg of ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client']) {
          const pkgBase = pkg.split('/')[0];
          if (!kernelFs.exists(nmDir + '/' + pkgBase)) {
            externals.push(pkg);
            if (!cdnPackages.includes(pkgBase)) cdnPackages.push(pkgBase);
          }
        }
        if (viteConfig.alias) externals.push(...Object.keys(viteConfig.alias));

        // vite-equivalent output layout: dist/assets/<name>-<hash>.<ext>
        // for both the entry and every emitted asset — entryNames +
        // assetNames is what makes esbuild's `file` loader land there.
        // Bounded (G5): an esbuild stall must surface as a loud timeout
        // naming the entry, never a silent hang. The existing catch below
        // renders the timeout as `Build error: …`.
        ctx.stdout.write('  Bundling ' + entryPoint + ' …\n');
        const result: any = await withLoudTimeout(
          self.esbuildService.build([entryPoint], {
            bundle: true, format: 'esm', target: 'es2020', platform: 'browser',
            minify: true, outdir: distDir,
            entryNames: 'assets/[name]-[hash]',
            chunkNames: 'assets/[name]-[hash]',
            assetNames: 'assets/[name]-[hash]',
            external: externals.length > 0 ? externals : undefined,
            viteAssets: true,
            vitePublicDir: hasPublic ? publicDir : undefined,
          }),
          VITE_BUILD_TIMEOUT_MS,
          `vite build of ${entryPoint}`,
        );
        if (result.errors?.length) {
          for (const e of result.errors) ctx.stderr.write('  error: ' + e.text + '\n');
          return 1;
        }
        // The entry output must exist before old output is cleared —
        // a failed build must never wipe the previously-good dist/.
        const entryOutputRel = Object.entries(result.metafile?.outputs || {})
          .find(([, o]: [string, any]) => o.entryPoint)?.[0]?.replace(/^\/+/, '');
        const entryJs = (entryOutputRel
          ? result.outputFiles.find((f: any) => f.path.replace(/^\/+/, '') === entryOutputRel)
          : undefined) ?? result.outputFiles.find((f: any) => f.path.endsWith('.js'));
        if (!entryJs) {
          ctx.stderr.write('Build error: bundler produced no JS output\n');
          return 1;
        }
        const jsFilename = entryJs.path.slice(entryJs.path.lastIndexOf('/') + 1);

        // Vite's emptyOutDir: stale hashed outputs must not accumulate.
        // Only an outDir strictly inside the project root is emptied —
        // the warning above covered the rest.
        if (insideRoot && kernelFs.exists(distDir)) {
          kernelFs.removeRecursive(distDir);
        }
        kernelFs.mkdir(distDir, { recursive: true });

        // CSS bundled through the entry imports (and its url() assets)
        // arrives as the entry's cssBundle sidecar — esbuild already
        // rewrote every url() to the hashed emitted path.
        const cssBundlePath = entryOutputRel
          ? result.metafile?.outputs?.[entryOutputRel]?.cssBundle
          : undefined;
        let cssFilename = cssBundlePath
          ? cssBundlePath.slice(cssBundlePath.lastIndexOf('/') + 1)
          : result.outputFiles
            .find((f: any) => f.path.endsWith('.css'))
            ?.path.split('/').pop();

        // Fallback for HTML-linked stylesheets the bundle never saw
        // (`<link href="src/site.css">` in index.html): concatenate what
        // src/ declares, like the pre-asset-pipeline path did.
        let fallbackCss = '';
        if (!cssFilename) {
          const collectCss = (dir: string) => {
            try {
              for (const e of kernelFs.readdir(dir)) {
                const fp = dir + '/' + e.name;
                if (e.type === 'directory') collectCss(fp);
                else if (e.name.endsWith('.css')) {
                  try { fallbackCss += kernelFs.readFileString(fp) + '\n'; } catch {}
                }
              }
            } catch {}
          };
          collectCss(cwd + '/src');
          if (fallbackCss.trim()) {
            const cssHashNum = fallbackCss.split('').reduce((h: number, c: string) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
            cssFilename = 'index-' + (cssHashNum >>> 0).toString(36).padStart(6, '0') + '.css';
          }
        }

        // Write every emitted output (bytes, not text — `file` assets are
        // binary), printing vite-style size lines.
        for (const f of result.outputFiles) {
          const outPath = normalizeVfsPath(f.path);
          const parent = parentVfsPath(outPath);
          if (parent && !kernelFs.exists(parent)) kernelFs.mkdir(parent, { recursive: true });
          kernelFs.writeFile(outPath, f.bytes);
          const rel = outPath.slice(cwd.length + 1);
          ctx.stdout.write('  \x1b[2m' + rel + '\x1b[0m  ' + (f.bytes.length / 1024).toFixed(2) + ' kB\n');
        }
        if (fallbackCss.trim() && cssFilename) {
          const cssPath = distDir + '/assets/' + cssFilename;
          kernelFs.mkdir(distDir + '/assets', { recursive: true });
          kernelFs.writeFile(cssPath, fallbackCss);
          ctx.stdout.write('  \x1b[2m' + outDir + '/assets/' + cssFilename + '\x1b[0m  ' + (fallbackCss.length / 1024).toFixed(2) + ' kB\n');
        }

        // public/ copies verbatim to dist/ (same `vite build` semantics —
        // the favicon the template references lives there).
        if (hasPublic) {
          const copyTree = (src: string, dst: string) => {
            for (const e of kernelFs.readdir(src)) {
              const s = src + '/' + e.name;
              const d = dst + '/' + e.name;
              if (e.type === 'directory') { copyTree(s, d); }
              else {
                const parent = parentVfsPath(d);
                if (parent && !kernelFs.exists(parent)) kernelFs.mkdir(parent, { recursive: true });
                kernelFs.writeFile(d, kernelFs.readFile(s));
              }
            }
          };
          copyTree(publicDir, distDir);
        }

        // Generate dist/index.html
        if (origHtml) {
          const distHtml = await rewriteViteBuildHtml(origHtml, {
            jsFilename,
            cssFilename,
            removeImportMap: cdnPackages.length === 0,
            injectCss: true,
          });
          kernelFs.writeFile(distDir + '/index.html', distHtml);
          ctx.stdout.write('  \x1b[2m' + outDir + '/index.html\x1b[0m  ' + (distHtml.length / 1024).toFixed(2) + ' kB\n');
          if (cdnPackages.length > 0) {
            ctx.stdout.write('  \x1b[33mNote: ' + cdnPackages.join(', ') + ' loaded from CDN (not bundled)\x1b[0m\n');
          }
        }

        ctx.stdout.write('\n\x1b[32m✓ built in ' + ((Date.now() - t0) / 1000).toFixed(2) + 's\x1b[0m\n');
        return 0;
      } catch (e) {
        ctx.stderr.write('Build error: ' + errorText(e) + '\n');
        return 1;
      }
    }

    // ── vite preview ──
    if (args[0] === 'preview') {
      ctx.stdout.write('Serving dist/ — open ' + self.viteBasePath + '/\n');
      // Vite parity: preview serves the resolved outDir wherever it
      // landed — build wrote there, so preview must read there.
      const distRoot = resolveVfsPath(viteConfig.outDir || 'dist', cwd);
      if (!kernelFs.exists(distRoot)) {
        ctx.stderr.write('dist/ not found. Run vite build first.\n');
        return 1;
      }
      // Start vite on the dist directory
      if (!self.esbuildService) self.esbuildService = new EsbuildService(kernelFs);
      if (self.viteDevServer?.isRunning) self.viteDevServer.stop();
      const previewBasePath = self.viteBasePath;
      // process metadata support: same long-running treatment as the
      // dev path, just on the dist/ directory.
      const previewPort = viteConfig.port || 4173; // vite preview default
      const previewProcEntry = self.processes.spawn(
        'vite preview (' + distRoot + ')', ['vite', ...args], distRoot,
        { longRunning: true },
      );
      self.viteDevServer = new ViteDevServer({
        vfs: self.sqliteFs!, esbuild: self.esbuildService!, root: distRoot,
        onHmrMessage: () => {},
        sql: self.ctx.storage.sql,
        basePath: previewBasePath,
        env: self.env,
        ctx: self.ctx,
        bundlePool: self.ensureBundlePool(),
        port: previewPort,
        pid: previewProcEntry.pid,
        processes: self.processes,
      });
      self.viteDevServer.start();
      try {
        const previewStub = makeLongRunningPortStub(self.viteDevServer);
        self.portRegistry.bindFacetStub(previewProcEntry.pid, previewStub);
        await registerServingPort(self, previewProcEntry.pid, previewPort);
        self._viteShimPid = previewProcEntry.pid;
        self._viteShimPort = previewPort;
      } catch {}
      try {
        await self.ctx.storage.put(VITE_CONFIG_KEY, {
          root: distRoot, basePath: previewBasePath, port: previewPort,
          identity: { cwd: previewProcEntry.cwd, argv: previewProcEntry.argv },
        });
      } catch {}
      ctx.stdout.write('Serving at ' + previewBasePath + '/ \x1b[2m(pid=' + previewProcEntry.pid + ', port=' + previewPort + ')\x1b[0m\n');
      return 0;
    }

    // ── vite stop ──
    if (args[0] === 'stop') {
      let stopped = false;
      if (self.cirrusReal?.isRunning) {
        self.cirrusReal.stop(self.ctx);
        self.cirrusReal = null;
        stopped = true;
      }
      if (self.viteDevServer?.isRunning) {
        self.viteDevServer.stop();
        self.viteDevServer = null;
        try { await self.ctx.storage.delete(VITE_CONFIG_KEY); } catch {}
        stopped = true;
      }
      // Primitive #3 teardown — symmetric with the start path. Always
      // safe to call: unregisterByPid is idempotent, exit() guards
      // against re-marking already-terminal entries.
      if (self._viteShimPid != null) {
        try { self.portRegistry.unregisterByPid(self._viteShimPid); } catch {}
        try { self.processes.exit(self._viteShimPid, 0); } catch {}
        notifyTerminalEvent(self.terminal, {
          type: 'exit', pid: self._viteShimPid, code: 0, command: 'vite',
        });
        self._viteShimPid = null;
        self._viteShimPort = null;
      }
      if (stopped) {
        ctx.stdout.write('\x1b[33mDev server stopped.\x1b[0m\n');
      } else {
        ctx.stdout.write('No dev server running.\n');
      }
      return 0;
    }

    // ── vite (default: dev server) ──
    let vfsRoot = cwd;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--root' && args[i + 1]) vfsRoot = resolveVfsPath(args[i + 1], cwd);
    }
    if (viteConfig.root && viteConfig.root !== '.') {
      vfsRoot = resolveVfsPath(viteConfig.root, cwd);
    }
    vfsRoot = normalizeVfsPath(vfsRoot);

    // Argv expansion: package.json scripts commonly write
    // `--port ${PORT:-3000}`. Resolve it once and feed both Vite
    // backends so `/api/stats`, `/preview/`, and port tabs agree.
    const expandedArgs = expandArgvShellDefaults(args, ctx.env || {});
    const vitePortDefault = 5173;
    const resolvedPort = resolveLongRunningPort({
      argv: expandedArgs,
      env: ctx.env,
      configPort: viteConfig.port,
      fallback: vitePortDefault,
    });

    // ── Preflight: node_modules guard ────────────────────────────────────
    // Direct `vite` invocation requires installed deps. Bail loudly BEFORE
    // spawning a dev server that would just serve broken modules and
    // confuse the user. --force / --no-install-check bypasses the check.
    const bypassInstallCheck = expandedArgs.includes('--force') || expandedArgs.includes('--no-install-check');
    if (!bypassInstallCheck) {
      const guard = checkNodeModulesGuard(kernelFs, vfsRoot);
      if (guard.missing) {
        ctx.stderr.write(
          '\x1b[31m\u2718\x1b[0m \x1b[1mnode_modules/ not found\x1b[0m' +
          (guard.depCount > 0 ? ` (${guard.depCount} dependencies declared)` : '') + '\n' +
          '  Run \x1b[36mnpm install\x1b[0m in ' + vfsRoot + ' first,\n' +
          '  or re-run with \x1b[36m--force\x1b[0m to skip this check.\n'
        );
        return 1;
      }
    }

    if (self.viteDevServer?.isRunning) self.viteDevServer.stop();

    // ── Real-vite mode (Phase 0 spike, opt-in) ─────────────────────────
    // NIMBUS_REAL_VITE=1 or `nimbusDevServer: 'real'` in vite.config.ts
    // routes the session through a dynamic-worker facet running the
    // real `vite` npm package. The in-process Cirrus shim is bypassed.
    //
    // This is EXPERIMENTAL and gated behind an explicit opt-in. Any
    // error here falls back to Cirrus by the user re-running without
    // the env flag — we do not silently fall back (fidelity over
    // magic).
    const sessionEnv = (ctx && ctx.env) || {};
    const useReal = shouldUseRealVite({ env: sessionEnv, viteConfig });
    // Long-running handoff (bin-spawn contract): when invoked from a
    // wrapper that already allocated a pid (`npm run dev` via
    // shellExecuteTracked, the npm-bin resolver, the SDK's startProcess),
    // ADOPT that pid instead of spawning a second one. One pid, one start
    // banner, no false exit — and one identity: the process table's
    // cwd+argv for that pid is what the app verbs derive the dev server's
    // owner from, so it is persisted with the config and given back to
    // the entry a hibernation restore allocates.
    const binSpawn = ctx.__nimbusBinSpawn as
      | { skipSpawn?: boolean; callerPid?: number }
      | undefined;
    const adoptedEntry =
      binSpawn?.skipSpawn && binSpawn.callerPid != null
        ? self.processes.get(binSpawn.callerPid)
        : undefined;
    const handedOff = adoptedEntry != null;
    const identity = adoptedEntry
      ? { cwd: adoptedEntry.cwd, argv: adoptedEntry.argv }
      : { cwd: vfsRoot, argv: expandedArgs };
    if (useReal) {
      const vitePort = resolvedPort;
      const previewBasePath = self.viteBasePath;

      // One boot path, shared with hibernation-restore (start-real-vite.ts):
      // pre-bundles the user's vite.config, boots the facet, registers the
      // port, and persists the vite-config so a woken session rebuilds the
      // same real-vite server. Only the banner below is command-specific.
      const { cirrusReal, userConfigBundle, cfgPath } = await startRealVite(self, {
        root: vfsRoot,
        port: vitePort,
        basePath: previewBasePath,
        configDir: cwd,
        identity,
        signal: ctx.signal,
        onConfigError: (msg) => {
          ctx.stderr.write('\x1b[33m!\x1b[0m vite.config bundling failed: ' + msg + '\n');
          ctx.stderr.write('  Real-vite will run with default config.\n');
        },
      });

      {
        // ── Boot banner (§4.3 of PHASE2-REAL-VITE-PLAN.md) ──────
        const snap = (cirrusReal.stats as any).snapshot;
        ctx.stdout.write('\n\x1b[1;36m  Nimbus: real-vite mode\x1b[0m \x1b[2m(experimental, Phase 1-4)\x1b[0m\n\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Preview:    \x1b[36m' + previewBasePath + '/\x1b[0m\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Vite:       ' + (cirrusReal.stats as any).viteVersion + ' (bundled)\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Root:       ' + vfsRoot + '\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Port:       ' + vitePort + ' \x1b[2m(virtual routing key)\x1b[0m\n');
        if (snap) {
          const kb = (snap.totalBytes / 1024).toFixed(1);
          const pkgJson = (snap as any).packageJsonCount;
          ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Snapshot:   ' + snap.fileCount + ' files / ' +
            kb + ' KB ' +
            (pkgJson ? '\x1b[2m(incl. ' + pkgJson + ' package.json, rest lazy)\x1b[0m' : '') + '\n');
        }
        if (userConfigBundle) {
          ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Config:     ' + cfgPath + ' \x1b[2m(' +
            (userConfigBundle.length / 1024).toFixed(0) + ' KB bundled)\x1b[0m\n');
        }
        ctx.stdout.write('\n  \x1b[2mWorks:\x1b[0m @vitejs/plugin-react, JSX/TSX transforms, SPA fallback, HMR.\n');
        ctx.stdout.write('  \x1b[2mPartial:\x1b[0m other plugins (Babel-family generally OK; SWC/Rolldown blocked).\n');
        ctx.stdout.write('  \x1b[2mBlocked:\x1b[0m vite build (rolldown needs node:wasi). Use cirrus for build.\n');
        ctx.stdout.write('\n  \x1b[2mRun \x1b[0mvite stop\x1b[2m, or \x1b[0mNIMBUS_REAL_VITE=0 vite\x1b[2m for Cirrus.\x1b[0m\n\n');
        return 0;
      }
    }

    // The built-in dev server evaluates no vite.config `plugins`, but it
    // never refuses on them: plain-Vite apps routinely declare plugins
    // the shim covers (react, cloudflare, tailwind) or doesn't need
    // (watch/reload hooks). One warning line for the plugins it can't
    // run — frameworks land there too: their pages won't render, but the
    // server itself still serves, which is the pre-diagnostic behavior.
    const devSkipped = [
      ...viteBuildBlockingPlugins(viteConfig),
      ...unhandledVitePlugins(viteConfig),
    ];
    if (devSkipped.length) {
      ctx.stderr.write(
        '\x1b[33m!\x1b[0m vite: plugins are not evaluated by the built-in dev server' +
        ' (' + devSkipped.join(', ') + '); serving the plain-Vite app.\n'
      );
    }


    if (!self.esbuildService) self.esbuildService = new EsbuildService(kernelFs);
    const previewBasePath = self.viteBasePath;
    const viteDefine = viteConfig.define;

    // Vite dev servers are represented as long-running process-table
    // entries and port-registry handlers, so `ps`, logs, preview routing,
    // `vite stop`, and `kill <pid>` share the same lifecycle primitives.
    // Allocate PID FIRST so we can plumb it into ViteDevServer's
    // process-log wiring at construction time. The PID stays valid
    // for the life of this dev-server instance; subsequent log lines
    // emitted by ViteDevServer flow into the pid's stderr ring,
    // visible in the Process tab.
    //
    // The adopted wrapper pid stays `running` in /api/processes with this
    // port; a fresh spawn carries the identity inputs computed above.
    const viteProcEntry = adoptedEntry ?? self.processes.spawn(
      'vite (' + vfsRoot + ')',
      identity.argv,
      identity.cwd,
      { longRunning: true },
    );
    if (handedOff) self.processes.setLongRunning(viteProcEntry.pid);

    self.viteDevServer = new ViteDevServer({
      vfs: self.sqliteFs!,
      esbuild: self.esbuildService!,
      root: vfsRoot,
      port: resolvedPort,
      aliases: viteConfig.alias,
      define: viteDefine,
      onHmrMessage: (msg) => {
        if (self.terminal) try { self.terminal!.ws.send(JSON.stringify({ type: 'hmr', data: msg })); } catch {}
      },
      sql: self.ctx.storage.sql,
      injectBasename: viteConfig.injectBasename,
      basePath: previewBasePath,
      env: self.env,
      ctx: self.ctx,
      // The shared bundle pool puts cold /@modules/ misses on the facet
      // path. This site never passed it before, so `vite` served every
      // cold miss through in-supervisor esbuild-wasm.
      bundlePool: self.ensureBundlePool(),
      // Process diagnostics support: wire dev-server diagnostics into the
      // supervisor's per-PID log store so the Process tab is not silent
      // after the banner.
      pid: viteProcEntry.pid,
      processes: self.processes,
    });
    self.viteDevServer.start();
    try {
      await self.ctx.storage.put(VITE_CONFIG_KEY, {
        root: vfsRoot, aliases: viteConfig.alias, define: viteDefine,
        injectBasename: viteConfig.injectBasename, basePath: previewBasePath,
        port: resolvedPort,
        identity: { cwd: viteProcEntry.cwd, argv: viteProcEntry.argv },
      });
    } catch {}

    // Register the port and build the long-running stub. The stub
    // forwards into the in-process viteDevServer through the generic
    // long-running adapter — same hook every future long-running
    // facet uses (Express, Bun.serve, http.createServer().listen()).
    const viteStub = makeLongRunningPortStub(self.viteDevServer);
    self.portRegistry.bindFacetStub(viteProcEntry.pid, viteStub);
    await registerServingPort(self, viteProcEntry.pid, resolvedPort);
    // Track the wiring so `vite stop` and crash-handlers can tear it
    // down without searching the registry.
    self._viteShimPid = viteProcEntry.pid;
    self._viteShimPort = resolvedPort;

    // Spawn / long-running event for the Process tab UI. Mirrors the
    // shellExecuteTracked banner so the user sees the same shape no
    // matter how vite was invoked. Suppressed on handoff — the wrapper
    // already emitted the single start banner and spawn event for this pid.
    if (!handedOff) {
      if (self.terminal) {
        self.terminal.write(
          `\x1b[2m[shell started (long-running): pid=${viteProcEntry.pid} cmd="vite ${expandedArgs.join(' ')}"]\x1b[0m\r\n`,
        );
      }
      notifyTerminalEvent(self.terminal, {
        type: 'spawn',
        pid: viteProcEntry.pid,
        command: 'vite ' + expandedArgs.join(' '),
        longRunning: true,
        attachedTty: false,
      });
    }

    // Banner — reports the resolved port and PID so the user can
    // verify the multi-target routing.
    ctx.stdout.write('\n\x1b[1;36m  Nimbus Vite Dev Server\x1b[0m\n\n');
    ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Preview:    \x1b[36m' + previewBasePath + '/\x1b[0m');
    if (resolvedPort !== vitePortDefault) {
      ctx.stdout.write('  \x1b[2m(also: ' + previewBasePath + '/?port=' + resolvedPort + ')\x1b[0m');
    }
    ctx.stdout.write('\n');
    ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Root:       ' + vfsRoot + '\n');
    ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Port:       ' + resolvedPort + ' \x1b[2m(pid=' + viteProcEntry.pid + ')\x1b[0m\n');
    ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Transforms: .ts .tsx .jsx (React JSX automatic)\n');
    if (viteConfig.alias) ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Aliases:    ' + Object.keys(viteConfig.alias).join(', ') + '\n');
    if (viteDefine) ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Define:     ' + Object.keys(viteDefine).join(', ') + '\n');
    const twCfg = [vfsRoot + '/tailwind.config.js', vfsRoot + '/tailwind.config.ts'].find(p => kernelFs.exists(p));
    if (twCfg) ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Tailwind:   edge-vendored Play CDN \x1b[2m(detected)\x1b[0m\n');
    ctx.stdout.write('\n  \x1b[2mRun \x1b[0mvite stop\x1b[2m, or \x1b[0mkill ' + viteProcEntry.pid + '\x1b[2m, to stop.\x1b[0m\n\n');
    return 0;
  };
}
