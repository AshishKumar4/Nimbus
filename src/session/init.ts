/**
 * session/init.ts — initSession boot + shell-command registrations.
 *
 * Why this is one big function and not a class:
 * initSession runs once per /ws upgrade and walks the session
 * through Phase R (rehydrate from SQL), Phase B (build kernel +
 * shell + register commands), Phase W (attach terminal), and
 * (cold-only) Phase O (MOTD + framework hint). The phases share
 * lots of locals (vfs, kernel, registry, shell) and ordering
 * matters strictly — there's no interesting reuse boundary that a
 * class decomposition would expose.
 *
 * The function is intentionally written so that a reader sees:
 *   1. setPhase('rehydrate') ...
 *   2. setPhase('build')    ... (~95% of the LOC)
 *   3. setPhase('online')   if (cold)
 *   4. self._b4Phase = 'hydrated'
 *
 * Extracted from src/nimbus-session.ts during the SESSION-REFACTOR
 * (audit/sections/SESSION-REFACTOR-PLAN.md §B.3.8 + S6) so the DO
 * class itself stays small. Imports `self: InitHost` (a narrow view
 * of SessionInternal + readonly ctx/env) which gives the compiler
 * enough type info without the surface area of the full DO class.
 *
 * Imports and class delegators on NimbusSession preserve back-compat:
 *   - acceptShellWebSocket → self.initSession(ws)  (S7 will extract).
 *   - The class still has `initSession(ws)` as a delegator method.
 */

import {
  Kernel, Shell, createDefaultRegistry, ProcessRegistry,
  MemoryPersistenceBackend, createCurlCommand, createNpmCommand,
  createNpxCommand, createTopCommand, createWatchCommand, createHelpCommand,
  rehydrateGlobalPackages,
} from '@lifo-sh/core';
import { SqliteVFSProvider } from '../vfs/sqlite-vfs.js';
import { WebSocketTerminal } from '../facets/ws-terminal.js';
import { EsbuildService } from '../runtime/esbuild-service.js';
import { runNodeScript } from '../runtime/node-runner.js';
import { runBunScript, BUN_VERSION } from '../runtime/bun-runner.js';
import { ViteDevServer } from '../facets/vite-dev-server.js';
import { CirrusReal, shouldUseRealVite } from '../facets/cirrus-real.js';
import {
  makeLongRunningPortStub,
  resolveLongRunningPort,
  expandArgvShellDefaults,
  pickDefaultPreviewPort,
} from '../runtime/long-running-handle.js';
import { acquireHeavyAlloc } from '../observability/heavy-alloc-coord.js';
import { NimbusWrangler } from '../wrangler/nimbus-wrangler.js';
import {
  filterWranglerFlags, detectBundlerBin, checkNodeModulesGuard,
  detectUnsupportedWranglerConfig, NIMBUS_UNSUPPORTED_BINS,
} from './helpers.js';
import { HeredocHandler } from '../shell/features.js';
import { registerUnixCommands } from '../shell/unix-commands.js';
import { registerGitCommands } from '../git/commands.js';
import { seedProject, hasSeededProject, SEED_PROJECT_DIR } from '../vfs/seed-project.js';
import { notifyTerminalEvent } from '../runtime/process-logs-api.js';
import { stripAnsi, type LogChunk } from '../runtime/process-logs.js';
import {
  NIMBUS_VERSION, DEFAULT_HOSTNAME, DEFAULT_MOUNT_POINTS, CF_COMPAT_DATE,
} from '../constants.js';
import { enc } from '../_shared/bytes.js';
import {
  ensureSessionStateSchema, loadShellState, persistShellState,
  stampHydratedAt, countSessionStateKeys,
  loadKernelMounts, persistKernelMounts,
  appendScrollback, loadScrollback,
  type ShellStateSnapshot,
} from './state-store.js';
import { recordRecoveryEvent } from '../observability/oom-discriminator.js';
import { setPhase } from './init-phases.js';
import type { SessionInternal } from './internal.js';

/**
 * `initSession` reads `this.ctx` and `this.env` extensively (~14 sites).
 * Both are `protected` on the parent `CloudflareDurableObject` class
 * (DEFECT-D1, see audit/sessions/session-refactor-build-progress.md).
 * The pragmatic shape for THIS module: extend SessionInternal with
 * `ctx`/`env` as `any` and have the class delegator cast `this as
 * unknown as InitHost`. Other sibling modules (-rpc, -ws, -hib,
 * -replica) DO take ctx as a separate explicit arg per D1 — initSession
 * can't because the body has too many call sites to thread through.
 */
type InitHost = SessionInternal & { readonly ctx: any; readonly env: any };


export function initSession(self: InitHost, ws: WebSocket): void {
    self.ensureSqliteFs();
    self.ensureFacetManager();
    self.seedFilesystem();

    // ── Phase R: rehydrate session state from DO SQLite [B'.1] ──────────
    //
    // Track B' invariant: every observable session field has a SQL-backed
    // source of truth. The fresh Shell/Kernel/Terminal we build below are
    // CACHES of those rows — initialised from the snapshot if a row
    // exists (silent re-init), defaults otherwise (true cold start).
    //
    // hasPersistedState is the cold-vs-rehydrate discriminator. The
    // `hydratedAt` field lets the /api/_diag/session debug endpoint
    // surface "this DO instance found a row at <ts>" for forensic
    // tooling.
    // [B'.4] Phase R — Rehydrate. Read persisted state values from DO
    // SQLite. Pure SQL reads; the actual application of these values
    // (Shell ctor params, mount list, scrollback bytes) happens in
    // later phases.
    setPhase(self, 'rehydrate', 'init-session');
    ensureSessionStateSchema(self.ctx);
    const persisted: ShellStateSnapshot = loadShellState(self.ctx);

    // [B'.4] Phase W (early-wire) — construct WebSocketTerminal with
    // the B'.3 scrollback tee. Marked as 'wire' here even though
    // 'build' hasn't run yet because the terminal is the WS-facing
    // facet and the scrollback replay below is wire-phase work.
    // Phase B will tag in once we start building the kernel.
    setPhase(self, 'wire', 'init-session');
    self.terminal = new WebSocketTerminal(ws, (frame: string) => {
      try { appendScrollback(self.ctx, frame, Date.now()); }
      catch (e: any) {
        try { console.warn('[B\'.3] appendScrollback failed:', e?.message || e); } catch {}
      }
    });

    // [B'.3] Replay persisted scrollback BEFORE the cold-start UI gate.
    // On rehydrate (hasPersistedState=true) we emit the prior
    // session's terminal contents as a single batched write — the
    // user reconnects to "where they left off" + a fresh prompt.
    // On cold start (no row) loadScrollback returns '' so this is a
    // no-op and the MOTD/Phase O block below runs normally.
    //
    // The replay itself goes through terminal.write → flush → tee,
    // so the replayed bytes also re-append to scrollback. That's the
    // correct semantics: a user who reconnects twice should see the
    // same scrollback both times. The cap eviction keeps total bytes
    // bounded.
    if (persisted.hasPersistedState) {
      try {
        const replay = loadScrollback(self.ctx);
        if (replay.length > 0) self.terminal.write(replay);
      } catch (e: any) {
        try { console.warn('[B\'.3] scrollback replay failed:', e?.message || e); } catch {}
      }
    }

    // [B'.4] Phase B — Build. Construct Kernel + Shell + registry +
    // install all commands. CPU-intensive phase. Spans from here
    // through ~line 1925 (just before Phase O).
    setPhase(self, 'build', 'init-session');

    // ── Boot kernel with in-memory VFS (mounts delegate to SqliteFS) ──
    self.kernel = new Kernel(new MemoryPersistenceBackend());
    self.kernel.initFilesystem();

    // ── Mount SqliteFSProvider at all top-level directories [B'.2] ──
    //
    // Mount list = DEFAULT_MOUNT_POINTS ∪ persisted-mounts. The
    // defaults are always present (they're platform invariants);
    // any extras a future custom-mount feature might add survive
    // reconnect via the nimbus_kernel_mounts table. The persist
    // step at the end writes the merged list back so the table
    // tracks the live mount tree.
    const persistedMounts = loadKernelMounts(self.ctx);
    const mountPoints = Array.from(new Set([
      ...DEFAULT_MOUNT_POINTS,
      ...persistedMounts,
    ]));
    for (const mp of mountPoints) {
      const provider = new SqliteVFSProvider(self.sqliteFs!, mp);
      self.kernel.vfs.mount('/' + mp, provider);
    }
    // Persist the mount-tree. Today this writes the same
    // DEFAULT_MOUNT_POINTS list every initSession (idempotent — the
    // table just keeps the same 7 rows). Future custom mounts will
    // flow through the same code path.
    try { persistKernelMounts(self.ctx, mountPoints); } catch { /* fail-soft */ }

    // ── Monkey-patch appendFile to go through mount provider ──
    const vfs = self.kernel.vfs;
    const originalAppendFile = vfs.appendFile.bind(vfs);
    vfs.appendFile = (path: string, content: string | Uint8Array) => {
      const prov = (vfs as any).getProvider?.(path);
      if (prov) {
        try {
          const existing = prov.provider.readFile(prov.subpath);
          const nc = typeof content === 'string' ? enc.encode(content) : content;
          const combined = new Uint8Array(existing.length + nc.length);
          combined.set(existing, 0);
          combined.set(nc, existing.length);
          prov.provider.writeFile(prov.subpath, combined);
        } catch {
          prov.provider.writeFile(prov.subpath, content);
        }
      } else {
        originalAppendFile(path, content);
      }
    };

    // ── Create command registry ──
    const registry = createDefaultRegistry();
    const kernel = self.kernel;
    const sqliteFs = self.sqliteFs!;
    const facetMgr = self.facetManager!;
    // W8: hand the registry to the cp broker so child_process.spawn from
    // a parent facet can resolve and dispatch commands the same way the
    // shell does. Done AFTER all registrations are complete (below).
    self._setCpRegistry(registry);

    // ── Unix commands (30+ real implementations) ──
    registerUnixCommands(registry, sqliteFs);

    // ── Git integration (isomorphic-git) ──
    // ctx + env are passed for clone/fetch/pull which run in a facet to avoid
    // exhausting the supervisor DO's CPU budget on large repos.
    registerGitCommands(registry, sqliteFs, self.ctx, self.env);

    // ── node command: facet-based execution ─────────────────────────────
    // Parses args, reads script from VFS, delegates to FacetManager.
    // The facet creates a dynamic worker where new Function() is allowed
    // during module startup.
    registry.register('node', async (ctx: any) => {
      const args: string[] = ctx.args || [];

      // Primitive #1 (primitives-extension wave): the version/help/eval
      // checks below USED to scan the entire args array, which broke
      // bin invocations like `node /path/to/tsc --version` — the user's
      // `--version` arg was misinterpreted as a node flag and Node's
      // version was printed instead of running the script.
      //
      // Real Node only treats leading args as node flags (until the
      // first non-flag token, which is the script path). We compute
      // a `nodeFlagSpan` index and only scan within it.
      let nodeFlagSpan = 0;
      while (nodeFlagSpan < args.length && args[nodeFlagSpan].startsWith('-')) {
        nodeFlagSpan++;
        // -e / --eval consumes one value; advance past it so the next
        // iteration sees the post-value position.
        const prev = args[nodeFlagSpan - 1];
        if ((prev === '-e' || prev === '--eval') && nodeFlagSpan < args.length) {
          nodeFlagSpan++;
        }
      }
      const flagSlice = args.slice(0, nodeFlagSpan);

      // node -v / --version
      if (flagSlice.includes('-v') || flagSlice.includes('--version')) {
        ctx.stdout.write('v20.0.0\n');
        return 0;
      }

      // node --help
      if (flagSlice.includes('--help') || flagSlice.includes('-h')) {
        ctx.stdout.write('Usage: node [options] [script.js] [arguments]\n');
        ctx.stdout.write('       node -e "code"\n\n');
        ctx.stdout.write('Options:\n');
        ctx.stdout.write('  -e, --eval <code>   Evaluate code\n');
        ctx.stdout.write('  -v, --version       Print version\n');
        ctx.stdout.write('  -h, --help          Print help\n');
        ctx.stdout.write('\nExecution via DO Facets (isolated V8 isolate)\n');
        return 0;
      }

      // node -e "code" / --eval "code"
      const evalIdx = flagSlice.indexOf('-e') !== -1 ? flagSlice.indexOf('-e') : flagSlice.indexOf('--eval');
      if (evalIdx !== -1) {
        const code = args[evalIdx + 1];
        if (!code) {
          ctx.stderr.write('node: -e requires an argument\n');
          return 1;
        }
        // arch-gaps gap #2: dispatch via runNodeScript so long-running
        // -e snippets (rare but possible — e.g. `node -e
        // 'http.createServer(…).listen(3000)'`) fork to a long-lived
        // Worker Loader instead of blocking the supervisor's
        // facet.run() RPC.
        const result = await runNodeScript(facetMgr, code, {
          argv: args.slice(evalIdx + 2),
          env: ctx.env,
          cwd: ctx.cwd,
          filename: '<eval>',
          dirname: ctx.cwd,
          command: 'node -e ...',
        });
        if (result.stdout) ctx.stdout.write(result.stdout);
        if (result.stderr) ctx.stderr.write(result.stderr);
        return result.exitCode;
      }

      // node [flags] script.js [args...]
      // Skip leading flag args (--watch / --inspect / --inspect-brk +
      // their values where applicable). The flags are passed through
      // to runFresh via opts.argv so isLongRunningInvocation routes
      // correctly.
      let scriptIdx = 0;
      while (scriptIdx < args.length && args[scriptIdx].startsWith('-')) {
        const flag = args[scriptIdx];
        scriptIdx++;
        // Flags that take a value: --inspect=host:port and --inspect host:port.
        // We assume = form for value-bearing flags so we don't accidentally
        // consume the script path as a flag value.
        // Bare --watch / --inspect / --inspect-brk consume zero values.
        if (flag === '--inspect-port') scriptIdx++; // safety for variants
      }
      const scriptPath = args[scriptIdx];
      if (!scriptPath) {
        ctx.stderr.write('node: REPL not supported. Use node -e "code" or node script.js\n');
        return 1;
      }

      // Resolve the script path relative to cwd
      let resolvedPath = scriptPath;
      if (!scriptPath.startsWith('/')) {
        const cwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');
        resolvedPath = cwd + '/' + scriptPath;
      } else {
        resolvedPath = scriptPath.replace(/^\/+/, '');
      }

      // Handle `node .` — read package.json main field
      if (scriptPath === '.' || scriptPath === './') {
        const cwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');
        const pkgPath = cwd + '/package.json';
        try {
          const pkg = JSON.parse(sqliteFs.readFileString(pkgPath));
          const main = pkg.main || 'index.js';
          resolvedPath = cwd + '/' + main;
        } catch {
          resolvedPath = cwd + '/index.js';
        }
      }

      // Try extensions: .js, .ts, .tsx, .mjs, .jsx
      if (!sqliteFs.exists(resolvedPath)) {
        const exts = ['.js', '.ts', '.tsx', '.mjs', '.jsx', '/index.js', '/index.ts'];
        for (const ext of exts) {
          if (sqliteFs.exists(resolvedPath + ext)) { resolvedPath += ext; break; }
        }
      }

      // Read the script
      let code: string;
      try {
        code = sqliteFs.readFileString(resolvedPath);
      } catch (e: any) {
        ctx.stderr.write(`node: cannot find module '${scriptPath}'\n`);
        return 1;
      }

      // Primitive #1 (primitives-extension wave): shebang stripping.
      // Real Node strips `#!...\n` from the first line before parsing.
      // Nimbus's node-runner used to feed the raw bytes to V8, which
      // threw "Invalid or unexpected token" on every bin shim with a
      // shebang. Affects /node_modules/.bin/* + every executable .js
      // installed via npx. Single-pass replace; idempotent on
      // already-stripped files.
      if (code.startsWith('#!')) {
        const nl = code.indexOf('\n');
        code = nl >= 0 ? code.substring(nl + 1) : '';
      }

      // Auto-transform TypeScript/TSX/JSX via esbuild before execution
      if (resolvedPath.endsWith('.ts') || resolvedPath.endsWith('.tsx') || resolvedPath.endsWith('.jsx')) {
        try {
          if (!self.esbuildService) {
            self.ensureSqliteFs();
            self.esbuildService = new EsbuildService(self.sqliteFs!);
          }
          const ext = resolvedPath.split('.').pop()!;
          const loader = ext === 'tsx' ? 'tsx' : ext === 'jsx' ? 'jsx' : 'ts';
          const transformed = await self.esbuildService.transform(code, { loader, format: 'cjs' });
          code = transformed.code;
        } catch (e: any) {
          ctx.stderr.write(`node: transform error for ${scriptPath}: ${e?.message}\n`);
          return 1;
        }
      }

      const filename = '/' + resolvedPath;
      const dirname = filename.includes('/') ? filename.substring(0, filename.lastIndexOf('/')) : '/';

      // fresh-isolate-bun-behavioral wave: dispatch via runFresh. The
      // argv-only routing (--watch / --inspect / --inspect-brk) routes
      // to the long-running fork (facetMgr.spawn). Short scripts
      // continue through the fresh-isolate facetMgr.exec path. NO
      // content-sniffing heuristic.
      // opts.argv MUST contain the runtime flags so
      // isLongRunningInvocation can see them; we put leading flags
      // before [filename, ...scriptArgs].
      const leadingFlags = args.slice(0, scriptIdx);
      const result = await runNodeScript(facetMgr, code, {
        argv: [...leadingFlags, filename, ...args.slice(scriptIdx + 1)],
        env: ctx.env,
        cwd: ctx.cwd,
        filename,
        dirname,
        command: `node ${args.slice(0, scriptIdx + 1).join(' ')}`,
      });
      if (result.stdout) ctx.stdout.write(result.stdout);
      if (result.stderr) ctx.stderr.write(result.stderr);
      return result.exitCode;
    });

    // ── bun command: parallel runtime, same fresh-isolate semantics ──
    // Mirrors the `node` handler shape (parse args, read file, esbuild
    // transform for ts/tsx/jsx, dispatch via runBunScript). The bun-
    // specific surface is the BUN_SHIM_PREAMBLE prepended by
    // runBunScript, which installs a `Bun` global with serve/file/
    // write/spawn/password/gunzip/sql/S3 backed by Workers-native
    // primitives.
    //
    // `bun install` and `bun run <script>` are routed through the
    // existing npm pipeline (delegate to the npm/npm-fast handlers)
    // so we get the F-2 fanout, R2 caches, and W7 streaming for free.
    registry.register('bun', async (ctx: any) => {
      const args: string[] = ctx.args || [];

      // bun --version / -v
      if (args.includes('-v') || args.includes('--version')) {
        ctx.stdout.write(BUN_VERSION + '\n');
        return 0;
      }

      // bun --help / -h
      if (args.includes('--help') || args.includes('-h')) {
        ctx.stdout.write('Usage: bun [options] [script.[js|ts|tsx]] [args...]\n');
        ctx.stdout.write('       bun -e "code"\n');
        ctx.stdout.write('       bun install [pkg ...]\n');
        ctx.stdout.write('       bun run <script>\n\n');
        ctx.stdout.write('Bun-runtime shim provides Bun.serve/Bun.file/Bun.write/\n');
        ctx.stdout.write('Bun.spawn/Bun.password/Bun.gunzip backed by Workers-native\n');
        ctx.stdout.write('primitives. Bun.sql / Bun.S3 throw (use D1/Hyperdrive/R2).\n');
        ctx.stdout.write('Execution via DO Facets (isolated V8 isolate per call).\n');
        return 0;
      }

      // bun install [pkg…] — delegate to npm install (same VFS, same
      // R2 caches, same fanout pipeline).
      if (args[0] === 'install' || args[0] === 'i' || args[0] === 'add') {
        const npmCmd = await registry.resolve('npm');
        if (npmCmd) {
          return await npmCmd({ ...ctx, args: ['install', ...args.slice(1)] });
        }
        ctx.stderr.write('bun install: npm handler unavailable\n');
        return 1;
      }

      // bun run <script> — read package.json scripts.<name>, execute it.
      if (args[0] === 'run') {
        const scriptName = args[1];
        if (!scriptName) {
          ctx.stderr.write('bun run: missing script name\n');
          return 1;
        }
        const pkgPath = (ctx.cwd || '/home/user').replace(/^\/+/, '') + '/package.json';
        let pkgScript: string | undefined;
        try {
          const pkg = JSON.parse(sqliteFs.readFileString(pkgPath));
          pkgScript = pkg.scripts?.[scriptName];
        } catch {
          ctx.stderr.write(`bun run: cannot read package.json at ${pkgPath}\n`);
          return 1;
        }
        if (!pkgScript) {
          ctx.stderr.write(`bun run: script "${scriptName}" not found in package.json\n`);
          return 1;
        }
        // Forward to the live shell registry so commands like `vite` or
        // `node …` resolve the same way `npm run` would.
        try {
          const shellResult = await shell.execute(pkgScript, {
            cwd: ctx.cwd,
            env: ctx.env,
            onStdout: (d: string) => ctx.stdout.write(d),
            onStderr: (d: string) => ctx.stderr.write(d),
          });
          return shellResult.exitCode;
        } catch (e: any) {
          ctx.stderr.write(`bun run: ${e?.message ?? String(e)}\n`);
          return 1;
        }
      }

      // bun -e "code" / --eval "code"
      const evalIdx = args.indexOf('-e') !== -1 ? args.indexOf('-e') : args.indexOf('--eval');
      if (evalIdx !== -1) {
        const code = args[evalIdx + 1];
        if (!code) {
          ctx.stderr.write('bun: -e requires an argument\n');
          return 1;
        }
        const result = await runBunScript(facetMgr, code, {
          argv: args.slice(evalIdx + 2),
          env: ctx.env,
          cwd: ctx.cwd,
          filename: '<eval>',
          dirname: ctx.cwd,
          command: 'bun -e ...',
        });
        if (result.stdout) ctx.stdout.write(result.stdout);
        if (result.stderr) ctx.stderr.write(result.stderr);
        return result.exitCode;
      }

      // bun [flags] script.[js|ts|tsx|jsx|mjs] [args...]
      // Skip leading flag args (--watch / --inspect / --hot etc.) so
      // they don't get treated as the script path.
      let bunScriptIdx = 0;
      while (bunScriptIdx < args.length && args[bunScriptIdx].startsWith('-')) {
        bunScriptIdx++;
      }
      const scriptPath = args[bunScriptIdx];
      if (!scriptPath) {
        ctx.stderr.write('bun: REPL not supported. Use bun -e "code" or bun script.js\n');
        return 1;
      }
      const bunLeadingFlags = args.slice(0, bunScriptIdx);

      let resolvedPath = scriptPath;
      if (!scriptPath.startsWith('/')) {
        const cwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');
        resolvedPath = cwd + '/' + scriptPath;
      } else {
        resolvedPath = scriptPath.replace(/^\/+/, '');
      }
      if (scriptPath === '.' || scriptPath === './') {
        const cwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');
        const pkgPath = cwd + '/package.json';
        try {
          const pkg = JSON.parse(sqliteFs.readFileString(pkgPath));
          const main = pkg.main || pkg.module || 'index.js';
          resolvedPath = cwd + '/' + main;
        } catch {
          resolvedPath = cwd + '/index.js';
        }
      }
      if (!sqliteFs.exists(resolvedPath)) {
        const exts = ['.js', '.ts', '.tsx', '.mjs', '.jsx', '/index.js', '/index.ts'];
        for (const ext of exts) {
          if (sqliteFs.exists(resolvedPath + ext)) { resolvedPath += ext; break; }
        }
      }
      let code: string;
      try {
        code = sqliteFs.readFileString(resolvedPath);
      } catch {
        ctx.stderr.write(`bun: cannot find module '${scriptPath}'\n`);
        return 1;
      }
      // bun supports TS/TSX natively; we transform via esbuild here so
      // the loader isolate executes plain JS.
      if (resolvedPath.endsWith('.ts') || resolvedPath.endsWith('.tsx') || resolvedPath.endsWith('.jsx')) {
        try {
          if (!self.esbuildService) {
            self.ensureSqliteFs();
            self.esbuildService = new EsbuildService(self.sqliteFs!);
          }
          const ext = resolvedPath.split('.').pop()!;
          const loader = ext === 'tsx' ? 'tsx' : ext === 'jsx' ? 'jsx' : 'ts';
          const transformed = await self.esbuildService.transform(code, { loader, format: 'cjs' });
          code = transformed.code;
        } catch (e: any) {
          ctx.stderr.write(`bun: transform error for ${scriptPath}: ${e?.message}\n`);
          return 1;
        }
      }
      const filename = '/' + resolvedPath;
      const dirname = filename.includes('/') ? filename.substring(0, filename.lastIndexOf('/')) : '/';
      const result = await runBunScript(facetMgr, code, {
        argv: [...bunLeadingFlags, filename, ...args.slice(bunScriptIdx + 1)],
        env: ctx.env,
        cwd: ctx.cwd,
        filename,
        dirname,
        command: `bun ${args.slice(0, bunScriptIdx + 1).join(' ')}`,
      });
      if (result.stdout) ctx.stdout.write(result.stdout);
      if (result.stderr) ctx.stderr.write(result.stderr);
      return result.exitCode;
    });

    try {
      registry.register('curl', createCurlCommand(kernel));
    } catch {}

    // ── df with SQLite stats + cache + process metrics ──────────────────
    registry.register('df', async (ctx: any) => {
      const stats = sqliteFs.getStats();
      const pstats = facetMgr.stats;
      const used = stats.usedBytes;
      const cap = stats.capacityBytes;
      const avail = cap - used;
      const pct = ((used / cap) * 100).toFixed(0);
      const fmt = (b: number) => {
        if (b >= 1e9) return (b / 1e9).toFixed(1) + 'G';
        if (b >= 1e6) return (b / 1e6).toFixed(1) + 'M';
        if (b >= 1e3) return (b / 1e3).toFixed(1) + 'K';
        return b + 'B';
      };
      ctx.stdout.write('Filesystem      Size  Used Avail Use% Mounted on\n');
      ctx.stdout.write(
        'sqlite         ' + fmt(cap).padStart(5) + ' ' + fmt(used).padStart(5) +
        ' ' + fmt(avail).padStart(5) + ' ' + pct.padStart(3) + '% /\n'
      );
      ctx.stdout.write(
        '\nCache: ' + stats.cache.entries + '/' + stats.cache.maxEntries +
        ' slots | hit rate: ' + stats.cache.hitRate +
        '% | evictions: ' + stats.cache.evictions + '\n'
      );
      ctx.stdout.write(
        'Procs: ' + pstats.running + ' running, ' +
        pstats.exited + ' exited, ' +
        pstats.total + ' total (next PID: ' + pstats.nextPid + ')\n'
      );
      return 0;
    });

    // ── esbuild command: transform/bundle via esbuild facet ───────────────
    // Lazy-creates the EsbuildService on first use (esbuild-wasm is ~10MB).
    registry.register('esbuild', async (ctx: any) => {
      const args: string[] = ctx.args || [];

      if (args.includes('--version')) {
        ctx.stdout.write('0.24.2 (esbuild-wasm, bundled)\n');
        return 0;
      }

      if (args.includes('--help') || args.length === 0) {
        ctx.stdout.write('Usage: esbuild [options] [entry points]\n\n');
        ctx.stdout.write('Options:\n');
        ctx.stdout.write('  --bundle           Bundle all dependencies into output\n');
        ctx.stdout.write('  --outfile=<path>   Write output to a file\n');
        ctx.stdout.write('  --outdir=<path>    Write output to a directory\n');
        ctx.stdout.write('  --format=esm|cjs   Output format (default: esm)\n');
        ctx.stdout.write('  --platform=browser|node  Target platform\n');
        ctx.stdout.write('  --minify           Minify output\n');
        ctx.stdout.write('  --sourcemap        Generate source maps\n');
        ctx.stdout.write('  --target=<target>  JS target (default: esnext)\n');
        ctx.stdout.write('  --loader=<loader>  Force file loader (ts, tsx, jsx, css)\n');
        ctx.stdout.write('  --version          Show version\n');
        ctx.stdout.write('\nPowered by esbuild-wasm (bundled in supervisor).\n');
        return 0;
      }

      // Lazy-init esbuild service
      if (!self.esbuildService) {
        self.ensureSqliteFs();
        self.esbuildService = new EsbuildService(self.sqliteFs!);
      }

      // Parse flags
      const flags: Record<string, string> = {};
      const entryPoints: string[] = [];
      for (const arg of args) {
        if (arg.startsWith('--')) {
          const eqIdx = arg.indexOf('=');
          if (eqIdx > 0) {
            flags[arg.substring(2, eqIdx)] = arg.substring(eqIdx + 1);
          } else {
            flags[arg.substring(2)] = 'true';
          }
        } else {
          entryPoints.push(arg);
        }
      }

      // Transform-only mode (single file, no --bundle)
      if (entryPoints.length === 1 && !flags['bundle']) {
        // Read the file and transform it
        let filePath = entryPoints[0];
        if (!filePath.startsWith('/')) {
          filePath = (ctx.cwd || '/home/user').replace(/^\/+/, '') + '/' + filePath;
        } else {
          filePath = filePath.replace(/^\/+/, '');
        }

        let code: string;
        try {
          code = sqliteFs.readFileString(filePath);
        } catch {
          ctx.stderr.write(`esbuild: could not read file: ${entryPoints[0]}\n`);
          return 1;
        }

        try {
          ctx.stderr.write('Transforming...\n');
          const result = await self.esbuildService!.transform(code, {
            loader: (flags['loader'] as any) || (() => {
              const ext = filePath.split('.').pop()?.toLowerCase();
              return ({ ts: 'ts', tsx: 'tsx', jsx: 'jsx', js: 'js', mts: 'ts', mjs: 'js', css: 'css', json: 'json' } as any)[ext || ''];
            })(),
            format: (flags['format'] as any) || 'esm',
            target: flags['target'] || 'esnext',
            sourcemap: flags['sourcemap'] === 'true',
            minify: flags['minify'] === 'true',
          });

          if (flags['outfile']) {
            const outPath = flags['outfile'].replace(/^\/+/, '');
            // Ensure parent dirs exist
            const parts = outPath.split('/');
            for (let i = 1; i < parts.length; i++) {
              const dir = parts.slice(0, i).join('/');
              if (dir && !sqliteFs.exists(dir)) sqliteFs.mkdir(dir, { recursive: true });
            }
            sqliteFs.writeFile(outPath, result.code);
            ctx.stdout.write(`  ${outPath}  ${result.code.length} bytes\n`);
          } else {
            ctx.stdout.write(result.code);
          }
          for (const w of result.warnings || []) {
            ctx.stderr.write(`warning: ${w.text}\n`);
          }
          return 0;
        } catch (e: any) {
          ctx.stderr.write(`esbuild error: ${e?.message || e}\n`);
          return 1;
        }
      }

      // Bundle mode
      if (entryPoints.length === 0) {
        ctx.stderr.write('esbuild: no entry points specified\n');
        return 1;
      }

      // Resolve entry points relative to cwd
      const resolvedEntryPoints = entryPoints.map(ep => {
        if (ep.startsWith('/')) return ep.replace(/^\/+/, '');
        return (ctx.cwd || '/home/user').replace(/^\/+/, '') + '/' + ep;
      });

      try {
        ctx.stderr.write('Bundling...\n');
        const result = await self.esbuildService!.build(resolvedEntryPoints, {
          bundle: flags['bundle'] === 'true',
          format: (flags['format'] as any) || 'esm',
          target: flags['target'] || 'esnext',
          platform: (flags['platform'] as any) || 'browser',
          outdir: flags['outfile'] ? undefined : (flags['outdir'] || '/dist'),
          outfile: flags['outfile'],
          sourcemap: flags['sourcemap'] === 'true',
          minify: flags['minify'] === 'true',
          external: flags['external']?.split(','),
        });

        for (const e of result.errors || []) {
          ctx.stderr.write(`error: ${e.text}\n`);
        }
        for (const w of result.warnings || []) {
          ctx.stderr.write(`warning: ${w.text}\n`);
        }

        if (result.errors?.length) return 1;

        // Write output files to VFS
        for (const f of result.outputFiles || []) {
          const outPath = f.path.replace(/^\/+/, '');
          const parts = outPath.split('/');
          for (let i = 1; i < parts.length; i++) {
            const dir = parts.slice(0, i).join('/');
            if (dir && !sqliteFs.exists(dir)) sqliteFs.mkdir(dir, { recursive: true });
          }
          sqliteFs.writeFile(outPath, f.contents);
          ctx.stdout.write(`  ${outPath}  ${f.contents.length} bytes\n`);
        }

        ctx.stderr.write(`Done (${result.outputFiles?.length || 0} output files)\n`);
        return 0;
      } catch (e: any) {
        ctx.stderr.write(`esbuild error: ${e?.message || e}\n`);
        return 1;
      }
    });

    // ── vite command: start/stop the dev server ──────────────────────────
    registry.register('vite', async (ctx: any) => {
      const args: string[] = ctx.args || [];
      const cwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');

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

      // ── Parse vite.config.ts if it exists ──
      const viteConfig: any = {};
      for (const cfgName of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
        const cfgPath = cwd + '/' + cfgName;
        if (self.sqliteFs!.exists(cfgPath)) {
          try {
            let cfgCode = self.sqliteFs!.readFileString(cfgPath);
            // Transform TS to JS
            if (cfgName.endsWith('.ts')) {
              if (!self.esbuildService) self.esbuildService = new EsbuildService(self.sqliteFs!);
              const t = await self.esbuildService.transform(cfgCode, { loader: 'ts', format: 'esm' });
              cfgCode = t.code;
            }
            // Extract config values via regex (safer than eval in Workers)
            const rootMatch = cfgCode.match(/root\s*:\s*['"]([^'"]+)['"]/);
            if (rootMatch) viteConfig.root = rootMatch[1];
            const portMatch = cfgCode.match(/port\s*:\s*(\d+)/);
            if (portMatch) viteConfig.port = parseInt(portMatch[1]);
            const outDirMatch = cfgCode.match(/outDir\s*:\s*['"]([^'"]+)['"]/);
            if (outDirMatch) viteConfig.outDir = outDirMatch[1];
            const baseMatch = cfgCode.match(/base\s*:\s*['"]([^'"]+)['"]/);
            if (baseMatch) viteConfig.base = baseMatch[1];
            // Nimbus-specific: opt out of the React Router basename injection.
            // Users who want to handle /preview/ routing themselves can set
            // `nimbusInjectBasename: false` in vite.config.ts.
            const injectMatch = cfgCode.match(/nimbusInjectBasename\s*:\s*(true|false)/);
            if (injectMatch) viteConfig.injectBasename = injectMatch[1] === 'true';
            // resolve.alias: "@": path.resolve(__dirname, "./src") or "@": "./src"
            // After esbuild transform, values can be string literals OR path.resolve() calls.
            // Supports any alias key (not just @-prefixed): "@", "~", "#", "components", etc.
            if (!viteConfig.alias) viteConfig.alias = {};
            // Match string literal values: "key": "./path"
            const aliasLiterals = cfgCode.matchAll(/["']([^"']+)["']\s*:\s*["'](\.[^"']+)["']/g);
            for (const am of aliasLiterals) {
              viteConfig.alias[am[1]] = am[2];
            }
            // Match path.resolve() values: "key": path.resolve(__dirname, "./path")
            const aliasResolves = cfgCode.matchAll(/["']([^"']+)["']\s*:\s*(?:path\.resolve|resolve)\s*\([^,]*,\s*["']([^"']+)["']\s*\)/g);
            for (const am of aliasResolves) {
              viteConfig.alias[am[1]] = am[2];
            }
          } catch (e: any) {
            ctx.stderr.write(`Warning: could not parse ${cfgName}: ${e?.message}\n`);
          }
          break;
        }
      }

      // ── vite build ──
      if (args[0] === 'build') {
        if (!self.esbuildService) self.esbuildService = new EsbuildService(self.sqliteFs!);
        const htmlPath = cwd + '/index.html';
        let entryPoint = cwd + '/src/main.tsx';
        let origHtml = '';
        try {
          origHtml = self.sqliteFs!.readFileString(htmlPath);
          const m = origHtml.match(/src=["']([^"']+\.(?:tsx?|jsx?|mjs))["']/);
          if (m) entryPoint = cwd + '/' + m[1].replace(/^\//, '');
        } catch { ctx.stderr.write('Warning: no index.html\n'); }
        if (!self.sqliteFs!.exists(entryPoint)) {
          const alts = [cwd+'/src/main.tsx', cwd+'/src/main.ts', cwd+'/src/index.tsx', cwd+'/src/index.ts'];
          entryPoint = alts.find(p => self.sqliteFs!.exists(p)) || entryPoint;
        }

        ctx.stdout.write('Building for production...\n');
        ctx.stdout.write('  Entry: ' + entryPoint + '\n');
        const t0 = Date.now();

        try {
          const outDir = viteConfig.outDir || 'dist';
          const distDir = cwd + '/' + outDir;

          // Detect which packages are installed vs need CDN
          const nmDir = cwd + '/node_modules';
          const externals: string[] = [];
          const cdnPackages: string[] = [];
          for (const pkg of ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client']) {
            const pkgBase = pkg.split('/')[0];
            if (!self.sqliteFs!.exists(nmDir + '/' + pkgBase)) {
              externals.push(pkg);
              if (!cdnPackages.includes(pkgBase)) cdnPackages.push(pkgBase);
            }
          }
          if (viteConfig.alias) externals.push(...Object.keys(viteConfig.alias));

          // Bundle JS
          const result = await self.esbuildService.build([entryPoint], {
            bundle: true, format: 'esm', target: 'es2020', platform: 'browser',
            minify: true, outdir: '/' + distDir + '/assets',
            external: externals.length > 0 ? externals : undefined,
          });
          if (result.errors?.length) {
            for (const e of result.errors) ctx.stderr.write('  error: ' + e.text + '\n');
            return 1;
          }

          // Generate content hash for filenames
          let jsContent = '';
          for (const f of result.outputFiles || []) {
            jsContent = f.contents;
          }
          const hashNum = jsContent.split('').reduce((h: number, c: string) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
          const hash = (hashNum >>> 0).toString(36).padStart(6, '0');

          // Write JS with hashed filename
          const jsFilename = 'index-' + hash + '.js';
          const jsPath = distDir + '/assets/' + jsFilename;
          self.sqliteFs!.mkdir(distDir + '/assets', { recursive: true });
          self.sqliteFs!.writeFile(jsPath, jsContent);
          ctx.stdout.write('  \x1b[2m' + outDir + '/assets/' + jsFilename + '\x1b[0m  ' + (jsContent.length / 1024).toFixed(2) + ' kB\n');

          // Collect all CSS files from src/
          let allCss = '';
          const collectCss = (dir: string) => {
            try {
              for (const e of self.sqliteFs!.readdir(dir)) {
                const fp = dir + '/' + e.name;
                if (e.type === 'directory') collectCss(fp);
                else if (e.name.endsWith('.css')) {
                  try { allCss += self.sqliteFs!.readFileString(fp) + '\n'; } catch {}
                }
              }
            } catch {}
          };
          collectCss(cwd + '/src');
          const cssFilename = 'index-' + hash + '.css';
          if (allCss.trim()) {
            self.sqliteFs!.writeFile(distDir + '/assets/' + cssFilename, allCss);
            ctx.stdout.write('  \x1b[2m' + outDir + '/assets/' + cssFilename + '\x1b[0m  ' + (allCss.length / 1024).toFixed(2) + ' kB\n');
          }

          // Generate dist/index.html
          if (origHtml) {
            let distHtml = origHtml;
            // Only remove importmap if ALL packages are bundled (no CDN needed)
            if (cdnPackages.length === 0) {
              distHtml = distHtml.replace(/<script\s+type=["']importmap["']>[\s\S]*?<\/script>\s*/i, '');
            }
            distHtml = distHtml
              .replace(/(<script[^>]*)\ssrc=["'][^"']+\.(?:tsx?|jsx?|mjs)["']/, '$1 src="/assets/' + jsFilename + '"')
              .replace(/<link[^>]*href=["'][^"']*\.css["'][^>]*\/?>/, '<link rel="stylesheet" crossorigin href="/assets/' + cssFilename + '">');
            self.sqliteFs!.writeFile(distDir + '/index.html', distHtml);
            ctx.stdout.write('  \x1b[2m' + outDir + '/index.html\x1b[0m  ' + (distHtml.length / 1024).toFixed(2) + ' kB\n');
            if (cdnPackages.length > 0) {
              ctx.stdout.write('  \x1b[33mNote: ' + cdnPackages.join(', ') + ' loaded from CDN (not bundled)\x1b[0m\n');
            }
          }

          ctx.stdout.write('\n\x1b[32m\u2713 built in ' + ((Date.now() - t0) / 1000).toFixed(2) + 's\x1b[0m\n');
          return 0;
        } catch (e: any) {
          ctx.stderr.write('Build error: ' + (e?.message || e) + '\n');
          return 1;
        }
      }

      // ── vite preview ──
      if (args[0] === 'preview') {
        ctx.stdout.write('Serving dist/ — open ' + self.viteBasePath + '/\n');
        const distRoot = cwd + '/' + (viteConfig.outDir || 'dist');
        if (!self.sqliteFs!.exists(distRoot)) {
          ctx.stderr.write('dist/ not found. Run vite build first.\n');
          return 1;
        }
        // Start vite on the dist directory
        if (!self.esbuildService) self.esbuildService = new EsbuildService(self.sqliteFs!);
        if (self.viteDevServer?.isRunning) self.viteDevServer.stop();
        const previewBasePath = self.viteBasePath;
        // Primitives wave (P5/P8): same long-running treatment as the
        // dev path, just on the dist/ directory.
        const previewPort = viteConfig.port || 4173; // vite preview default
        const previewProcEntry = self.processTable.spawn(
          'vite preview (' + distRoot + ')', [], distRoot,
        );
        self.processTable.setLongRunning(previewProcEntry.pid);
        self.viteDevServer = new ViteDevServer({
          vfs: self.sqliteFs!, esbuild: self.esbuildService!, root: distRoot,
          onHmrMessage: () => {},
          sql: self.ctx.storage.sql,
          basePath: previewBasePath,
          env: self.env,
          ctx: self.ctx,
          port: previewPort,
          pid: previewProcEntry.pid,
          processLogs: self.processLogs,
        });
        self.viteDevServer.start();
        try {
          const previewStub = makeLongRunningPortStub(self.viteDevServer);
          self.portRegistry.register(previewPort, previewProcEntry.pid, previewStub);
          self._viteShimPid = previewProcEntry.pid;
          self._viteShimPort = previewPort;
        } catch {}
        try { await self.ctx.storage.put('vite-config', { root: distRoot, basePath: previewBasePath, port: previewPort }); } catch {}
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
          try { await self.ctx.storage.delete('vite-config'); } catch {}
          stopped = true;
        }
        // Primitive #3 teardown — symmetric with the start path. Always
        // safe to call: unregisterByPid is idempotent, exit() guards
        // against re-marking already-terminal entries.
        if (self._viteShimPid != null) {
          try { self.portRegistry.unregisterByPid(self._viteShimPid); } catch {}
          try { self.processTable.exit(self._viteShimPid, 0); } catch {}
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
        if (args[i] === '--root' && args[i + 1]) vfsRoot = args[i + 1].replace(/^\/+/, '');
      }
      if (viteConfig.root && viteConfig.root !== '.') {
        // Resolve relative root against cwd
        const configRoot = viteConfig.root.replace(/^\.\//, '');
        vfsRoot = configRoot.startsWith('/') ? configRoot : cwd + '/' + configRoot;
      }
      // Normalize: remove /., //, leading/trailing slashes
      vfsRoot = vfsRoot
        .replace(/\/\.\//g, '/')     // /./ → /
        .replace(/\/\.$/,  '')       // trailing /.
        .replace(/\/+/g,   '/')      // collapse //
        .replace(/^\/+/,   '')       // leading /
        .replace(/\/+$/,   '');      // trailing /

      // ── Preflight: node_modules guard ────────────────────────────────────
      // Direct `vite` invocation requires installed deps. Bail loudly BEFORE
      // spawning a dev server that would just serve broken modules and
      // confuse the user. --force / --no-install-check bypasses the check.
      const bypassInstallCheck = args.includes('--force') || args.includes('--no-install-check');
      if (!bypassInstallCheck) {
        const guard = checkNodeModulesGuard(self.sqliteFs!, vfsRoot);
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
      let realViteCfgSource: string | undefined;
      try {
        const p = [cwd + '/vite.config.ts', cwd + '/vite.config.js', cwd + '/vite.config.mjs']
          .find(p => self.sqliteFs!.exists(p));
        if (p) realViteCfgSource = self.sqliteFs!.readFileString(p);
      } catch {}
      const sessionEnv = (ctx && ctx.env) || {};
      const useReal = shouldUseRealVite({ env: sessionEnv, viteConfigSource: realViteCfgSource });
      if (useReal) {
        if (self.cirrusReal?.isRunning) self.cirrusReal.stop(self.ctx);
        // 5173 is Vite's default; under workerd it's a routing key, not
        // a real socket, so we reuse the same number per session.
        const vitePort = viteConfig.port || 5173;
        const previewBasePath = self.viteBasePath;

        // Acquire the heavy-alloc gate so the fire-and-forget pre-bundle
        // phase (still in flight on a fresh `npm install && npm run dev`)
        // pauses new dispatches while we allocate the cirrus-real boot
        // payload (user-vite-config esbuild bundle ~few MiB, plugin-react
        // bundle, syntheticCode string with snapshotFiles inlined ~few
        // MiB, LOADER.load worker bundle). With concurrent allocations
        // and a shared isolate (Mini-PRD: DO shared isolate issues), peak
        // pressure is what kills us — not steady-state. Released right
        // after cirrusReal.start() in a finally so a throw in the boot
        // path doesn't permanently pin the gate.
        const heavyAllocRelease = acquireHeavyAlloc();
        // Safety net: release the gate after a generous ceiling even
        // if the release path is bypassed by an unexpected control
        // flow (defensive — boot always reaches start() in well-tested
        // code paths today). Without this, a future regression that
        // exits the cirrus-real boot block without hitting our finally
        // would leave pre-bundle blocked for 30 s on every later
        // dispatch attempt — annoying but not fatal (waitForLowAllocPressure
        // has its own 30 s ceiling).
        const heavyAllocCeiling = setTimeout(() => heavyAllocRelease(), 60_000);

        // Pre-bundle the user's vite.config.ts if present. Must handle
        // plugin imports — @vitejs/plugin-react, vite-plugin-svgr, etc.
        // — which live in the project's node_modules. esbuild resolves
        // those against the VFS via our existing EsbuildService, then
        // emits an ESM string the facet imports as user-vite-config.js.
        let userConfigBundle: string | null = null;
        // Extra synthetic files to seed into the facet's fs snapshot.
        // Populated below when pre-bundling plugin-react — it does
        // fs.readFileSync(_require.resolve('./refreshUtils.js')) at
        // transform time and expects to find that file on disk.
        const extraSyntheticFiles: Record<string, string> = {};
        const cfgPath = [cwd + '/vite.config.ts', cwd + '/vite.config.js', cwd + '/vite.config.mjs']
          .find(p => self.sqliteFs!.exists(p));
        if (cfgPath) {
          try {
            if (!self.esbuildService) self.esbuildService = new EsbuildService(self.sqliteFs!);
            const bundleResult = await self.esbuildService.build([cfgPath], {
              bundle: true,
              format: 'esm',
              target: 'es2022',
              platform: 'neutral',
              // Path C externals:
              //   - vite: the facet provides vite-config-helper.js
              //     re-exporting the prebundled vite.bundle.js.
              //   - @vitejs/plugin-react: the facet provides a
              //     prebundled cirrus-plugin-react.js (built by
              //     scripts/bundle-plugin-react.mjs at build time;
              //     includes babel, react-refresh, inlined assets).
              //   - @vitejs/plugin-react/jsx-runtime: same bundle.
              // Any OTHER plugin the user imports (plugin-vue,
              // plugin-svgr, etc.) falls through to esbuild bundling,
              // which may or may not work depending on whether its
              // assets can be fully inlined.
              external: [
                'node:*', 'fs', 'path', 'url', 'util', 'os', 'crypto',
                'events', 'stream', 'buffer', 'module', 'perf_hooks',
                'esbuild', 'esbuild-wasm',
                'vite', 'vite/*',
                '@vitejs/plugin-react', '@vitejs/plugin-react/*',
              ],
              // Same synthetic import.meta.url hack as vite.bundle.js so
              // plugins that use `fileURLToPath(import.meta.url)` to find
              // their own install dir don't crash.
              define: {
                'import.meta.url': JSON.stringify('file:///user-vite-config.js'),
              },
              keepNames: true,
            });
            const out = bundleResult.outputFiles?.[0];
            if (out) {
              userConfigBundle = String(out.contents);
              // LOADER.load requires .js-suffixed specifiers. Externals
              // survive bundling as bare specifiers in the output; we
              // rewrite them to .js-suffixed paths pointing at the
              // facets helper modules.
              userConfigBundle = userConfigBundle.replace(
                /from\s*["']vite["']/g,
                'from "./vite-config-helper.js"',
              );
              userConfigBundle = userConfigBundle.replace(
                /from\s*["']vite\/(.+?)["']/g,
                'from "./vite-config-helper.js"',
              );
              userConfigBundle = userConfigBundle.replace(
                /from\s*["']@vitejs\/plugin-react["']/g,
                'from "./cirrus-plugin-react.js"',
              );
              userConfigBundle = userConfigBundle.replace(
                /from\s*["']@vitejs\/plugin-react\/(.+?)["']/g,
                'from "./cirrus-plugin-react.js"',
              );
              // Path C eliminates the need for userspaceRequire /
              // createRequire / node:fs rewrites in the user-config
              // bundle — the heavy lifting moved into the
              // prebundled @vitejs/plugin-react. Left as-is in case
              // other plugins the user adds still need them.
              userConfigBundle = userConfigBundle.replace(
                /\bimport\(\s*(["'][^"']+["'])\s*\)/g,
                (_, spec) =>
                  `Promise.resolve().then(() => {` +
                  ` const m = globalThis.__cirrusRealUserspaceRequire?.(${spec});` +
                  ` if (!m) throw new Error('[cirrus-real] dynamic import failed for ' + ${spec});` +
                  ` return { default: m.default ?? m, ...(typeof m === 'object' ? m : {}) };` +
                  ` })`,
              );
              userConfigBundle = userConfigBundle.replace(
                /\bcreateRequire\(/g,
                '(globalThis.__cirrusNodeCreateRequire || createRequire)(',
              );
              userConfigBundle = userConfigBundle.replace(
                /from\s*["']node:fs["']/g,
                'from "./cirrus-fs.js"',
              );
              userConfigBundle = userConfigBundle.replace(
                /from\s*["']node:fs\/promises["']/g,
                'from "./cirrus-fs-promises.js"',
              );
              if (bundleResult.errors?.length) {
                console.warn('[vite-cmd] esbuild bundle errors:', bundleResult.errors);
              }
            } else {
              console.warn('[vite-cmd] esbuild.build produced no output');
            }
          } catch (e: any) {
            ctx.stderr.write('\x1b[33m!\x1b[0m vite.config bundling failed: ' + (e?.message || e) + '\n');
            ctx.stderr.write('  Real-vite will run with default config.\n');
          }
        }

        self.cirrusReal = new CirrusReal({
          env: self.env,
          port: vitePort,
          root: vfsRoot,
          basePath: previewBasePath,
          vfs: self.sqliteFs!,
          vfsEvents: self.sqliteFs!.events,
          userConfigBundle,
          extraSyntheticFiles,
        });
        // Reserve a PID so `ps`/logs show it like any other facet.
        const entry = self.processTable.spawn('vite (real, ' + vfsRoot + ')', [], vfsRoot);
        self.processTable.setLongRunning(entry.pid);
        try {
          self.cirrusReal.start(self.ctx, entry.pid);
        } finally {
          // Cirrus-real boot allocation done (or threw). Pre-bundle is
          // free to resume. If start() threw, the gate must still
          // release so a future retry doesn't deadlock pre-bundle.
          clearTimeout(heavyAllocCeiling);
          heavyAllocRelease();
        }
        // Primitive #3 — register the cirrus-real port the same way
        // the default-Cirrus shim does. Same single hook; the only
        // difference is which handler.handleRequest the stub forwards
        // into.
        const cirrusStub = makeLongRunningPortStub(self.cirrusReal);
        self.portRegistry.register(vitePort, entry.pid, cirrusStub);
        self._viteShimPid = entry.pid;
        self._viteShimPort = vitePort;

        // ── Boot banner (§4.3 of PHASE2-REAL-VITE-PLAN.md) ──────
        const snap = (self.cirrusReal.stats as any).snapshot;
        ctx.stdout.write('\n\x1b[1;36m  Nimbus: real-vite mode\x1b[0m \x1b[2m(experimental, Phase 1-4)\x1b[0m\n\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Preview:    \x1b[36m' + previewBasePath + '/\x1b[0m\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Vite:       ' + (self.cirrusReal.stats as any).viteVersion + ' (bundled)\n');
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

      // Parse define config from vite.config.ts (e.g. define: { global: "globalThis" })
      let viteDefine: Record<string, string> | undefined;
      try {
        const cfgPath = [cwd + '/vite.config.ts', cwd + '/vite.config.js', cwd + '/vite.config.mjs']
          .find(p => self.sqliteFs!.exists(p));
        if (cfgPath) {
          let cfgCode = self.sqliteFs!.readFileString(cfgPath);
          if (cfgPath.endsWith('.ts')) {
            const t = await self.esbuildService!.transform(cfgCode, { loader: 'ts', format: 'esm' });
            cfgCode = t.code;
          }
          const defineMatch = cfgCode.match(/define\s*:\s*\{([^}]+)\}/);
          if (defineMatch) {
            viteDefine = {};
            const entries = defineMatch[1].matchAll(/["']?([^"',:\s]+)["']?\s*:\s*["']([^"']+)["']/g);
            for (const e of entries) viteDefine[e[1]] = e[2];
          }
        }
      } catch {}

      if (!self.esbuildService) self.esbuildService = new EsbuildService(self.sqliteFs!);
      const previewBasePath = self.viteBasePath;

      // Primitive #3 — long-running PORT-bound process registration.
      //
      // BEFORE this wave: vite was a fire-and-forget shell builtin. No
      // PID, no port, no log buffer, --port silently ignored. Markflow's
      // `vite --host 0.0.0.0 --port ${PORT:-3000}` printed a banner and
      // returned the prompt, leaving the user with a blank preview and
      // no process tab.
      //
      // AFTER: vite allocates a real PID via processTable, registers the
      // resolved port with the supervisor's port-registry, exposes a
      // handler stub via the generic long-running adapter, and is
      // visible to `ps` / the Process tab. `vite stop` (or `kill <pid>`)
      // tears it down via the same primitives that handle every other
      // long-running facet.
      //
      // Argv expansion: package.json scripts commonly write
      // `--port ${PORT:-3000}`. Nimbus's shell doesn't expand
      // parameter substitution, so we do it here against ctx.env right
      // before argv parsing — see runtime/long-running-handle.ts.
      const expandedArgs = expandArgvShellDefaults(args, ctx.env || {});
      const vitePortDefault = 5173;
      const resolvedPort = resolveLongRunningPort({
        argv: expandedArgs,
        env: ctx.env,
        configPort: viteConfig.port,
        fallback: vitePortDefault,
      });

      // Allocate PID FIRST so we can plumb it into ViteDevServer's
      // process-log wiring at construction time. The PID stays valid
      // for the life of this dev-server instance; subsequent log lines
      // emitted by ViteDevServer flow into processLogs[pid].stderr,
      // visible in the Process tab.
      const viteProcEntry = self.processTable.spawn(
        'vite (' + vfsRoot + ')',
        expandedArgs,
        vfsRoot,
      );
      self.processTable.setLongRunning(viteProcEntry.pid);

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
        // Primitives wave (P8): wire dev-server diagnostics into the
        // supervisor's per-PID log store so the Process tab is no
        // longer silent after the banner.
        pid: viteProcEntry.pid,
        processLogs: self.processLogs,
      });
      self.viteDevServer.start();
      try {
        await self.ctx.storage.put('vite-config', {
          root: vfsRoot, aliases: viteConfig.alias, define: viteDefine,
          injectBasename: viteConfig.injectBasename, basePath: previewBasePath,
          port: resolvedPort,
        });
      } catch {}

      // Register the port and build the long-running stub. The stub
      // forwards into the in-process viteDevServer through the generic
      // long-running adapter — same hook every future long-running
      // facet uses (Express, Bun.serve, http.createServer().listen()).
      const viteStub = makeLongRunningPortStub(self.viteDevServer);
      self.portRegistry.register(resolvedPort, viteProcEntry.pid, viteStub);
      // Track the wiring so `vite stop` and crash-handlers can tear it
      // down without searching the registry.
      self._viteShimPid = viteProcEntry.pid;
      self._viteShimPort = resolvedPort;

      // Spawn / long-running event for the Process tab UI. Mirrors the
      // shellExecuteTracked banner so the user sees the same shape no
      // matter how vite was invoked.
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
      });

      // Banner — kept for back-compat. Now also reports the resolved
      // port and PID so the user can verify the multi-target routing.
      ctx.stdout.write('\n\x1b[1;36m  Nimbus Vite Dev Server v2.0\x1b[0m\n\n');
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
      const twCfg = [vfsRoot + '/tailwind.config.js', vfsRoot + '/tailwind.config.ts'].find(p => self.sqliteFs!.exists(p));
      if (twCfg) ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Tailwind:   edge-vendored Play CDN \x1b[2m(detected)\x1b[0m\n');
      ctx.stdout.write('\n  \x1b[2mRun \x1b[0mvite stop\x1b[2m, or \x1b[0mkill ' + viteProcEntry.pid + '\x1b[2m, to stop.\x1b[0m\n\n');
      return 0;
    });

    // ── nimbus-wrangler / wrangler command: Worker dev server ─────────────
    //
    // `wrangler` is registered as a transparent alias for `nimbus-wrangler`
    // so projects with `"dev": "wrangler dev"` in package.json Just Work.
    // The shared handler below takes an extra `invokedAs` flag so we can
    // - print a one-shot "DO-in-DO mode" banner on the first wrangler
    //   invocation per session (so users know they're getting a compat
    //   layer, not real wrangler)
    // - silently strip wrangler-specific flags (--ip, --port, etc.) that
    //   have no meaning inside a DO.
    const wranglerHandler = (invokedAs: 'wrangler' | 'nimbus-wrangler') =>
      async (ctx: any): Promise<number> => {
        const rawArgs: string[] = ctx.args || [];

        // Filter wrangler-only flags early (works for both invocation paths;
        // a no-op for nimbus-wrangler since it doesn't accept them anyway).
        const { args, ignored } = filterWranglerFlags(rawArgs);

        if (args.includes('--help') || args.includes('-h') || args.length === 0) {
          ctx.stdout.write(`Usage: ${invokedAs} dev [options]\n\n`);
          ctx.stdout.write('Run your Cloudflare Worker locally on the actual CF runtime\n');
          ctx.stdout.write('(DO-in-DO via env.LOADER — workerd in a workerd).\n\n');
          ctx.stdout.write('Commands:\n');
          ctx.stdout.write('  dev           Start the dev server\n');
          ctx.stdout.write('  stop          Stop the dev server\n\n');
          ctx.stdout.write('Options:\n');
          ctx.stdout.write('  --root <dir>  Project root (default: cwd)\n\n');
          if (invokedAs === 'wrangler') {
            ctx.stdout.write('Note: \x1b[2minside Nimbus, `wrangler` is an alias for\x1b[0m \x1b[36mnimbus-wrangler\x1b[0m.\n');
            ctx.stdout.write('Most real-wrangler flags (--ip, --port, --local, --log-level, ...)\n');
            ctx.stdout.write('are silently ignored because the DO provides its own routing.\n');
          }
          return 0;
        }

        if (args[0] === 'stop') {
          if (self.nimbusWrangler?.isRunning) {
            self.nimbusWrangler.stop();
            ctx.stdout.write('\x1b[33mWorker dev server stopped.\x1b[0m\n');
          } else {
            ctx.stdout.write('No Worker dev server running.\n');
          }
          return 0;
        }

        if (args[0] !== 'dev') {
          ctx.stderr.write(
            `Unknown command: ${args[0]}. Use "${invokedAs} dev" or "${invokedAs} --help".\n`,
          );
          return 1;
        }

        // First-run banner — only when invoked as `wrangler`, and only once
        // per session. Makes it OBVIOUS to the user that they're not running
        // real wrangler, and that Nimbus is doing something different.
        if (invokedAs === 'wrangler' && !self.wranglerAliasBannerShown) {
          ctx.stdout.write(
            '\x1b[2m\u2388  wrangler (Nimbus DO-in-DO mode) — bundling via esbuild-wasm, running via env.LOADER\x1b[0m\n',
          );
          self.wranglerAliasBannerShown = true;
        }

        // Report ignored flags (also one-shot — if user sees it once per
        // session that's enough to spot a typo; no need to spam on rebuilds).
        if (ignored.length > 0 && invokedAs === 'wrangler') {
          ctx.stdout.write(
            '\x1b[2m   ignored wrangler flags: ' + ignored.join(' ') + '\x1b[0m\n',
          );
        }

        // Lazy-init esbuild
        if (!self.esbuildService) {
          self.ensureSqliteFs();
          self.esbuildService = new EsbuildService(self.sqliteFs!);
        }

        // Parse --root flag; default to the shell cwd so `npm run dev` from
        // a project directory picks up that project's wrangler.jsonc.
        let root = ctx.cwd || '/home/user';
        for (let i = 1; i < args.length; i++) {
          if (args[i] === '--root' && args[i + 1]) root = args[i + 1];
        }

        // Stop existing
        if (self.nimbusWrangler?.isRunning) self.nimbusWrangler.stop();

        const vfsRoot = root.replace(/^\/+/, '');

        // Pre-flight: read the wrangler config ourselves and call out any
        // binding fields nimbus-wrangler can't provide. NimbusWrangler will
        // still try to bundle + load, but user sees up-front why their
        // Worker may fail when it tries to access a missing binding.
        const unsupportedFields = detectUnsupportedWranglerConfig(self.sqliteFs!, vfsRoot);

        ctx.stdout.write('\n');
        ctx.stdout.write('\x1b[1;35m  ' + (invokedAs === 'wrangler' ? 'Wrangler' : 'Nimbus Wrangler') + ' Dev\x1b[0m\n\n');

        if (unsupportedFields.length > 0) {
          ctx.stderr.write(
            '\x1b[33m\u26A0\x1b[0m  \x1b[1mNimbus-incompatible wrangler.jsonc fields detected:\x1b[0m\n',
          );
          for (const f of unsupportedFields) {
            ctx.stderr.write('   - \x1b[33m' + f + '\x1b[0m\n');
          }
          ctx.stderr.write(
            '   These bindings are NOT provisioned inside nimbus-wrangler. Your Worker\n' +
            '   will get \x1b[2mundefined\x1b[0m when it tries to access them, which typically\n' +
            '   causes a runtime TypeError. The bundle will still build and load.\n' +
            '   \x1b[2mDeploy with real wrangler to get the real bindings.\x1b[0m\n\n',
          );
        }

        self.nimbusWrangler = new NimbusWrangler({
          vfs: self.sqliteFs!,
          esbuild: self.esbuildService!,
          env: self.env,
          // Supervisor DO ctx — required for ctx.facets.get() when
          // synthesizing durable_objects bindings on the inner Worker.
          ctx: self.ctx,
          root: vfsRoot,
          onLog: (msg) => {
            if (self.terminal) {
              try { self.terminal.write(msg); } catch {}
            }
          },
          onHmrMessage: (msg) => {
            if (self.terminal) {
              try { self.terminal.ws.send(JSON.stringify({ type: 'hmr', data: msg })); } catch {}
            }
          },
        });

        const ok = await self.nimbusWrangler.start();
        if (!ok) {
          ctx.stderr.write('  \x1b[31mFailed to start Worker dev server.\x1b[0m\n');
          return 1;
        }

        const cfg = self.nimbusWrangler.stats;
        // Primitives wave (P5): banner advertises the canonical
        // `/__nimbus/worker/` route. The legacy `/worker/` URL is still
        // accepted for one release (Sunset 2027-01-01) but new sessions
        // are pointed at the namespaced form.
        const workerBase = (self.sessionBasePath || '') + '/__nimbus/worker';
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Worker:   \x1b[36m' + workerBase + '/\x1b[0m\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Name:     ' + cfg.name + '\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Entry:    ' + cfg.main + '\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Root:     ' + cfg.root + '\n');
        ctx.stdout.write('  \x1b[32m\u279C\x1b[0m  Reload:   on file change\n\n');
        ctx.stdout.write('  \x1b[2mRun \x1b[0m' + invokedAs + ' stop\x1b[2m to stop.\x1b[0m\n\n');
        return 0;
      };

    registry.register('nimbus-wrangler', wranglerHandler('nimbus-wrangler'));
    registry.register('wrangler', wranglerHandler('wrangler'));

    // ── npm-fast command: parallel npm install (v2 — batched writes) ────
    registry.register('npm-fast', async (ctx: any) => {
      const args: string[] = ctx.args || [];

      if (args.includes('--help') || args.includes('-h') || args.length === 0) {
        ctx.stdout.write('Usage: npm-fast install <packages...>\n\n');
        ctx.stdout.write('Nimbus npm v2 — batched VFS writes, content-addressed cache.\n');
        ctx.stdout.write('Handles 100+ dependency projects without crashing.\n');
        return 0;
      }

      if (args[0] !== 'install' && args[0] !== 'i') {
        ctx.stderr.write('Only "npm-fast install" is supported. Use "npm" for other commands.\n');
        return 1;
      }

      const packages = args.slice(1).filter((a: string) => !a.startsWith('-'));
      if (packages.length === 0) {
        ctx.stderr.write('Specify packages to install: npm-fast install react react-dom\n');
        return 1;
      }

      self.ensureSqliteFs();
      const cwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');

      // Ensure package.json exists
      const pkgJsonPath = cwd + '/package.json';
      if (!self.sqliteFs!.exists(pkgJsonPath)) {
        self.sqliteFs!.writeFile(pkgJsonPath, '{"name":"project","version":"1.0.0","dependencies":{}}\n');
      }

      ctx.stdout.write('\x1b[36mNimbus npm v2 (batched writes)\x1b[0m\n');

      self.ensureNpmInstaller((msg: string) => {
        ctx.stdout.write('[npm] ' + msg + '\n');
      });
      const result = await self.npmInstaller!.install(cwd, { packages });

      if (result.failed.length > 0) {
        ctx.stderr.write('\x1b[31mFailed: ' + result.failed.join(', ') + '\x1b[0m\n');
      }

      // [HONEST INSTALL MESSAGE P0a] Yellow + "(N failed, see above)"
      // when partial. Green only when failed.length === 0. Pre-fix the
      // green line printed unconditionally — see user transcript line
      // 831 ("added 264 packages" with 353 silent failures above).
      const partial = result.failed.length > 0;
      const color = partial ? '\x1b[33m' : '\x1b[32m';
      const suffix = partial ? ` (${result.failed.length} failed, see above)` : '';
      ctx.stdout.write(
        `\n${color}added ${result.installed.length} packages (${result.totalFiles} files) in ${(result.elapsed / 1000).toFixed(1)}s${suffix}\x1b[0m\n`
      );
      if (result.cachedHits > 0) {
        ctx.stdout.write(`\x1b[2m  (${result.cachedHits} from cache)\x1b[0m\n`);
      }
      return result.failed.length > 0 ? 1 : 0;
    });

    // ── Set up environment [B'.1: rehydrate from SQL] ──
    //
    // Cold start: env is the platform default below.
    // Silent re-init (persisted env present): the Shell's constructor
    // does `this.env = { ...n }`, so we layer the persisted env over
    // the defaults — defaults provide PATH/PS1/etc. (which the user
    // never sets explicitly), persisted overlays whatever the user
    // did set (NIMBUS_TEST=cool, etc.).
    //
    // Primitive #7 (primitives-extension wave): PORT/HOST and
    // NIMBUS_SESSION_ID are part of the standard contract.
    //
    //   PORT=3000  — the same default Markflow's `${PORT:-3000}` shell
    //                expansion targets, and what every Express/Hono/
    //                fastify/Bun.serve script reads when the user
    //                doesn't set it explicitly. Long-running spawns
    //                still pull from `--port` argv first (see
    //                runtime/long-running-handle.ts:resolveLongRunningPort);
    //                this default is the SOURCE for that fall-through.
    //
    //   HOST=0.0.0.0 — Cloudflare Workers / DO have no localhost vs.
    //                external distinction (the supervisor never opens
    //                a real socket); 0.0.0.0 is what every tutorial
    //                tells users to bind to and matches CF docs.
    //
    //   NIMBUS_SESSION_ID — derived from sessionBasePath = "/s/<id>".
    //                Set lazily here as a placeholder ("") and patched
    //                below right after Shell construction so the user's
    //                first command sees the real id.
    //
    //   Why these aren't optional: package.json scripts that hardcode
    //   process.env.PORT (Express's default app, every "create-vite"
    //   template) get `undefined` without this. Sentry / Datadog / any
    //   ops integration that wants a session-stable token uses
    //   NIMBUS_SESSION_ID.
    const env: Record<string, string> = {
      HOME: '/home/user',
      USER: 'user',
      SHELL: '/bin/sh',
      HOSTNAME: DEFAULT_HOSTNAME,
      TERM: 'xterm-256color',
      PWD: '/home/user',
      PATH: '/usr/local/bin:/usr/bin:/bin:/home/user/.local/bin',
      PS1: `\x1b[1;32muser@${DEFAULT_HOSTNAME}\x1b[0m:\x1b[1;34m\\w\x1b[0m$ `,
      NODE_ENV: 'development',
      LANG: 'en_US.UTF-8',
      EDITOR: 'nano',
      NIMBUS_VERSION: NIMBUS_VERSION,
      TMPDIR: '/tmp',
      XDG_CONFIG_HOME: '/home/user/.config',
      XDG_DATA_HOME: '/home/user/.local/share',
      npm_config_prefix: '/usr/local',
      // Primitive #7 contract additions.
      PORT: '3000',
      HOST: '0.0.0.0',
      NIMBUS_SESSION_ID: '', // patched after Shell ctor — see below.
      // Persisted env keys win over defaults — the user's `export FOO=bar`
      // survives reconnect.
      ...(persisted.env || {}),
    };

    // ── Create shell ──
    const processRegistry = new ProcessRegistry();
    self.shell = new Shell(self.terminal, self.kernel.vfs, registry, env, processRegistry);

    // Primitive #7: patch NIMBUS_SESSION_ID into the live shell env.
    // sessionBasePath is "/s/<sid>" set by the X-Nimbus-Base header on
    // the first /ws upgrade — by the time initSession runs (after the
    // ws handshake), it's populated. Older /ws-pre-base callers see
    // an empty string, which is the safe placeholder (no false id).
    //
    // We patch the live env (not the local `env` map above) so persisted
    // shell state on warm-rejoin still picks up the SAME session id —
    // the DO's name is stable across hibernation cycles. Any user
    // `export NIMBUS_SESSION_ID=...` would have been persisted to
    // persisted.env and the spread above would have overridden the
    // empty placeholder; we only set when the live env is empty
    // (don't clobber a user-set value).
    const sessionIdFromBase = (self.sessionBasePath || '').replace(/^\/s\//, '');
    if (sessionIdFromBase) {
      // Shell.env is declared private but mutable at runtime — there's
      // no public setter. We `any`-cast deliberately; the alternative
      // (replacing the whole Shell after ctor) would lose the kernel +
      // registry wiring. Anti-req note: this is NOT a defensive cast,
      // it's a deliberate single-write operation to plug the contract
      // gap that env-construction couldn't fill (sessionBasePath
      // wasn't yet hydrated at ctor time).
      const shellAny = self.shell as any;
      if (!shellAny.env.NIMBUS_SESSION_ID) {
        shellAny.env.NIMBUS_SESSION_ID = sessionIdFromBase;
      }
    }

    // Rehydrate cwd if persisted. The Shell ctor defaults this.cwd to
    // env.HOME (which we did NOT override in the persisted overlay
    // above — HOME stays the platform default). setCwd is exposed in
    // the Shell's public API; cd-builtin assigns this.cwd directly
    // bypassing setCwd (verified in node_modules/@lifo-sh/core), but
    // restoring AFTER construction is fine because nothing has called
    // cd yet. The next user `cd` will of course work as expected.
    if (persisted.cwd) {
      try { self.shell.setCwd(persisted.cwd); } catch { /* fail-soft */ }
    }

    // ── Heredoc support (<<) — all logic lives in shell-features.ts ──
    HeredocHandler.install(self.shell, self.terminal, self.sqliteFs!);

    // ── Wire npm/npx with shellExecute ──
    const shell = self.shell;
    const shellExecute = async (cmd: string, cmdCtx: any): Promise<number> => {
      const result = await shell.execute(cmd, {
        cwd: cmdCtx.cwd,
        env: cmdCtx.env,
        onStdout: (d: string) => cmdCtx.stdout.write(d),
        onStderr: (d: string) => cmdCtx.stderr.write(d),
      });
      return result.exitCode;
    };

    // ── Fix 3: tracked shell.execute — wires output into processTable +
    //   ProcessLogStore so scripts that bypass the facet pipeline (like
    //   npm-run fallthrough) still show up in `ps`, `logs`, and exit
    //   dumps. Mirrors the instrumentation `_rpcStdout` / `_rpcStderr`
    //   already provide for facet processes.
    //
    //   Also honours the `longRunning` flag: pass `longRunning=true` for
    //   npm run dev / start so the `[started (long-running): pid=N ...]`
    //   banner matches the existing facet UX.
    //   Note: `self` is declared earlier in this method (line ~1359).
    const shellExecuteTracked = async (
      cmd: string,
      cmdCtx: any,
      opts: { longRunning?: boolean } = {},
    ): Promise<number> => {
      const argv = cmd.split(/\s+/).filter(Boolean);
      const entry = self.processTable.spawn(cmd, argv, cmdCtx.cwd || '/home/user');
      const pid = entry.pid;
      const startedAt = Date.now();

      // Spawn banner — matches facet-manager.ts onSpawn format.
      if (self.terminal) {
        const label = opts.longRunning ? 'started (long-running)' : 'started';
        self.terminal.write(
          `\x1b[2m[shell ${label}: pid=${pid} cmd="${cmd}"]\x1b[0m\r\n`,
        );
      }
      // Structured spawn event for the tabs UI (mirrors the facet-manager
      // onSpawn hook). Long-running shell commands like `vite` and
      // `wrangler dev` trigger auto-open of a log tab.
      notifyTerminalEvent(self.terminal, {
        type: 'spawn', pid, command: cmd, longRunning: !!opts.longRunning,
      });

      // Wrap the caller-supplied streams so every chunk is both displayed
      // AND captured in the ring buffer keyed by this PID.
      const tee = (stream: 'stdout' | 'stderr', target: { write: (d: string) => void }) => (d: string) => {
        try { self.processLogs.append(pid, stream, String(d)); } catch {}
        try { target.write(d); } catch {}
      };

      let exitCode = 1;
      try {
        const result = await shell.execute(cmd, {
          cwd: cmdCtx.cwd,
          env: cmdCtx.env,
          onStdout: tee('stdout', cmdCtx.stdout),
          onStderr: tee('stderr', cmdCtx.stderr),
        });
        exitCode = result.exitCode;
      } catch (e: any) {
        // Surface the error in the terminal AND the ring buffer — the
        // whole reason this path exists is to stop silent failures.
        const msg = (e && (e.stack || e.message)) || String(e);
        tee('stderr', cmdCtx.stderr)('shellExecuteTracked error: ' + msg + '\n');
        exitCode = 1;
      } finally {
        try { self.processTable.exit(pid, exitCode); } catch {}
        try {
          if (!self.processLogs.getExit(pid)) {
            self.processLogs.markExit(pid, exitCode);
          }
        } catch {}

        // Structured exit for the tabs UI. Always fires (the UI doesn't
        // know which tabs are open, and client-side dedupe is trivial).
        // Include the command so the UI can backfill a tab for pids it
        // never saw a spawn event for (e.g. evals routed past onSpawn).
        notifyTerminalEvent(self.terminal, { type: 'exit', pid, code: exitCode, command: cmd });

        // Fix 5 trace + Fix 4 dump both read this state; invoke the
        // session helper so semantics stay in one place.
        try { self._emitShellExecDone(pid, cmd, exitCode, Date.now() - startedAt); } catch {}
      }
      return exitCode;
    };
    // ── Primitive #2 (primitives-extension wave): generic .bin handler ──
    //
    // Direct terminal invocation of `<bincmd> [args]` (e.g. `tsc --version`,
    // `prettier --check .`, `eslint .`) used to fall through to "command
    // not found" because `registry.resolve(name)` only knows about
    // pre-registered commands. The user had to type `npm run <script>`
    // — but that requires a script entry in package.json.
    //
    // Fix: wrap registry.resolve. When the upstream resolver returns
    // undefined AND the cwd has `node_modules/.bin/<name>`, synthesise
    // a handler that:
    //   - reads the shim's "node <relative-script>" pointer (the
    //     node_modules/.bin/<name> file is a tiny POSIX wrapper or a
    //     direct JS file in well-formed packages);
    //   - feeds the resulting `node <script> <args...>` line through
    //     shellExecuteTracked so the bin gets a PID, log buffer,
    //     processTable entry, and Process tab presence — same long-
    //     running treatment as a `npm run dev` script.
    //
    // Long-running detection: if the bin name is dev/start/serve/watch,
    // OR the argv contains explicit watch/dev/serve flags, the
    // shellExecuteTracked call gets longRunning=true so the Process
    // tab opens automatically and ^C/restart wires through.
    //
    // This is generic — it does NOT enumerate per-bin behaviours.
    // Every project's bin shims are picked up the same way.
    const LONG_RUNNING_BIN_NAMES = new Set([
      'vite', 'next', 'astro', 'nuxt', 'remix', 'serve', 'http-server',
      'wrangler', 'nodemon', 'tsx', 'ts-node-dev', 'webpack-dev-server',
      'parcel', 'rollup', 'esbuild', 'turbo',
    ]);
    function looksLongRunning(binName: string, argv: string[]): boolean {
      // Bin name says "long-running"
      if (LONG_RUNNING_BIN_NAMES.has(binName)) {
        // ...unless the user passed a one-shot subcommand or version flag.
        for (const a of argv) {
          if (a === '--version' || a === '-v' || a === '--help' || a === '-h') return false;
          if (a === 'build' || a === 'preview') return false;
        }
        return true;
      }
      // Argv flag says "long-running"
      for (const a of argv) {
        if (a === '--watch' || a === '-w' || a === '--serve' || a === '--dev') return true;
      }
      return false;
    }

    const upstreamResolve = registry.resolve.bind(registry);
    (registry as any).resolve = async function nimbusBinFallbackResolve(name: string): Promise<any> {
      const upstream = await upstreamResolve(name);
      if (upstream) return upstream;
      // CRITICAL: probe for the bin shim BEFORE returning a handler.
      // If we always returned a handler, callers like Nimbus's npx
      // wrapper that check `if (resolved) { use resolved } else
      // { fall through to core's auto-install }` would never reach
      // the auto-install path — every unknown name would short-circuit
      // through us and fail with "command not found", regressing
      // `npx <pkg>` for unstalled packages.
      //
      // The cwd lookup uses self.shell.cwd (the live shell state)
      // when no specific cwd is supplied. Best-effort: if shell isn't
      // built yet (very early init), fall back to /home/user.
      const cwd = ((self.shell as any)?.cwd || '/home/user').replace(/^\/+/, '');
      const binShimPath = cwd + '/node_modules/.bin/' + name;
      if (!sqliteFs.exists(binShimPath)) return undefined;
      // Synthesised handler. Each resolve call recomputes (cwd can
      // change between invocations); we never cache under `name`.
      return async (ctx: any): Promise<number> => {
        // Re-check at INVOCATION TIME against ctx.cwd — the cwd at
        // resolve() time was the shell's current cwd, but the user
        // could have piped through a subshell since. Same path
        // computation as above; identical when cwd hasn't changed.
        const ctxCwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');
        const ctxBinShimPath = ctxCwd + '/node_modules/.bin/' + name;
        if (!sqliteFs.exists(ctxBinShimPath)) {
          ctx.stderr.write(`${name}: command not found\n`);
          return 127;
        }
        const binShimPath = ctxBinShimPath;

        // Bin shims are typically a 2-liner:
        //   #!/usr/bin/env node
        //   require('../lib/<entry>.js')
        //
        // We can't just feed the shim to Nimbus's node command:
        //   1. The shebang line isn't stripped (real node strips it
        //      pre-parse; Nimbus's node-runner does not).
        //   2. The require's relative path is anchored to the SHIM's
        //      directory (.../node_modules/.bin/), so running the
        //      shim from a different cwd resolves wrong.
        //
        // Approach: parse the shim to find the actual entry script,
        // resolve it against the shim's directory, and pass THAT
        // directly to node. The entry script handles its own require
        // graph from its real location.
        let entryAbsPath: string;
        try {
          const shimCode = sqliteFs.readFileString(binShimPath);
          const stripped = shimCode.replace(/^#![^\n]*\n/, '');
          const reqMatch = stripped.match(/require\s*\(\s*["']([^"']+)["']\s*\)/);
          if (!reqMatch) {
            // Some shims are direct JS (no wrapper require). Fall back
            // to running the stripped-shebang version verbatim.
            const tmpPath = 'tmp/.bin-' + name + '.js';
            try { sqliteFs.mkdir('tmp', { recursive: true }); } catch {}
            sqliteFs.writeFile(tmpPath, stripped);
            entryAbsPath = tmpPath;
          } else {
            const reqArg = reqMatch[1];
            // Three possible shim shapes we observe in the wild:
            //   1. `require('../lib/X.js')` — relative; resolve against
            //      shim's directory. Real-Node convention.
            //   2. `require('home/user/.../X')` — VFS-absolute (no
            //      leading slash, no leading dot). This is what
            //      Nimbus's installer at npm/installer.ts:1453
            //      generates. Use the path AS-IS.
            //   3. `require('/abs/path')` — POSIX absolute. Strip the
            //      leading slash and use directly.
            //
            // Discriminator: a leading '.' marks (1); otherwise treat
            // as already-resolved (2 or 3).
            if (reqArg.startsWith('./') || reqArg.startsWith('../')) {
              const shimDir = binShimPath.substring(0, binShimPath.lastIndexOf('/'));
              const parts = (shimDir + '/' + reqArg).split('/');
              const stack: string[] = [];
              for (const p of parts) {
                if (p === '' || p === '.') continue;
                if (p === '..') { stack.pop(); continue; }
                stack.push(p);
              }
              entryAbsPath = stack.join('/');
            } else {
              entryAbsPath = reqArg.replace(/^\/+/, '');
            }
            // Try common JS extensions if the file doesn't exist
            // verbatim (some shims drop them).
            if (!sqliteFs.exists(entryAbsPath)) {
              for (const ext of ['.js', '.cjs', '.mjs']) {
                if (sqliteFs.exists(entryAbsPath + ext)) {
                  entryAbsPath = entryAbsPath + ext;
                  break;
                }
              }
            }
            if (!sqliteFs.exists(entryAbsPath)) {
              ctx.stderr.write(`${name}: bin entry not found: ${entryAbsPath}\n`);
              return 1;
            }
          }
        } catch (e: any) {
          ctx.stderr.write(`${name}: failed to parse bin shim: ${e?.message || e}\n`);
          return 1;
        }
        const argv: string[] = ctx.args || [];
        const longRunning = looksLongRunning(name, argv);
        // CRITICAL: do NOT route through shell.execute → registry.resolve
        // → this same wrapper (would recurse). Instead, invoke the
        // 'node' command directly with the bin shim as argv[0]. The
        // node command is registered upstream-side, so upstreamResolve
        // returns the real handler; no recursion.
        const nodeCmd = await upstreamResolve('node');
        if (!nodeCmd) {
          ctx.stderr.write(`${name}: node command unavailable\n`);
          return 1;
        }
        // Build shell-line for the spawn-tracked banner: the user-facing
        // command label that `ps` and the Process tab show.
        const shellLine = `${name} ${argv.join(' ')}`.trim();
        // PID + log + (if long-running) port-registry: shellExecuteTracked
        // does this. But we've established it can recurse via
        // shell.execute. To get the bookkeeping WITHOUT the recursion,
        // we replicate the spawn-banner + processTable.spawn dance
        // here, then dispatch via nodeCmd directly.
        const entry = self.processTable.spawn(shellLine, [name, ...argv], cwd);
        const pid = entry.pid;
        const startedAt = Date.now();
        if (longRunning) {
          self.processTable.setLongRunning(pid);
        }
        if (self.terminal) {
          const label = longRunning ? 'started (long-running)' : 'started';
          self.terminal.write(
            `\x1b[2m[bin ${label}: pid=${pid} cmd="${shellLine}"]\x1b[0m\r\n`,
          );
        }
        notifyTerminalEvent(self.terminal, {
          type: 'spawn', pid, command: shellLine, longRunning,
        });

        // Tee output through processLogs the same way shellExecuteTracked
        // does, so logs <pid> + the Process tab WS log stream see chunks.
        const tee = (stream: 'stdout' | 'stderr', target: { write: (d: string) => void }) => (d: string) => {
          try { self.processLogs.append(pid, stream, String(d)); } catch {}
          try { target.write(d); } catch {}
        };

        let exitCode = 1;
        try {
          // Prepend '/' so nodeCmd's path-resolver treats this as an
          // absolute VFS path (line ~295) rather than cwd-relative.
          // entryAbsPath is already VFS-absolute (no leading slash, no
          // ./../); we just adapt to nodeCmd's input contract.
          const entryForNode = '/' + entryAbsPath;
          exitCode = await nodeCmd({
            ...ctx,
            args: [entryForNode, ...argv],
            stdout: { write: tee('stdout', ctx.stdout) },
            stderr: { write: tee('stderr', ctx.stderr) },
          });
        } catch (e: any) {
          const msg = (e && (e.stack || e.message)) || String(e);
          tee('stderr', ctx.stderr)(`bin error: ${msg}\n`);
          exitCode = 1;
        } finally {
          try { self.processTable.exit(pid, exitCode); } catch {}
          try {
            if (!self.processLogs.getExit(pid)) {
              self.processLogs.markExit(pid, exitCode);
            }
          } catch {}
          notifyTerminalEvent(self.terminal, { type: 'exit', pid, code: exitCode, command: shellLine });
          try { self._emitShellExecDone(pid, shellLine, exitCode, Date.now() - startedAt); } catch {}
        }
        return exitCode;
      };
    };

    // Register core npm with enhanced `npm run <script>` support
    const coreNpmCmd = createNpmCommand(registry, shellExecute, kernel);
    registry.register('npm', async (ctx: any) => {
      const args: string[] = ctx.args || [];
      const sub = args[0];

      // npm run <script> / npm test / npm start — parse package.json and execute
      if (sub === 'run' || sub === 'run-script' || sub === 'test' || sub === 'start') {
        const scriptName = sub === 'test' ? 'test' : sub === 'start' ? 'start' : args[1];
        if (!scriptName) {
          // npm run (no script) — list available scripts
          const pkgPath = (ctx.cwd || '/home/user').replace(/^\/+/, '') + '/package.json';
          try {
            const pkg = JSON.parse(sqliteFs.readFileString(pkgPath));
            if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
              ctx.stdout.write('Lifecycle scripts:\n');
              for (const [name, cmd] of Object.entries(pkg.scripts)) {
                ctx.stdout.write(`  ${name}\n    ${cmd}\n`);
              }
            } else {
              ctx.stdout.write('No scripts found in package.json\n');
            }
          } catch { ctx.stderr.write('npm ERR! no package.json found\n'); return 1; }
          return 0;
        }

        const pkgPath = (ctx.cwd || '/home/user').replace(/^\/+/, '') + '/package.json';
        try {
          const pkg = JSON.parse(sqliteFs.readFileString(pkgPath));
          const script = pkg.scripts?.[scriptName];
          if (!script) {
            ctx.stderr.write(`npm ERR! Missing script: "${scriptName}"\n`);
            if (pkg.scripts) {
              ctx.stderr.write('npm ERR! Available scripts:\n');
              for (const name of Object.keys(pkg.scripts)) ctx.stderr.write(`  - ${name}\n`);
            }
            return 1;
          }

          // ── node_modules preflight ────────────────────────────────────
          // If the script invokes a known bundler/framework CLI (vite, next,
          // webpack, tsc, ...) and node_modules is missing, HARD-FAIL before
          // running it — the tool would crash with a cryptic "command not
          // found" / "cannot find package" error that's less helpful.
          // For custom/unknown scripts (e.g. `echo hi`), emit a warning but
          // continue — the user's intent might not need deps at all.
          // Bypass with --force / --no-install-check in the script args, or
          // by setting NIMBUS_SKIP_INSTALL_CHECK=1 in env.
          const scriptArgs = args.slice(sub === 'run' || sub === 'run-script' ? 2 : 1);
          const bypassRunCheck =
            scriptArgs.includes('--force') ||
            scriptArgs.includes('--no-install-check') ||
            ctx.env?.NIMBUS_SKIP_INSTALL_CHECK === '1';
          if (!bypassRunCheck) {
            const projDir = (ctx.cwd || '/home/user').replace(/^\/+/, '');
            const guard = checkNodeModulesGuard(sqliteFs, projDir);
            if (guard.missing) {
              const bundler = detectBundlerBin(script);
              if (bundler) {
                // Hard fail: script needs a bundler binary that lives in node_modules/.bin.
                ctx.stderr.write(
                  '\x1b[31m\u2718\x1b[0m \x1b[1mnode_modules/ not found\x1b[0m — ' +
                  `script "${scriptName}" runs \x1b[36m${bundler}\x1b[0m which needs installed dependencies ` +
                  `(${guard.depCount} declared).\n` +
                  '  Run \x1b[36mnpm install\x1b[0m first,\n' +
                  '  or re-run with \x1b[36mnpm run ' + scriptName + ' -- --force\x1b[0m to skip this check.\n'
                );
                return 1;
              }
              // Soft warning: script might not need deps; let it try.
              ctx.stderr.write(
                '\x1b[33m\u26A0\x1b[0m  node_modules/ not found (' + guard.depCount + ' deps declared) — ' +
                'proceeding anyway. Run \x1b[36mnpm install\x1b[0m if the script fails.\n\n'
              );
            }
          }

          ctx.stdout.write(`\n> ${pkg.name || 'project'}@${pkg.version || '1.0.0'} ${scriptName}\n`);
          ctx.stdout.write(`> ${script}\n\n`);

          // ── Next.js loud-block (was W11 per-framework substrate) ──────
          //
          // Primitives wave (P12): the previous wave shipped this as a
          // 45-line standalone module at src/frameworks/next.ts that
          // exported nothing but the strings used here. Per the
          // "no per-framework substrate" rule, the message is inlined
          // (the only thing the module did was hold these strings) and
          // the file is deleted.
          //
          // Next.js dev/start still needs a custom http.Server +
          // child_process.fork with v8-IPC + webpack/Turbopack, none of
          // which Nimbus ships. We surface a deterministic message
          // rather than letting the script hang or emit a confusing
          // crash. The block remains a one-off symbol-detection
          // guard, NOT a generic per-framework code path. Any future
          // similar guard belongs alongside this one — not in its own
          // src/frameworks/<name>.ts file.
          if (
            (scriptName === 'dev' || scriptName === 'start') &&
            (pkg.dependencies?.next || pkg.devDependencies?.next) &&
            !(scriptArgs.includes('--force') || scriptArgs.includes('--allow-next'))
          ) {
            const NEXT_BLOCK_MESSAGE =
              '\x1b[31m\u2718\x1b[0m \x1b[1mNext.js dev server is not supported in Nimbus.\x1b[0m\n' +
              '   Specific blockers:\n' +
              "     1. \x1b[2mchild_process.fork\x1b[0m IPC uses v8-serializer (Nimbus ships JSON projection).\n" +
              '     2. webpack / Turbopack bundlers are not integrated with the pre-bundle pipeline.\n' +
              '     3. Custom \x1b[2mhttp.Server\x1b[0m semantics (keep-alive, raw sockets) are facet-incompatible.\n' +
              '\n' +
              '   Workaround: deploy with \x1b[36mnext build\x1b[0m + a hosted runtime,\n' +
              '   or pass \x1b[36m--allow-next\x1b[0m to bypass at your own risk.\n';
            ctx.stderr.write(NEXT_BLOCK_MESSAGE);
            return 127;
          }

          // ── Shell-composite detection ──────────────────────────────────
          // Scripts like `cd packages/cf-backend && vite dev` or
          // `NODE_ENV=prod node build.js | tee log` need the full shell
          // parser (operators, builtins like cd/export, pipes, redirects,
          // env-var prefixes, globs, heredocs). The naive whitespace split
          // below can only handle a single bare command — for anything
          // else it mis-identifies the first token (e.g. "cd") as the
          // command name, fails to resolve it in the registry, and emits
          // a misleading "cd: command not found".
          //
          // `shellExecuteTracked` routes through `shell.execute` which
          // IS the full shell (same path as interactive terminal input),
          // so composite scripts behave identically to typing them at
          // the prompt.
          //
          // Metacharacters checked:
          //   &&  ||  |  ;           operator chains + pipes
          //   > <                    redirects (covers >> and <<)
          //   ` $(                   command substitution
          //   ^NAME=                 leading env-var prefix (VAR=x cmd)
          // Single-command scripts (no metacharacters) still take the
          // fast registry path below for better stdout wiring + clearer
          // "unsupported" / "command not found" messages.
          const scriptTrim = script.trim();
          const hasShellMeta =
            /(\&\&|\|\||[|;<>`]|\$\()/.test(scriptTrim) ||
            /^[A-Za-z_][A-Za-z0-9_]*=/.test(scriptTrim);
          if (hasShellMeta) {
            const longRunningComposite =
              scriptName === 'dev' || scriptName === 'start' ||
              scriptName === 'serve' || scriptName === 'watch';
            return await shellExecuteTracked(scriptTrim, {
              ...ctx,
              env: {
                ...ctx.env,
                npm_lifecycle_event: scriptName,
                npm_package_name: pkg.name || '',
              },
            }, { longRunning: longRunningComposite });
          }

          // Parse script into command + args (single-command fast path).
          const scriptParts = scriptTrim.split(/\s+/);
          const cmdName = scriptParts[0];
          const cmdArgs = scriptParts.slice(1);
          // Try to resolve via registry — same path as direct terminal input
          const resolved = await registry.resolve(cmdName);
          if (resolved) {
            // Call with the SAME ctx (stdout wired to terminal)
            return await resolved({
              ...ctx,
              args: cmdArgs,
              env: { ...ctx.env, npm_lifecycle_event: scriptName, npm_package_name: pkg.name || '' },
            });
          }

          // ── Fix 1: deterministic "unsupported command" hint ────────────
          // A command not registered in the shell (and therefore about to
          // fall through to `shell.execute`, whose "command not found"
          // message silently vanishes into a buffered string) typically
          // means one of:
          //   a) The project expects a tool like `wrangler` that Nimbus
          //      skips during `npm install` (see SKIP_PACKAGES in
          //      src/npm-resolver.ts). There may be a `.bin` shim if the
          //      user installed it manually, but it tries to spawn workerd
          //      via `child_process.spawn` which isn't available in a DO
          //      isolate. Running it just hangs or crashes silently.
          //   b) The project uses a genuinely unknown command. Surface
          //      that too so the user sees SOMETHING rather than a silent
          //      prompt.
          const projDirForBin = (ctx.cwd || '/home/user').replace(/^\/+/, '');
          const binShimPath = projDirForBin + '/node_modules/.bin/' + cmdName;
          const hasBinShim = sqliteFs.exists(binShimPath);
          const unsupported = NIMBUS_UNSUPPORTED_BINS[cmdName];
          if (unsupported) {
            ctx.stderr.write(
              '\x1b[31m\u2718\x1b[0m \x1b[1m' + cmdName + '\x1b[0m is not supported inside Nimbus.\n' +
              '  ' + unsupported.reason + '\n' +
              (unsupported.alternative
                ? '  \x1b[2mTry:\x1b[0m \x1b[36m' + unsupported.alternative + '\x1b[0m\n'
                : '') +
              (hasBinShim
                ? '  \x1b[2m(Found node_modules/.bin/' + cmdName + ' — it installed, but it cannot run here.)\x1b[0m\n'
                : '')
            );
            return 127;
          }
          // Known POSIX shell builtins are handled by shell.execute, not
          // by Nimbus's command registry or by node_modules/.bin shims.
          // A single-command script like `cd target-dir` (degenerate but
          // occasionally seen) or `true` / `:` (exit-0 no-op placeholders)
          // would otherwise trip the "command not found" branch below
          // with a misleading "not a built-in Nimbus command" message.
          // Route them through shellExecuteTracked so the shell's own
          // builtin handler runs.
          const SHELL_BUILTINS = new Set([
            'cd', 'export', 'unset', 'set', 'source', '.', 'alias',
            'unalias', 'eval', 'exec', 'exit', 'return', 'shift',
            'pwd', 'read', 'true', 'false', ':', 'test', '[',
          ]);
          if (SHELL_BUILTINS.has(cmdName)) {
            const longRunningBuiltin =
              scriptName === 'dev' || scriptName === 'start' ||
              scriptName === 'serve' || scriptName === 'watch';
            return await shellExecuteTracked(scriptTrim, {
              ...ctx,
              env: {
                ...ctx.env,
                npm_lifecycle_event: scriptName,
                npm_package_name: pkg.name || '',
              },
            }, { longRunning: longRunningBuiltin });
          }
          if (!hasBinShim) {
            // Command not registered, no bin shim, not a shell builtin.
            // Tell the user explicitly.
            ctx.stderr.write(
              '\x1b[31m\u2718\x1b[0m \x1b[1m' + cmdName + ': command not found\x1b[0m\n' +
              '  Script "' + scriptName + '" wants to run: \x1b[36m' + script + '\x1b[0m\n' +
              '  "' + cmdName + '" is not a built-in Nimbus command and no\n' +
              '  \x1b[2mnode_modules/.bin/' + cmdName + '\x1b[0m shim was found.\n' +
              '  Check your package.json scripts or install the missing package.\n'
            );
            return 127;
          }

          // Has a .bin shim (shell.execute would try to exec it via the
          // PATH-lookup in @lifo-sh/core). Route through shellExecuteTracked
          // so stdout/stderr land in the terminal AND the ring buffer, AND
          // the process shows up in `ps`/`logs` for post-mortem. Long-
          // running flag is set for dev/start scripts so the banner reads
          // "started (long-running)" and exit dumps always fire (Fix 4).
          const longRunning = scriptName === 'dev' || scriptName === 'start' ||
                              scriptName === 'serve' || scriptName === 'watch';
          return await shellExecuteTracked(script, {
            ...ctx,
            env: { ...ctx.env, npm_lifecycle_event: scriptName, npm_package_name: pkg.name || '' },
          }, { longRunning });
        } catch (e: any) {
          ctx.stderr.write(`npm ERR! ${e?.message || e}\n`);
          return 1;
        }
      }

      // npm ls — list installed packages
      if (sub === 'ls' || sub === 'list') {
        const pkgPath = (ctx.cwd || '/home/user').replace(/^\/+/, '') + '/package.json';
        const nmDir = (ctx.cwd || '/home/user').replace(/^\/+/, '') + '/node_modules';
        try {
          const pkg = JSON.parse(sqliteFs.readFileString(pkgPath));
          ctx.stdout.write(`${pkg.name || 'project'}@${pkg.version || '1.0.0'} ${ctx.cwd}\n`);
          const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
          const names = Object.keys(deps);
          for (let i = 0; i < names.length; i++) {
            const isLast = i === names.length - 1;
            const prefix = isLast ? '└── ' : '├── ';
            const name = names[i];
            let version = deps[name];
            // Try to read actual installed version
            try {
              const installed = JSON.parse(sqliteFs.readFileString(nmDir + '/' + name + '/package.json'));
              version = installed.version;
            } catch {}
            ctx.stdout.write(`${prefix}${name}@${version}\n`);
          }
        } catch { ctx.stderr.write('npm ERR! no package.json found\n'); return 1; }
        return 0;
      }

      // npm init / npm init -y
      if (sub === 'init') {
        const cwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');
        const pkgPath = cwd + '/package.json';
        if (sqliteFs.exists(pkgPath) && !args.includes('-y') && !args.includes('--yes')) {
          ctx.stderr.write('package.json already exists. Use -y to overwrite.\n');
          return 1;
        }
        const name = cwd.split('/').pop() || 'project';
        const pkg = {
          name, version: '1.0.0', description: '', main: 'index.js',
          type: 'module',
          scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview', test: 'echo "no test"' },
          keywords: [], author: '', license: 'MIT', dependencies: {}, devDependencies: {},
        };
        sqliteFs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
        ctx.stdout.write('Wrote to ' + pkgPath + '\n');
        return 0;
      }

      // npm uninstall <pkg>
      if (sub === 'uninstall' || sub === 'un' || sub === 'remove' || sub === 'rm') {
        const packages = args.slice(1).filter(a => !a.startsWith('-'));
        if (packages.length === 0) { ctx.stderr.write('Usage: npm uninstall <pkg>\n'); return 1; }
        const cwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');
        const nmDir = cwd + '/node_modules';
        for (const pkg of packages) {
          const pkgDir = nmDir + '/' + pkg;
          // Recursively delete package directory
          const deleteRecursive = (dir: string) => {
            try {
              for (const e of sqliteFs.readdir(dir)) {
                const fp = dir + '/' + e.name;
                if (e.type === 'directory') deleteRecursive(fp);
                else try { sqliteFs.unlink(fp); } catch {}
              }
              try { sqliteFs.rmdir(dir); } catch {}
            } catch {}
          };
          deleteRecursive(pkgDir);
          ctx.stdout.write('removed ' + pkg + '\n');
        }
        // Update package.json
        const pkgPath = cwd + '/package.json';
        try {
          const pkgJson = JSON.parse(sqliteFs.readFileString(pkgPath));
          for (const pkg of packages) {
            delete pkgJson.dependencies?.[pkg];
            delete pkgJson.devDependencies?.[pkg];
          }
          sqliteFs.writeFile(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n');
        } catch {}
        return 0;
      }

      // npm install (no args or with packages) — use NpmInstaller v2 (batched writes)
      if (sub === 'install' || sub === 'i' || sub === 'add') {
        const explicitPkgs = args.slice(1).filter((a: string) => !a.startsWith('-'));
        self.ensureSqliteFs();
        const installCwd = (ctx.cwd || '/home/user').replace(/^\/+/, '');

        // Ensure package.json exists for bare `npm install`
        if (explicitPkgs.length === 0) {
          const pkgJsonPath = installCwd + '/package.json';
          if (!sqliteFs.exists(pkgJsonPath)) {
            ctx.stderr.write('npm ERR! no package.json found\n');
            return 1;
          }
        }

        const pkgLabel = explicitPkgs.length > 0
          ? `${explicitPkgs.length} packages`
          : 'dependencies from package.json';
        ctx.stdout.write(`\x1b[36mInstalling ${pkgLabel} (npm v2 — batched writes)...\x1b[0m\n`);

        self.ensureNpmInstaller((msg: string) => {
          ctx.stdout.write('[npm] ' + msg + '\n');
        });

        try {
          const result = await self.npmInstaller!.install(installCwd, {
            packages: explicitPkgs.length > 0 ? explicitPkgs : undefined,
          });

          if (result.failed?.length > 0) {
            ctx.stderr.write('\x1b[31mFailed: ' + result.failed.join(', ') + '\x1b[0m\n');
          }
          // [HONEST INSTALL MESSAGE P0a] Yellow + "(N failed, see above)"
          // when partial. Green only when failed.length === 0.
          const partial = (result.failed?.length || 0) > 0;
          const color = partial ? '\x1b[33m' : '\x1b[32m';
          const suffix = partial ? ` (${result.failed!.length} failed, see above)` : '';
          ctx.stdout.write(
            `\n${color}added ${result.installed?.length || 0} packages (${result.totalFiles || 0} files) in ${((result.elapsed || 0) / 1000).toFixed(1)}s${suffix}\x1b[0m\n`
          );
          if (result.cachedHits > 0) {
            ctx.stdout.write(`\x1b[2m  (${result.cachedHits} from cache)\x1b[0m\n`);
          }
          return result.failed?.length > 0 ? 1 : 0;
        } catch (e: any) {
          ctx.stderr.write(`\x1b[31mnpm install failed: ${e?.message}\x1b[0m\n`);
          return 1;
        }
      }

      // Fall through to core npm for other subcommands
      return coreNpmCmd(ctx);
    });
    // npx: check node_modules/.bin first, then built-in commands, then fallback to core
    const coreNpxCmd = createNpxCommand(registry, shellExecute);
    registry.register('npx', async (ctx: any) => {
      const npxArgs: string[] = ctx.args || [];
      const cmd = npxArgs[0];
      if (!cmd) { ctx.stderr.write('Usage: npx <command> [args...]\n'); return 1; }

      // Check if it's a built-in command (vite, esbuild, etc.)
      const resolved = await registry.resolve(cmd);
      if (resolved) {
        return await resolved({ ...ctx, args: npxArgs.slice(1) });
      }

      // Fall through to core npx
      return coreNpxCmd(ctx);
    });

    // ── Register process commands (enhanced with facet process tracking) ──
    registry.register('ps', async (ctx: any) => {
      ctx.stdout.write('  PID  STATUS              COMMAND\n');
      for (const proc of self.processTable.getAll()) {
        // Prefer log-store exit info over ProcessTable's: the store has
        // the authoritative code and survives reap. For `running`, rely
        // on ProcessTable (store has no "running" concept).
        let status: string;
        if (proc.state === 'running') {
          status = '\x1b[32mrunning\x1b[0m';
        } else if (proc.state === 'killed') {
          status = `\x1b[33mkilled(${proc.exitCode ?? 137})\x1b[0m`;
        } else {
          // 'exited' — distinguish clean vs crashed.
          const code = proc.exitCode ?? 0;
          status = code === 0
            ? `\x1b[2mexited(0)\x1b[0m`
            : `\x1b[31mcrashed(${code})\x1b[0m`;
        }
        ctx.stdout.write(`  ${String(proc.pid).padStart(3)}  ${status.padEnd(26)}  ${proc.command}\n`);
      }
      // Show vite dev server
      if (self.viteDevServer?.isRunning) {
        ctx.stdout.write('  \x1b[33m---\x1b[0m  \x1b[32mrunning\x1b[0m                     vite dev server (' + self.viteBasePath + '/)\n');
      }
      if (self.processTable.getAll().length === 0 && !self.viteDevServer?.isRunning) {
        ctx.stdout.write('  (no processes)\n');
      }
      return 0;
    });

    // ── `logs <pid>` — tail per-process ring buffer ──
    // Flags:
    //   -f / --follow     stream new chunks until the process exits
    //   -n / --lines N    number of lines from the tail (default 200)
    //   --bytes N         max bytes from the tail (overrides --lines)
    //   --plain           strip ANSI escapes on output (keeps buffer raw)
    registry.register('logs', async (ctx: any) => {
      const args: string[] = ctx.args || [];
      const follow = args.includes('-f') || args.includes('--follow');
      const plain = args.includes('--plain');

      let lines = 200;
      let bytes: number | undefined;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if ((a === '-n' || a === '--lines') && args[i + 1]) {
          const n = parseInt(args[i + 1], 10);
          if (!isNaN(n) && n > 0) lines = n;
          i++;
        } else if (a === '--bytes' && args[i + 1]) {
          const n = parseInt(args[i + 1], 10);
          if (!isNaN(n) && n > 0) bytes = n;
          i++;
        }
      }

      const pidArg = args.find(a => /^\d+$/.test(a));
      if (!pidArg) {
        ctx.stderr.write('usage: logs [-f] [-n LINES | --bytes N] [--plain] <pid>\n');
        return 1;
      }
      const pid = parseInt(pidArg, 10);

      if (!self.processLogs.has(pid)) {
        ctx.stderr.write(`no logs for pid ${pid}\n`);
        return 1;
      }

      // Paint a single chunk for live-stream (follow-mode) rendering.
      // `--plain` strips ANSI per chunk — safe for live output because
      // individual streamed chunks from the RPC layer never split an
      // escape sequence (the RPC boundary always delivers a complete
      // write call). Backfill is different (see below).
      const renderChunk = (c: LogChunk) => {
        let data = c.data;
        if (plain) data = stripAnsi(data);
        if (c.stream === 'stderr' && !plain) {
          return `\x1b[31m${data}\x1b[0m`;
        }
        return data;
      };

      // Backfill. Concatenate same-stream consecutive chunks BEFORE
      // stripping so that any ANSI escape split across chunk boundaries
      // (by the 4 KB splitter inside ProcessLogStore) gets rejoined and
      // stripped cleanly instead of leaking `1m` / `[31m` fragments.
      const tailOpts = bytes !== undefined ? { bytes } : { lines };
      const chunks = self.processLogs.tail(pid, tailOpts);
      let group: LogChunk[] = [];
      const flushGroup = () => {
        if (group.length === 0) return;
        const stream = group[0].stream;
        let data = group.map(c => c.data).join('');
        if (plain) data = stripAnsi(data);
        if (stream === 'stderr' && !plain) {
          ctx.stdout.write(`\x1b[31m${data}\x1b[0m`);
        } else {
          ctx.stdout.write(data);
        }
        group = [];
      };
      for (const c of chunks) {
        if (group.length > 0 && group[group.length - 1].stream !== c.stream) {
          flushGroup();
        }
        group.push(c);
      }
      flushGroup();

      if (!follow) {
        // Footer only when process has exited already.
        const exit = self.processLogs.getExit(pid);
        if (exit) {
          ctx.stdout.write(
            `\r\n\x1b[2m[process exited with code ${exit.code}${
              exit.reason ? ` (${exit.reason})` : ''
            }]\x1b[0m\r\n`,
          );
        }
        return 0;
      }

      // Follow mode: subscribe to live appends, poll for exit.
      const entry = self.processTable.get(pid);
      const alreadyExited =
        !entry || entry.state !== 'running' || self.processLogs.getExit(pid);
      if (alreadyExited) {
        const exit = self.processLogs.getExit(pid);
        if (exit) {
          ctx.stdout.write(
            `\r\n\x1b[2m[process exited with code ${exit.code}${
              exit.reason ? ` (${exit.reason})` : ''
            }]\x1b[0m\r\n`,
          );
        }
        return 0;
      }

      return await new Promise<number>((resolve) => {
        let done = false;
        const finish = (code: number) => {
          if (done) return;
          done = true;
          unsub();
          unsubExit();
          resolve(code);
        };
        const unsub = self.processLogs.subscribe(pid, (c) => {
          ctx.stdout.write(renderChunk(c));
        });
        const unsubExit = self.processLogs.subscribeExit(pid, (exit) => {
          ctx.stdout.write(
            `\r\n\x1b[2m[process exited with code ${exit.code}${
              exit.reason ? ` (${exit.reason})` : ''
            }]\x1b[0m\r\n`,
          );
          finish(0);
        });
        // TOCTOU: the process may have exited between our `alreadyExited`
        // check above and these subscribe calls. Re-check now that the
        // exit subscriber is wired — if exit already set, the subscribe
        // callback never fires, so synthesize the footer ourselves.
        const exitNow = self.processLogs.getExit(pid);
        if (exitNow) {
          ctx.stdout.write(
            `\r\n\x1b[2m[process exited with code ${exitNow.code}${
              exitNow.reason ? ` (${exitNow.reason})` : ''
            }]\x1b[0m\r\n`,
          );
          finish(0);
          return;
        }
        // If ctx exposes an AbortSignal (Ctrl+C wired by the shell),
        // honor it. Otherwise, follow-mode ends only on process exit.
        if (ctx.signal && typeof ctx.signal.addEventListener === 'function') {
          ctx.signal.addEventListener('abort', () => finish(130));
        }
      });
    });

    registry.register('jobs', async (ctx: any) => {
      const running = self.processTable.getRunning();
      if (running.length === 0 && !self.viteDevServer?.isRunning) {
        ctx.stdout.write('No background jobs.\n');
        return 0;
      }
      for (let i = 0; i < running.length; i++) {
        ctx.stdout.write(`[${i + 1}]  Running    ${running[i].command} (pid ${running[i].pid})\n`);
      }
      if (self.viteDevServer?.isRunning) {
        ctx.stdout.write(`[${running.length + 1}]  Running    vite dev server\n`);
      }
      return 0;
    });

    registry.register('kill', async (ctx: any) => {
      const pidArg = ctx.args[0];
      if (!pidArg) { ctx.stderr.write('Usage: kill <pid>\n'); return 1; }
      const pid = parseInt(pidArg);
      if (isNaN(pid)) { ctx.stderr.write('kill: invalid pid\n'); return 1; }

      // Primitives wave (P11): if the target is the vite shim PID
      // (registered by P5's long-running spawn), tear down the
      // in-process viteDevServer / cirrusReal too — facetManager.kill
      // only handles real Worker-Loader facets, and would leave the
      // shim running with its port registered against a dead PID.
      if (self._viteShimPid === pid) {
        try {
          if (self.cirrusReal?.isRunning) {
            self.cirrusReal.stop(self.ctx);
            self.cirrusReal = null;
          }
          if (self.viteDevServer?.isRunning) {
            self.viteDevServer.stop();
            self.viteDevServer = null;
            try { await self.ctx.storage.delete('vite-config'); } catch {}
          }
        } catch (e: any) {
          ctx.stderr.write('kill: while stopping vite shim: ' + (e?.message || e) + '\n');
        }
        try { self.portRegistry.unregisterByPid(pid); } catch {}
        try { self.processTable.kill(pid); } catch {}
        notifyTerminalEvent(self.terminal, {
          type: 'exit', pid, code: 137, command: 'vite',
        });
        self._viteShimPid = null;
        self._viteShimPort = null;
        ctx.stdout.write(`Process ${pid} killed.\n`);
        return 0;
      }

      if (self.facetManager?.kill(pid)) {
        ctx.stdout.write(`Process ${pid} killed.\n`);
        return 0;
      }
      ctx.stderr.write(`kill: no such process: ${pid}\n`);
      return 1;
    });

    registry.register('top', createTopCommand(processRegistry));
    registry.register('watch', createWatchCommand(registry));
    registry.register('help', createHelpCommand(registry));

    // ── Rehydrate globally-installed npm packages ──
    try {
      rehydrateGlobalPackages(self.kernel.vfs, registry);
    } catch {}

    // ── Phase O: one-shot online output [B'.1] ─────────────────────────
    //
    // Only emit cold-start UI (MOTD, starter-app hint, framework-detect)
    // when this initSession is actually a cold start. A silent re-init —
    // the same DO instance reaccepting a /ws upgrade after wsClose —
    // skips this block entirely. The user sees their persisted shell
    // (cwd preserved, env preserved) without a banner reprint that would
    // make the recovery look like a reset.
    //
    // The cold-vs-rehydrate discriminator is `persisted.hasPersistedState`
    // — true iff at least one nimbus_session_kv row was found at Phase R.
    // A truly cold DO (or one whose session-state was explicitly cleared
    // via /api/_test/session/reset) reads zero rows and falls through to
    // the cold-start path below.
    // [B'.4] Phase boundary: Build complete, transition to either
    // Online (cold start) or hydrated (warm re-init). Phase O runs
    // only on cold start; warm sessions skip the MOTD block and go
    // directly to hydrated.
    if (!persisted.hasPersistedState) {
      setPhase(self, 'online', 'init-session');
      // ── Show MOTD ──
      try {
        const motd = self.sqliteFs!.readFileString('etc/motd');
        self.terminal.write(motd + '\r\n');
      } catch {}

      // ── Starter-app hint (only if seed sentinel still exists) ──
      // We check the live VFS, not a static file, so that if the user
      // deletes ~/.nimbus-seeded (or ~/app) the hint stops appearing on
      // next login.
      try {
        if (hasSeededProject(self.sqliteFs!) && self.sqliteFs!.exists(SEED_PROJECT_DIR)) {
          self.terminal.write(
            '\x1b[2mStarter app ready at \x1b[36m~/app\x1b[0m\x1b[2m — try:\x1b[0m\r\n' +
            '  \x1b[36mcd app && npm install && npm run dev\x1b[0m\r\n\r\n'
          );
        }
      } catch {}

      // ── W11: framework detection MOTD line ──
      // If ~/app has a recognizable framework, print one informational line.
      // Purely advisory — does not change boot behaviour. Fire-and-forget
      // because initSession is sync; any failure is silently swallowed.
      void (async () => {
        try {
          const projDir = SEED_PROJECT_DIR;
          const pkgPath = projDir + '/package.json';
          if (!self.sqliteFs!.exists(pkgPath)) return;
          const pkg = JSON.parse(self.sqliteFs!.readFileString(pkgPath));
          const files = new Set<string>();
          try {
            for (const e of self.sqliteFs!.readdir(projDir)) files.add(e.name);
          } catch {}
          const fileContents: Record<string, string> = {};
          for (const c of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
            if (files.has(c)) {
              try { fileContents[c] = self.sqliteFs!.readFileString(projDir + '/' + c); } catch {}
            }
          }
          const { detectFramework, describeDetect } = await import('../runtime/framework-detect.js');
          const result = detectFramework({
            pkg: { dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, scripts: pkg.scripts },
            files,
            fileContents,
          });
          if (result.framework !== 'unknown' && result.framework !== 'vite' && self.terminal) {
            self.terminal.write(
              '\x1b[2m[nimbus]\x1b[0m \x1b[36m' + describeDetect(result) + '\x1b[0m\r\n\r\n'
            );
          }
        } catch { /* MOTD line is non-critical */ }
      })();
    }

    // ── Phase O cont.: record the lifecycle transition [B'.1] ──────────
    //
    // C'.2 recovery_event ring entry — every initSession call records
    // either a cold→hydrated (first connect) or drained→hydrated
    // (silent re-init) transition. The probe at audit/probes/
    // interactive-liveness/error-recovery/ asserts both states show
    // dataLoss=false. Track B' guarantees this for in-isolate transitions;
    // a true cold-isolate boot reads no SQL row and shows
    // snapshotKeysRehydrated=0 (still dataLoss=false because there was
    // no state to lose).
    //
    // [B'.4] We also set the live phase indicator to 'hydrated' here.
    // For cold starts, the prior phase was 'online' (Phase O ran);
    // for warm re-inits, the prior phase was 'build' (Phase O
    // skipped). Setting to 'hydrated' is the terminal init phase
    // both paths end on.
    {
      const fromState = persisted.hasPersistedState ? 'drained' : 'cold';
      const snapshotKeys = countSessionStateKeys(self.ctx);
      try {
        recordRecoveryEvent({
          at: Date.now(),
          fromState: fromState as any,
          toState: 'hydrated',
          trigger: 'init-session',
          isolateGen: self._w9IsolateGen,
          dataLoss: false,
          snapshotKeysRehydrated: snapshotKeys,
        });
      } catch { /* observability is non-critical */ }
      // [B'.4] Update live phase. setPhase records its own transition
      // recovery_event; this one is the legacy/coarse marker that
      // C'.3 + B'.1 probes look for.
      self._b4Phase = 'hydrated';
      // Stamp hydrated_at for the /api/_diag/session debug endpoint.
      try {
        stampHydratedAt(self.ctx, Date.now());
      } catch { /* non-critical */ }
    }

    // ── Start shell ──
    self.shell.start();

    (async () => {
      try { await self.shell!.sourceFile('/etc/profile'); } catch {}
      try { await self.shell!.sourceFile('/home/user/.nimbusrc'); } catch {}
    })();

    ws.send(JSON.stringify({ type: 'ready' }));
}
