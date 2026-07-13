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
 * `self` is typed as InitHost, a narrow view of SessionInternal plus readonly
 * ctx/env, so this module can use the session internals it owns without
 * depending on the full Durable Object class surface.
 *
 * Imports and class delegators on NimbusSession preserve back-compat:
 *   - acceptShellWebSocket → self.initSession(ws)  (S7 will extract).
 *   - The class still has `initSession(ws)` as a delegator method.
 */

import {
  Kernel, Shell, createDefaultRegistry, ProcessRegistry,
  MemoryPersistenceBackend, createCurlCommand, createNpmCommand,
  NPM_VERSION, createTopCommand, createWatchCommand, createHelpCommand,
  rehydrateGlobalPackages,
} from '../substrate/lifo/index.js';
import { createKillCommand } from '../substrate/lifo/commands/system/kill.js';
import { SqliteVFSProvider } from '../vfs/sqlite-vfs.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import { DevProvider } from '../vfs/dev-provider.js';
import { WebSocketTerminal } from '../facets/ws-terminal.js';
import { EsbuildService } from '../runtime/esbuild-service.js';
import { runNodeScript } from '../runtime/node-runner.js';
import { runBunScript, BUN_VERSION } from '../runtime/bun-runner.js';
import { buildRuntimeHandler, type RuntimeSpec } from '../runtime/runtime-registry.js';
import { parseViteConfigSource, type ParsedViteConfig } from '../runtime/vite-config-parser.js';
import { rewriteCirrusViteConfigBundle } from '../runtime/cirrus-vite-config-rewriter.js';
import { findHtmlScriptEntrypoint, rewriteViteBuildHtml } from '../runtime/html-entrypoint.js';
import { normalizeVfsPath, parentVfsPath, resolveVfsPath, stripLeadingSlashes } from '../vfs/path.js';
import {
  makeWasmRunner,
  WASM_RUNNER_VERSION,
  WASM_RUNNER_HELP,
  formatWasmRunnerWasiInfo,
} from '../runtime/wasm-runner.js';
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
  detectUnsupportedWranglerConfig,
} from './helpers.js';
import { HeredocHandler, LineEditorExtender } from '../shell/features.js';
import { registerUnixCommands } from '../shell/unix-commands.js';
import { registerShellEntrypointCommands, type ShellEntrypointExecutor } from '../shell/shell-entrypoints.js';
import { installNpmBinFallbackResolver } from '../shell/npm-bin-entrypoints.js';
import { parseNpmInstallInvocation } from '../npm/install-args.js';
import { materializeNpmBinShims } from '../npm/bin-links.js';
import { registerGitCommands } from '../git/commands.js';
import {
  makeNimbusVerbHandler,
  createRuntimeCommandHintResolver,
  rehydrateInstalledRuntimes,
  registerRunnerFactory,
} from '../runtime/package-manager.js';
import { makeClangRunnerFactory } from '../runtime/clang-runner.js';
import { makePythonRunnerFactory } from '../runtime/python-runner.js';
import { makeRubyRunnerFactory } from '../runtime/ruby-runner.js';
import { seedProject, hasSeededProject, SEED_PROJECT_DIR } from '../vfs/seed-project.js';
import { notifyTerminalEvent } from '../runtime/process-logs-api.js';
import { stripAnsi, type LogChunk } from '../runtime/process-logs.js';
import {
  NIMBUS_VERSION, DEFAULT_HOSTNAME, DEFAULT_MOUNT_POINTS, CF_COMPAT_DATE,
  NODE_VERSION, DEFAULT_PATH,
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
 * The pragmatic shape for THIS module: extend SessionInternal with
 * `ctx`/`env` as `any` and have the class delegator cast `this as
 * unknown as InitHost`. Other sibling modules (-rpc, -ws, -hib,
 * -replica) DO take ctx as a separate explicit arg per D1 — initSession
 * can't because the body has too many call sites to thread through.
 */
type InitHost = SessionInternal & { readonly ctx: any; readonly env: any };

function resolveNpmPrefix(prefix: string, cwd: string): string {
  return prefix.startsWith('/')
    ? normalizeVfsPath(prefix)
    : resolveVfsPath(prefix, cwd || '/home/user');
}


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
      self.kernel.vfs.mount('/' + mp, provider as any);
    }
    // Persist the mount-tree. Today this writes the same
    // DEFAULT_MOUNT_POINTS list every initSession (idempotent — the
    // table just keeps the same 7 rows). Future custom mounts will
    // flow through the same code path.
    try { persistKernelMounts(self.ctx, mountPoints); } catch { /* fail-soft */ }

    // shell compatibility (2026-05-11): mount a virtual /dev provider.
    // Pre-fix `cmd > /dev/null` and `cmd 2>/dev/null` errored with
    // `ENOENT: '/dev': no such file or directory`. This provider
    // synthesizes /dev/null, /dev/zero, /dev/random, /dev/urandom,
    // /dev/full, /dev/{stdin,stdout,stderr,tty}. Read/write surface
    // matches MountProvider so the redirect machinery sees
    // valid targets. Not persisted — recreated fresh each init.
    try {
      self.kernel.vfs.mount('/dev', new DevProvider() as any);
    } catch (e: any) {
      console.error('[init] /dev mount failed:', e?.message || e);
    }

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

    // ── editor/monaco (2026-05-13): editor-pane fs bridge ──
    //
    // The terminal hosts the WS that the editor pane reuses for
    // fs-read / fs-write / fs-list messages. We install the handler
    // here because this is the first point in init where sqliteFs is
    // in scope; the terminal stays a stable instance across warm
    // rejoins (attach() swaps ws ref), so installing once is enough.
    //
    // Protocol (all replies are paired `<type>-result` frames):
    //   IN  { type:'fs-read',  path }
    //   OUT { type:'fs-read-result',  path, content?, error?, binary? }
    //   IN  { type:'fs-write', path, content }
    //   OUT { type:'fs-write-result', path, ok, error? }
    //   IN  { type:'fs-list',  dir, recursive? }
    //   OUT { type:'fs-list-result',  dir, entries:[{path,type}], error? }
    //
    // Binary refuse: fs-read uses readFile(bytes) + fatal:true UTF-8
    // decode. Throws on invalid bytes → reply { binary:true } with no
    // content. The editor pane shows a friendly placeholder; this is
    // the same heuristic hardening-r5 already uses for VFS<->facet
    // serialization (see manager.ts _readBundleCell).
    //
    self.terminal.onFs((msg: any, reply: (frame: any) => void) => {
      try {
        if (msg.type === 'fs-read') {
          const p = stripLeadingSlashes(String(msg.path || ''));
          if (!sqliteFs.exists(p)) {
            reply({ type: 'fs-read-result', path: msg.path, error: 'ENOENT: no such file or directory' });
            return;
          }
          if (sqliteFs.isDirectory(p)) {
            reply({ type: 'fs-read-result', path: msg.path, error: 'EISDIR: is a directory' });
            return;
          }
          // Read bytes; attempt strict UTF-8 decode. Non-UTF-8 → mark
          // binary so the editor shows a friendly placeholder rather
          // than mojibake.
          const bytes = sqliteFs.readFile(p);
          try {
            const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            reply({ type: 'fs-read-result', path: msg.path, content });
          } catch {
            reply({
              type: 'fs-read-result',
              path: msg.path,
              binary: true,
              error: 'binary file (non-UTF-8) — editor cannot display',
            });
          }
          return;
        }
        if (msg.type === 'fs-write') {
          const p = stripLeadingSlashes(String(msg.path || ''));
          if (!p) {
            reply({ type: 'fs-write-result', path: msg.path, ok: false, error: 'empty path' });
            return;
          }
          const parent = parentVfsPath(p);
          if (parent) try { sqliteFs.mkdir(parent, { recursive: true }); } catch {}
          const content = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
          sqliteFs.writeFile(p, content);
          reply({ type: 'fs-write-result', path: msg.path, ok: true });
          return;
        }
        if (msg.type === 'fs-list') {
          const dir = stripLeadingSlashes(String(msg.dir || ''));
          const recursive = msg.recursive === true;
          if (dir && !sqliteFs.exists(dir)) {
            reply({ type: 'fs-list-result', dir: msg.dir, entries: [], error: 'ENOENT' });
            return;
          }
          if (dir && !sqliteFs.isDirectory(dir)) {
            reply({ type: 'fs-list-result', dir: msg.dir, entries: [], error: 'ENOTDIR' });
            return;
          }
          // BFS walk with per-call cap so a 10k-file project doesn't
          // ship a megabyte JSON frame. 2000 entries is well above
          // typical project sizes (vite scaffold = ~30 files; even
          // node_modules tree of a 50-dep project under 2000).
          const MAX_ENTRIES = 2000;
          const out: { path: string; type: string }[] = [];
          const queue: string[] = [dir];
          while (queue.length > 0 && out.length < MAX_ENTRIES) {
            const cur = queue.shift()!;
            let entries: { name: string; type: string }[];
            try { entries = sqliteFs.readdir(cur); } catch { continue; }
            for (const e of entries) {
              if (out.length >= MAX_ENTRIES) break;
              if (e.name === 'node_modules' || e.name === '.git') continue;  // skip noisy
              const child = cur ? cur + '/' + e.name : e.name;
              out.push({ path: '/' + child, type: e.type });
              if (recursive && e.type === 'directory') queue.push(child);
            }
          }
          reply({
            type: 'fs-list-result',
            dir: msg.dir,
            entries: out,
            truncated: out.length >= MAX_ENTRIES,
          });
          return;
        }
        reply({ type: msg.type + '-result', ok: false, error: 'unknown fs message type' });
      } catch (e: any) {
        reply({
          type: msg.type + '-result',
          path: msg.path,
          dir: msg.dir,
          ok: false,
          error: (e?.message || String(e)),
        });
      }
    });

    // ── runtime package manager v1.1: ./<wasm-binary> shell-side dispatch ──
    // When the user invokes `./hello` (or any `./X` / `/abs/X`)
    // shell-form path and the file:
    //   (a) exists in SqliteFS at that relative-to-cwd path, AND
    //   (b) starts with the wasm magic bytes `\0asm\1\0\0\0`
    // we route the invocation to the wasm-runner command with the
    // user's args. This is how `clang t.c -o hello && ./hello`
    // closes the runtime substrate demo: the linker emits a wasm executable,
    // and the shell knows to run it via the WASI shim.
    //
    // Implementation: monkey-patch registry.resolve. If the standard
    // name lookup misses AND the name has a `/` (path-shaped), we
    // attempt the wasm-magic check; on hit, return a synthetic
    // Command that invokes wasm-runner.
    const __origResolve = registry.resolve.bind(registry);
    (registry as any).resolve = async (name: string): Promise<any> => {
      const found = await __origResolve(name);
      if (found) return found;
      // Only `./X`, `/abs/X`, `../X` are path-shaped invocations.
      // Bare-word "X" must come from the registered set.
      if (!name || (!name.startsWith('./') && !name.startsWith('/') && !name.startsWith('../'))) {
        return undefined;
      }
      // Resolve the path-shape against cwd. cwd is read at every
      // resolve call (not cached) so `cd` between invocations is
      // honoured. The wasm-bytes existence check is also live —
      // recompile produces fresh bytes; we always re-check the
      // magic on the latest VFS state.
      const cwdN = normalizeVfsPath((self.shell && (self.shell as any).getCwd?.()) || '/home/user');
      const resolved = resolveVfsPath(name, cwdN);
      if (!sqliteFs.exists(resolved) || sqliteFs.isDirectory(resolved)) {
        return undefined;
      }
      // Read first 4 bytes; check for the wasm magic `\0asm`.
      let bytes: Uint8Array;
      try { bytes = sqliteFs.readFile(resolved); } catch { return undefined; }
      const isWasm = bytes.length >= 4
        && bytes[0] === 0x00 && bytes[1] === 0x61
        && bytes[2] === 0x73 && bytes[3] === 0x6d;
      if (!isWasm) return undefined;
      // Build a synthetic command that delegates to wasm-runner with
      // the user's args. wasm-runner's contract: args[0] is the .wasm
      // path (resolved against ctx.cwd by the runtime-handler),
      // args[1..] are forwarded as WASI argv.
      //
      // We pass the BASENAME (not "./hello") because:
      //   1. The runtime-handler joins ctx.cwd + args[0] without
      //      normalising "./" segments, producing "/home/user/./hello"
      //      which the supervisor's SqliteFS doesn't recognise.
      //   2. The basename keeps the resolved path canonical
      //      (cwd + "hello" → "home/user/hello").
      const wasmRunnerCmd: any = await __origResolve('wasm-runner');
      if (!wasmRunnerCmd) return undefined;
      // Compute basename from the original name. For "./hello"
      // → "hello"; for "/abs/path/X" → "X"; for "../foo/X" → "X".
      const nameBasename = name.split('/').pop() || name;
      return async (ctx: any): Promise<number> => {
        const userArgs: string[] = ctx.args || [];
        // The wasm-runner resolves against ctx.cwd. To preserve the
        // original invocation directory (which may differ from cwd
        // at resolve-time if cd happened during dispatch), pass an
        // absolute path computed at resolve-time.
        const absPath = '/' + resolved;
        const newCtx = { ...ctx, args: [absPath, ...userArgs] };
        // Discard nameBasename — kept here only because tooling may
        // log argv[0]; the wasm-runner shell-handler decides the
        // WASI argv[0] based on the resolved filename. See
        // src/runtime/wasm-runner.ts:363 (progName).
        void nameBasename;
        return await wasmRunnerCmd(newCtx);
      };
    };
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

    // ── runtime package manager: `nimbus install` package manager + runner registry.
    //
    // 1. Register the clang-runner factory FIRST so the rehydration step
    //    below can re-bind `clang` / `wasm-ld` from an already-installed
    //    manifest.
    // 2. Register the `nimbus` shell verb (install/uninstall/list/available).
    // 3. Rehydrate any previously-installed runtimes from VFS so their
    //    bins reappear in the registry after DO eviction or WS reconnect.
    registerRunnerFactory('clang-runner', makeClangRunnerFactory({
      facetMgr,
      vfs: sqliteFs,
    }));
    // Pyodide v1 — Python 3.13 via the same R2-package-manager
    // substrate that ships clang. Manifest entrypoints `python` and
    // `python3` both bind to this factory; the runner ferries
    // pyodide.asm.wasm via LOADER modules-map and pyodide.asm.js +
    // python_stdlib.zip via the loader-pool context channel.
    //
    // REPL-W1: wrap the one-shot factory so `python` with NO args (and
    // no flags that would consume args) drops into an interactive
    // REPL. The wrap is purely additive — args-bearing invocations
    // pass through to the existing handler unchanged.
    {
      const onePython = makePythonRunnerFactory({ facetMgr, vfs: sqliteFs });
      const wrappedPython: typeof onePython = (manifest, installRoot, binName, binKind) => {
        const oneShotHandler = onePython(manifest, installRoot, binName, binKind);
        return async function pythonReplOrOneShot(ctx: any): Promise<number> {
          const argv: string[] = ctx.args || [];
          // No args at all → REPL session. Hand off to runPythonRepl
          // which builds its own NimbusLoaderPool (separate from the
          // one-shot dispatch's pool) and drives a ReplSession.
          if (argv.length === 0 && self.terminal) {
            const { runPythonRepl } = await import('../runtime/python-repl.js');
            return await runPythonRepl({
              facetMgr,
              vfs: sqliteFs,
              terminal: self.terminal,
              installRoot,
              manifest,
              // REPL-R7-1: thread the shell so ReplSession can drain
              // shell.pasteQueue on attach (multi-line WS frames like
              // `python\nexit(7)` would otherwise drop the tail input).
              shell: self.shell,
            });
          }
          // Args present (one-shot mode: -c, script, -m, -). Fall
          // through to the canonical handler.
          return await oneShotHandler(ctx);
        };
      };
      registerRunnerFactory('python-runner', wrappedPython);
    }
    // Ruby v1 — Ruby 3.3.4 via ruby.wasm 2.9.3-2.9.4. Same architecture
    // as python-runner: ruby+stdlib.wasm rides via LOADER modules-map,
    // bootstrap runs at child-facet module-init time, per-call
    // __rubyRun drives rb-eval-string-protect with a wrapper that
    // catches SystemExit. See src/runtime/ruby-runner.ts +
    //
    // REPL Stream A: wrap the one-shot factory so `ruby` with NO args
    // drops into an interactive REPL. The wrap is purely additive —
    // args-bearing invocations pass through to the existing handler.
    try {
      const oneRuby = makeRubyRunnerFactory({ facetMgr, vfs: sqliteFs, registry });
      const wrappedRuby: typeof oneRuby = (manifest, installRoot, binName, binKind) => {
        const oneShotHandler = oneRuby(manifest, installRoot, binName, binKind);
        return async function rubyReplOrOneShot(ctx: any): Promise<number> {
          const argv: string[] = ctx.args || [];
          if (argv.length === 0 && self.terminal) {
            const { runRubyRepl } = await import('../runtime/ruby-repl.js');
            return await runRubyRepl({
              facetMgr,
              vfs: sqliteFs,
              terminal: self.terminal,
              installRoot,
            });
          }
          return await oneShotHandler(ctx);
        };
      };
      registerRunnerFactory('ruby-runner', wrappedRuby);
    } catch (e: any) {
      console.error('[init] ruby-runner registration FAILED:', e?.message || e, e?.stack || '');
    }
    {
      // Cast registry to the minimal package-manager shape. CommandRegistry
      // CommandRegistry has register(name, handler) which matches.
      const pkgRegistry: any = registry;
      const nimbusGetHome = (): string => {
        // Shell env carries HOME; fall back to Nimbus's default home.
        const envHome = (self.shell && (self.shell as any).env && (self.shell as any).env.HOME)
          ? (self.shell as any).env.HOME
          : '/home/user';
        return envHome;
      };
      registry.register(
        'nimbus',
        makeNimbusVerbHandler({
          env: self.env as any,
          vfs: sqliteFs,
          registry: pkgRegistry,
          getHome: nimbusGetHome,
          warmRuntime: async (target, ctx) => {
            if (target.name !== 'python') return;
            ctx.stdout.write('[python] warming runtime...\n');
            const stdout = { write(_s: string) {} };
            const stderrText: string[] = [];
            const stderr = { write: (s: string) => { stderrText.push(String(s)); } };
            const py = await registry.resolve('python');
            if (py) {
              const code = await py({
                ...ctx,
                args: ['-c', 'pass'],
                vfs: (ctx as any).vfs ?? (sqliteFs as any),
                signal: new AbortController().signal,
                stdout,
                stderr,
              });
              if (typeof code === 'number' && code !== 0) {
                throw new Error(stderrText.join('').trim() || `python warm-up exited ${code}`);
              }
            }
            const { warmPythonRepl } = await import('../runtime/python-repl.js');
            await warmPythonRepl({
              facetMgr,
              vfs: sqliteFs,
              installRoot: target.root,
              manifest: target.manifest,
            });
            ctx.stdout.write('[python] ready\n');
          },
        }),
      );
      // Rehydration runs here even though the shell hasn't been built
      // yet — that's fine: it accesses VFS + registry which are both
      // already initialised. Runs O(installed-runtimes); typically 0
      // on a fresh session.
      try {
        const rehydration = rehydrateInstalledRuntimes(sqliteFs, pkgRegistry, nimbusGetHome());
        if (rehydration.count > 0) {
          // Surface to terminal via the standard MOTD-style line so
          // users see what's been auto-rebound. Not an error path.
          self.terminal?.write?.(`\x1b[2m[nimbus] rehydrated ${rehydration.count} runtime bin(s): ${rehydration.bins.join(', ')}\x1b[0m\r\n`);
        }
      } catch { /* fail-soft: rehydration must not block session boot */ }
    }

    // ── node command: facet-based execution ─────────────────────────────
    // Parses args, reads script from VFS, delegates to FacetManager.
    // The facet creates a dynamic worker where new Function() is allowed
    // during module startup.
    // ── node command (runtime registry refactor: refactored to use runtime-registry) ──
    //
    // Behaviour preserved exactly:
    //   - primitive #1 nodeFlagSpan (--version/-v/-h scan only flags
    //     before script path)
    //   - primitive #1 shebang strip
    //   - .ts/.tsx/.jsx esbuild auto-transform
    //   - G4 binSpawn ctx propagation (when the .bin handler set
    //     ctx.__nimbusBinSpawn, runFresh reuses the caller's PID
    //     instead of double-spawning)
    //   - --watch/--inspect/--inspect-brk routing via runNodeScript →
    //     isLongRunningInvocation
    //
    // The registry encodes the shared shape; per-runtime overrides
    // live in the spec object.
    const nodeSpec: RuntimeSpec = {
      name: 'node',
      // CLN-1b: was stale literal 'v20.0.0'; pull from src/constants.ts
      // canonical (src/runtime/node-shims.ts already does the same).
      version: NODE_VERSION,
      helpText:
        'Usage: node [options] [script.js] [arguments]\n' +
        '       node -e "code"\n\n' +
        'Options:\n' +
        '  -e, --eval <code>   Evaluate code\n' +
        '  -v, --version       Print version\n' +
        '  -h, --help          Print help\n' +
        '\nExecution via DO Facets (isolated V8 isolate)',
      run: async (fm, code, opts) => runNodeScript(fm, code, opts as any),
      supportsBinSpawn: true,
    };
    {
      const oneShotNode = buildRuntimeHandler(nodeSpec, {
        vfs: sqliteFs,
        facetMgr,
        getEsbuild: () => {
          if (!self.esbuildService) {
            self.ensureSqliteFs();
            self.esbuildService = new EsbuildService(self.sqliteFs!);
          }
          return self.esbuildService!;
        },
        registry,
      });
      // REPL Stream A: no-args invocation → drop into REPL session.
      registry.register('node', async function nodeReplOrOneShot(ctx: any): Promise<number> {
        const argv: string[] = ctx.args || [];
        if (argv.length === 0 && self.terminal) {
          const { runNodeRepl } = await import('../runtime/node-repl.js');
          return await runNodeRepl({ facetMgr, terminal: self.terminal });
        }
        return await oneShotNode(ctx);
      });
    }

    // ── bun command (runtime registry refactor: refactored to use runtime-registry) ──
    //
    // Behaviour preserved exactly:
    //   - --version / --help
    //   - install / i / add → delegate to npm
    //   - run <script> → look up package.json#scripts and shell.execute
    //   - -e / --eval flow
    //   - script-path flow with .ts/.tsx/.jsx auto-transform
    //   - BUN_SHIM_PREAMBLE prepend (handled inside runBunScript itself)
    //
    // Bun does NOT use binSpawn ctx propagation today (its runFresh
    // chain doesn't share PID state with the .bin handler — the .bin
    // handler always dispatches through `node`, not `bun`). So
    // supportsBinSpawn=false (default).
    const bunSpec: RuntimeSpec = {
      name: 'bun',
      version: BUN_VERSION,
      helpText:
        'Usage: bun [options] [script.[js|ts|tsx]] [args...]\n' +
        '       bun -e "code"\n' +
        '       bun install [pkg ...]\n' +
        '       bun run <script>\n\n' +
        'Bun-runtime shim provides Bun.serve/Bun.file/Bun.write/\n' +
        'Bun.spawn/Bun.password/Bun.gunzip backed by Workers-native\n' +
        'primitives. Bun.sql / Bun.S3 throw (use D1/Hyperdrive/R2).\n' +
        'Execution via DO Facets (isolated V8 isolate per call).',
      run: async (fm, code, opts) => runBunScript(fm, code, opts as any),
      subcommands: {
        // bun install / i / add → npm install (same VFS, same R2 caches).
        install: async (ctx: any, reg) => {
          const npmCmd = await reg.resolve('npm');
          if (npmCmd) {
            return await npmCmd({ ...ctx, args: ['install', ...(ctx.args || []).slice(1)] });
          }
          ctx.stderr.write('bun install: npm handler unavailable\n');
          return 1;
        },
        i: async (ctx: any, reg) => {
          const npmCmd = await reg.resolve('npm');
          if (npmCmd) {
            return await npmCmd({ ...ctx, args: ['install', ...(ctx.args || []).slice(1)] });
          }
          ctx.stderr.write('bun i: npm handler unavailable\n');
          return 1;
        },
        add: async (ctx: any, reg) => {
          const npmCmd = await reg.resolve('npm');
          if (npmCmd) {
            return await npmCmd({ ...ctx, args: ['install', ...(ctx.args || []).slice(1)] });
          }
          ctx.stderr.write('bun add: npm handler unavailable\n');
          return 1;
        },
        // bun run <script> — read package.json scripts.<name>, execute via shell.
        run: async (ctx: any) => {
          const args: string[] = ctx.args || [];
          const scriptName = args[1];
          if (!scriptName) {
            ctx.stderr.write('bun run: missing script name\n');
            return 1;
          }
          const pkgPath = normalizeVfsPath(ctx.cwd || '/home/user') + '/package.json';
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
        },
      },
    };
    {
      const oneShotBun = buildRuntimeHandler(bunSpec, {
        vfs: sqliteFs,
        facetMgr,
        getEsbuild: () => {
          if (!self.esbuildService) {
            self.ensureSqliteFs();
            self.esbuildService = new EsbuildService(self.sqliteFs!);
          }
          return self.esbuildService!;
        },
        registry,
      });
      // REPL Stream A: no-args invocation → drop into REPL session.
      registry.register('bun', async function bunReplOrOneShot(ctx: any): Promise<number> {
        const argv: string[] = ctx.args || [];
        if (argv.length === 0 && self.terminal) {
          const { runBunRepl } = await import('../runtime/bun-repl.js');
          return await runBunRepl({ facetMgr, terminal: self.terminal });
        }
        return await oneShotBun(ctx);
      });
    }

    // ── wasm-runner: native WebAssembly runtime via LOADER-modules transport ──
    //
    // Re-introduced after the runtime registry refactor's revert. Bytes
    // ride INSIDE the worker code blob (LOADER's modules map, the
    // one phase where wasm code generation IS allowed); request-time
    // WebAssembly.instantiate(bytes) is CSP-blocked and avoided.
    //
    // wasm-csp/findings.md — add(3,4)===7 in 11ms warm against the
    // deployed Cloudflare fleet.
    //
    // bypassesScriptRead: the registry skips the read-source/
    // shebang-strip/esbuild-transform flow. wasm-runner reads bytes
    // itself in spec.run() and ships via NimbusLoaderPool.
    const wasmSpec: RuntimeSpec = {
      name: 'wasm-runner',
      version: WASM_RUNNER_VERSION,
      helpText: WASM_RUNNER_HELP,
      subcommands: {
        '--wasi-info': async (ctx: any) => {
          ctx.stdout.write(formatWasmRunnerWasiInfo());
          return 0;
        },
      },
      run: makeWasmRunner({
        // filesystem WASI: extended VFS surface for WASI file-IO. The wasm-runner
        // snapshots a session subtree into the facet, flushes the diff
        // back via this surface after _start returns.
        vfs: {
          exists:      (p: string) => sqliteFs.exists(p),
          isDirectory: (p: string) => sqliteFs.isDirectory(p),
          readFile:    (p: string) => sqliteFs.readFile(p),
          writeFile:   (p: string, c: Uint8Array | string) => sqliteFs.writeFile(p, c),
          readdir:     (p: string) => sqliteFs.readdir(p),
          mkdir:       (p: string, o?: { recursive?: boolean }) => sqliteFs.mkdir(p, o),
          unlink:      (p: string) => sqliteFs.unlink(p),
          rmdir:       (p: string) => sqliteFs.rmdir(p),
        },
        env: self.env,
        ctx: self.ctx,
        processes: self.processes,
      }),
      bypassesScriptRead: true,
    };
    registry.register(
      'wasm-runner',
      buildRuntimeHandler(wasmSpec, {
        vfs: sqliteFs,
        facetMgr,
        getEsbuild: () => {
          if (!self.esbuildService) {
            self.ensureSqliteFs();
            self.esbuildService = new EsbuildService(self.sqliteFs!);
          }
          return self.esbuildService!;
        },
        registry,
      }),
    );

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
        const filePath = resolveVfsPath(entryPoints[0], ctx.cwd || '/home/user');

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
            const outPath = resolveVfsPath(flags['outfile'], ctx.cwd || '/home/user');
            const parent = parentVfsPath(outPath);
            if (parent && !sqliteFs.exists(parent)) sqliteFs.mkdir(parent, { recursive: true });
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
      const resolvedEntryPoints = entryPoints.map(ep => resolveVfsPath(ep, ctx.cwd || '/home/user'));

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
          const outPath = normalizeVfsPath(f.path);
          const parent = parentVfsPath(outPath);
          if (parent && !sqliteFs.exists(parent)) sqliteFs.mkdir(parent, { recursive: true });
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

      const viteConfig: ParsedViteConfig = {};
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
            Object.assign(viteConfig, parseViteConfigSource(cfgCode));
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
          const htmlEntrypoint = await findHtmlScriptEntrypoint(origHtml);
          if (htmlEntrypoint) entryPoint = cwd + '/' + stripLeadingSlashes(htmlEntrypoint);
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
            const distHtml = await rewriteViteBuildHtml(origHtml, {
              jsFilename,
              cssFilename: allCss.trim() ? cssFilename : undefined,
              removeImportMap: cdnPackages.length === 0,
            });
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
        // process metadata support: same long-running treatment as the
        // dev path, just on the dist/ directory.
        const previewPort = viteConfig.port || 4173; // vite preview default
        const previewProcEntry = self.processes.spawn(
          'vite preview (' + distRoot + ')', [], distRoot,
          { longRunning: true },
        );
        self.viteDevServer = new ViteDevServer({
          vfs: self.sqliteFs!, esbuild: self.esbuildService!, root: distRoot,
          onHmrMessage: () => {},
          sql: self.ctx.storage.sql,
          basePath: previewBasePath,
          env: self.env,
          ctx: self.ctx,
          port: previewPort,
          pid: previewProcEntry.pid,
          processes: self.processes,
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
      const sessionEnv = (ctx && ctx.env) || {};
      const useReal = shouldUseRealVite({ env: sessionEnv, viteConfig });
      if (useReal) {
        if (self.cirrusReal?.isRunning) self.cirrusReal.stop(self.ctx);
        const vitePort = resolvedPort;
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
              // Give bundled user config a stable module URL so plugins that
              // resolve files relative to import.meta.url can find their own
              // synthetic install location.
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
        const entry = self.processes.spawn(
          'vite (real, ' + vfsRoot + ')', [], vfsRoot,
          { longRunning: true },
        );
        try {
          // [sdk-phase-1] start() is now async because it ASSETS-fetches
          // the large Vite/plugin-react bundles on first invocation
          // (cached per-isolate after). The enclosing function is async.
          await self.cirrusReal.start(self.ctx, entry.pid);
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

      if (!self.esbuildService) self.esbuildService = new EsbuildService(self.sqliteFs!);
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
      // Long-running handoff (bin-spawn contract): when invoked from a
      // wrapper that already allocated a pid (`npm run dev` via
      // shellExecuteTracked, or the npm-bin resolver), ADOPT that pid instead
      // of spawning a second one. One pid, one start banner, no false exit —
      // the wrapper stays `running` in /api/processes with this port.
      const binSpawn = ctx.__nimbusBinSpawn as
        | { skipSpawn?: boolean; callerPid?: number }
        | undefined;
      const adoptedEntry =
        binSpawn?.skipSpawn && binSpawn.callerPid != null
          ? self.processes.get(binSpawn.callerPid)
          : undefined;
      const handedOff = adoptedEntry != null;
      const viteProcEntry = adoptedEntry ?? self.processes.spawn(
        'vite (' + vfsRoot + ')',
        expandedArgs,
        vfsRoot,
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
        // process diagnostics support: wire dev-server diagnostics into the
        // supervisor's per-PID log store so the Process tab is no
        // longer silent after the banner.
        pid: viteProcEntry.pid,
        processes: self.processes,
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

        const vfsRoot = resolveVfsPath(root, ctx.cwd || '/home/user');

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
        // runtime primitive support (P5): banner advertises the canonical
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
      const cwd = normalizeVfsPath(ctx.cwd || '/home/user');

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
    // Primitive #7 (runtime primitive support): PORT/HOST and
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
      PATH: DEFAULT_PATH,
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
    // env.HOME, and restoring after construction is safe because no
    // interactive command has run yet.
    if (persisted.cwd) {
      try { self.shell.setCwd(persisted.cwd); } catch { /* fail-soft */ }
    }

    installShellExecutionFeatures(self.shell, self.terminal);

    // ── Readline-parity keybindings (Ctrl+K, Ctrl+W, Alt+B, Alt+F, Alt+D,
    //    Ctrl+Y, Ctrl+T, Ctrl+L, Ctrl+R, Alt+. , Ctrl+←/→, Alt+←/→, Linux
    //    Home/End variants, Ctrl+B/F/N/P, …). Installed AFTER Heredoc so
    //    its handleInput wrapper takes precedence when heredoc mode is
    //    active. ──
    LineEditorExtender.install(self.shell, self.terminal);

    // ── Wire npm/npx with shellExecute ──
    const shell = self.shell;
    const shellExecute = async (cmd: string, cmdCtx: any): Promise<number> => {
      const result = await shell.execute(cmd, {
        cwd: cmdCtx.cwd,
        env: cmdCtx.env,
        onStdout: (d: string) => cmdCtx.stdout.write(d),
        onStderr: (d: string) => cmdCtx.stderr.write(d),
        stdin: typeof cmdCtx.stdin === 'string' ? cmdCtx.stdin : undefined,
      });
      return result.exitCode;
    };
    const shellEntrypointExecutor = {
      execute: async (cmd, options) => {
        const terminal = createHeadlessTerminal();
        const childShell = new Shell(
          terminal,
          self.kernel!.vfs,
          registry,
          { ...env, ...(options?.env || {}) },
          processRegistry,
        );
        installShellExecutionFeatures(childShell, terminal);
        if (options?.cwd) childShell.setCwd(options.cwd);
        return childShell.execute(cmd, options);
      },
    } satisfies ShellEntrypointExecutor;
    registerShellEntrypointCommands(registry, shellEntrypointExecutor, sqliteFs);

    // Shell scripts that execute through the local shell still need the same
    // process-table and log-store contract as facet-backed processes.
    const shellExecuteTracked = async (
      cmd: string,
      cmdCtx: any,
      opts: { longRunning?: boolean } = {},
    ): Promise<number> => {
      const entry = self.processes.spawn(cmd, [cmd], cmdCtx.cwd || '/home/user');
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
        try { self.processes.appendOutput(pid, stream, String(d)); } catch {}
        try { target.write(d); } catch {}
      };

      let exitCode = 1;
      try {
        const result = await shell.execute(cmd, {
          cwd: cmdCtx.cwd,
          env: cmdCtx.env,
          onStdout: tee('stdout', cmdCtx.stdout),
          onStderr: tee('stderr', cmdCtx.stderr),
          // Single spawn path for long-running handoff: a registry command
          // (vite/wrangler/serve) ADOPTS this wrapper pid via the bin-spawn
          // contract instead of allocating a second one, and suppresses its
          // own `[started (long-running)]` notice.
          commandContext: opts.longRunning
            ? {
                __nimbusBinSpawn: {
                  skipSpawn: true,
                  callerPid: pid,
                  command: cmd,
                  forceLongRunning: true,
                },
              }
            : undefined,
        });
        exitCode = result.exitCode;
      } catch (e: any) {
        // Surface the error in the terminal and the ring buffer.
        const msg = (e && (e.stack || e.message)) || String(e);
        tee('stderr', cmdCtx.stderr)('shellExecuteTracked error: ' + msg + '\n');
        exitCode = 1;
      } finally {
        // When a long-running script handed off to a live server (the registry
        // command adopted this pid and returned 0), the process stays running;
        // emitting an immediate exit would print a false `[shell exited]` and
        // flip the process to terminated in /api/processes. Mirror the npm-bin
        // resolver's `handedOffToLongRunningFacet` contract.
        const handedOffToLongRunningFacet = opts.longRunning === true && exitCode === 0;
        if (!handedOffToLongRunningFacet) {
          try { self.processes.exit(pid, exitCode); } catch {}
          try {
            if (!self.processes.getExit(pid)) {
              self.processes.markExit(pid, exitCode);
            }
          } catch {}

          // Structured exit for the tabs UI. Always fires (the UI doesn't
          // know which tabs are open, and client-side dedupe is trivial).
          // Include the command so the UI can backfill a tab for pids it
          // never saw a spawn event for (e.g. evals routed past onSpawn).
          notifyTerminalEvent(self.terminal, { type: 'exit', pid, code: exitCode, command: cmd });

          // Keep shell execution diagnostics on the same session helper used by
          // the rest of the process subsystem.
          try { self._emitShellExecDone(pid, cmd, exitCode, Date.now() - startedAt); } catch {}
        }
      }
      return exitCode;
    };
    const runtimeCommandHint = createRuntimeCommandHintResolver(self.env as any);
    installNpmBinFallbackResolver(registry, {
      vfs: sqliteFs,
      getCwd: () => (self.shell as any)?.cwd || '/home/user',
      processes: self.processes,
      getFacetManager: () => {
        self.ensureFacetManager();
        return self.facetManager!;
      },
      terminal: self.terminal,
      notifyTerminalEvent: (event) => notifyTerminalEvent(self.terminal, event),
      runtimeCommandHint,
      emitShellExecDone: (pid, command, exitCode, durationMs) => {
        try { self._emitShellExecDone(pid, command, exitCode, durationMs); } catch {}
      },
    });

    // Register core npm with enhanced `npm run <script>` support
    const coreNpmCmd = createNpmCommand(registry, shellExecute, kernel);
    registry.register('npm', async (ctx: any) => {
      const args: string[] = ctx.args || [];
      const sub = args[0];
      const cwdKey = normalizeVfsPath(ctx.cwd || '/home/user');

      // npm run <script> / npm test / npm start — parse package.json and execute
      if (sub === 'run' || sub === 'run-script' || sub === 'test' || sub === 'start') {
        const scriptName = sub === 'test' ? 'test' : sub === 'start' ? 'start' : args[1];
        if (!scriptName) {
          // npm run (no script) — list available scripts
          const pkgPath = cwdKey + '/package.json';
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

        const pkgPath = cwdKey + '/package.json';
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
            const guard = checkNodeModulesGuard(sqliteFs, cwdKey);
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
          // runtime primitive support (P12): the previous wave shipped this as a
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

          const scriptTrim = script.trim();
          const longRunning =
            scriptName === 'dev' || scriptName === 'start' ||
            scriptName === 'serve' || scriptName === 'watch';
          return await shellExecuteTracked(scriptTrim, {
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
        const pkgPath = cwdKey + '/package.json';
        const nmDir = cwdKey + '/node_modules';
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
        const cwd = cwdKey;
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
        const nmDir = cwdKey + '/node_modules';
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
        const pkgPath = cwdKey + '/package.json';
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
        const installInvocation = parseNpmInstallInvocation(args.slice(1));
        const explicitPkgs = installInvocation.packages;
        const globalPrefix = installInvocation.global
          ? resolveNpmPrefix(
              installInvocation.prefix ?? String(ctx.env?.npm_config_prefix || '/usr/local'),
              ctx.cwd || '/home/user',
            )
          : null;
        self.ensureSqliteFs();
        const installCwd = globalPrefix ? `${globalPrefix}/lib` : cwdKey;

        // Ensure package.json exists for bare `npm install`
        if (!globalPrefix && explicitPkgs.length === 0) {
          const pkgJsonPath = installCwd + '/package.json';
          if (!sqliteFs.exists(pkgJsonPath)) {
            ctx.stderr.write('npm ERR! no package.json found\n');
            return 1;
          }
        }
        if (globalPrefix && explicitPkgs.length === 0) {
          ctx.stderr.write('npm ERR! missing package name for global install\n');
          return 1;
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
          if (globalPrefix && (result.failed?.length || 0) === 0) {
            const linked = materializeNpmBinShims(
              sqliteFs,
              `${installCwd}/node_modules`,
              `${globalPrefix}/bin`,
            );
            if (linked > 0) {
              ctx.stdout.write(`\x1b[2m  linked ${linked} bin${linked === 1 ? '' : 's'} into /${globalPrefix}/bin\x1b[0m\n`);
            }
          }
          return result.failed?.length > 0 ? 1 : 0;
        } catch (e: any) {
          ctx.stderr.write(`\x1b[31mnpm install failed: ${e?.message}\x1b[0m\n`);
          return 1;
        }
      }

      // ── npm create <pkg> / npm init <pkg> → npx create-<pkg> ─────────
      //
      // Per the npm spec, `npm create X args...` and `npm init X args...`
      // (when X is supplied) are sugar for invoking the `create-X`
      // initializer package via npx. Specifically:
      //
      //   npm create foo args...           → npx create-foo args...
      //   npm create foo@1.2 args...       → npx create-foo@1.2 args...
      //   npm create @scope/foo args...    → npx @scope/create-foo args...
      //   npm create @scope args...        → npx @scope/create args...
      //
      // `npm init` (no args) is a different beast — it scaffolds a
      // package.json interactively. The `sub === 'init'` branch above
      // handles the no-arg case; here we only intercept the
      // initializer-package case (1+ args after `init`).
      //
      // Without this routing, `npm create vite@latest mvp -- --template
      // react-ts` hits the base npm dispatch which only knows
      // {init, install/i/add, uninstall/remove/rm/un, list/ls,
      // run/run-script, start, test, info/view/show, search, version}
      // — and emits "npm: unknown command 'create'". Every modern
      // framework's `create-*` flow (create-vite, create-next-app
      // routed via "npm create", create-cloudflare, create-astro, etc.)
      // depends on this.
      //
      // This is a primitive: one fix, every framework wins.
      if (sub === 'create' || (sub === 'init' && args.length >= 2 && !args[1].startsWith('-'))) {
        const arg1 = args[1];
        if (!arg1) {
          ctx.stderr.write('npm create: missing package name\n');
          ctx.stderr.write('Usage: npm create <pkg> [args...]\n');
          return 1;
        }
        // Parse pkg + version. Scope-aware:
        //   @scope        → @scope/create
        //   @scope/foo    → @scope/create-foo
        //   foo           → create-foo
        //   foo@1.2.3     → create-foo@1.2.3
        //   foo@latest    → create-foo@latest
        function rewriteToCreatePkg(spec: string): string {
          // Strip an optional version range and re-append after the rewrite.
          const atIdx = spec.lastIndexOf('@');
          const hasVersion = atIdx > 0; // a leading @ is the scope; not a version
          const bare = hasVersion ? spec.slice(0, atIdx) : spec;
          const version = hasVersion ? spec.slice(atIdx) : '';
          let pkg: string;
          if (bare.startsWith('@')) {
            const slash = bare.indexOf('/');
            if (slash < 0) {
              // @scope → @scope/create
              pkg = bare + '/create';
            } else {
              // @scope/foo → @scope/create-foo
              const scope = bare.slice(0, slash);
              const name = bare.slice(slash + 1);
              pkg = scope + '/create-' + name;
            }
          } else {
            pkg = 'create-' + bare;
          }
          return pkg + version;
        }
        const createPkg = rewriteToCreatePkg(arg1);
        const passThrough = args.slice(2);
        // `npm create` accepts an optional `--` separator to push the
        // remaining args to the create script; npx doesn't need a
        // separator (positional args after the package name go to the
        // package). We strip a single literal `--` token if present so
        // `npm create vite@latest mvp -- --template react-ts` becomes
        // `npx --yes create-vite@latest mvp --template react-ts`.
        const stripped = passThrough.filter((a, i, arr) => !(a === '--' && i < arr.length - 1) && !(a === '--' && arr.indexOf('--') === i));
        // Inform the user what we're routing to — matches npm's own
        // visible "npx" line so the create flow is honest.
        ctx.stdout.write(`> npx --yes ${createPkg}${stripped.length ? ' ' + stripped.join(' ') : ''}\n`);
        // Dispatch through the npx registry entry. `--yes` skips the
        // "Ok to proceed? (y)" prompt.
        const npxHandler = await registry.resolve('npx');
        if (!npxHandler) {
          ctx.stderr.write('npm create: npx command unavailable\n');
          return 1;
        }
        return await npxHandler({
          ...ctx,
          args: ['--yes', createPkg, ...stripped],
        });
      }

      // Fall through to core npm for other subcommands
      return coreNpmCmd(ctx);
    });
    // npx: check registered commands first, then resolve/install through
    // Nimbus's NpmInstaller and execute the package bin via the Node runtime.
    registry.register('npx', async (ctx: any) => {
      const npxArgs: string[] = ctx.args || [];
      const {
        describeNpxSelfInvocation,
        formatNpxHelp,
        getNpxCommandArgs,
        getNpxCommandWord,
        resolveNpxBinary,
      } = await import('../npm/npx-install.js');
      const selfInvocation = describeNpxSelfInvocation(npxArgs);
      if (selfInvocation === 'missing') { ctx.stderr.write('Usage: npx <command> [args...]\n'); return 1; }
      if (selfInvocation === 'version') {
        ctx.stdout.write(NPM_VERSION + '\n');
        return 0;
      }
      if (selfInvocation === 'help') {
        ctx.stdout.write(formatNpxHelp());
        return 0;
      }
      const cmd = getNpxCommandWord(npxArgs);

      // Check if it's a built-in command (vite, esbuild, etc.)
      const resolved = cmd ? await registry.resolve(cmd) : null;
      if (resolved) {
        return await resolved({ ...ctx, args: getNpxCommandArgs(npxArgs) });
      }

      // Nimbus-native npx install + run path. Routes package installation
      // through NpmInstaller's full-packument resolver.
      self.ensureNpmInstaller((msg: string) => ctx.stdout.write('[npm] ' + msg + '\n'));
      self.ensureSqliteFs();
      const installer = self.npmInstaller!;
      const resolveResult = await resolveNpxBinary(
        installer,
        self.sqliteFs! as any,
        ctx.cwd || '/home/user',
        npxArgs,
        (msg: string) => ctx.stdout.write(msg + '\n'),
      );
      if (resolveResult.ok && resolveResult.binPath) {
        const nodeCmd = await registry.resolve('node');
        if (nodeCmd) {
          return await nodeCmd({
            ...ctx,
            args: [resolveResult.binPath, ...(resolveResult.binArgs || [])],
            __nimbusBundleProfile: resolveResult.bundleProfile,
          });
        }
        ctx.stderr.write('npx: node runtime is not registered\n');
        return 1;
      }
      ctx.stderr.write((resolveResult.error || 'npx: could not resolve binary') + '\n');
      return 1;
    });

    // ── Register process commands (enhanced with facet process tracking) ──
    registry.register('ps', async (ctx: any) => {
      // Pids are generation-strided (see PID_GEN_STRIDE) so they can be 7+
      // digits; size the column to the widest pid in this listing.
      const procs = self.processes.getAll();
      const pidWidth = Math.max(3, ...procs.map((p: any) => String(p.pid).length));
      ctx.stdout.write(`  ${'PID'.padStart(pidWidth)}  STATUS              COMMAND\n`);
      for (const proc of procs) {
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
        ctx.stdout.write(`  ${String(proc.pid).padStart(pidWidth)}  ${status.padEnd(26)}  ${proc.command}\n`);
      }
      // Show vite dev server
      if (self.viteDevServer?.isRunning) {
        ctx.stdout.write('  \x1b[33m---\x1b[0m  \x1b[32mrunning\x1b[0m                     vite dev server (' + self.viteBasePath + '/)\n');
      }
      if (self.processes.getAll().length === 0 && !self.viteDevServer?.isRunning) {
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

      if (!self.processes.hasLogs(pid)) {
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
      const chunks = self.processes.tailLogs(pid, tailOpts);
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
        const exit = self.processes.getExit(pid);
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
      const entry = self.processes.get(pid);
      const alreadyExited =
        !entry || entry.state !== 'running' || self.processes.getExit(pid);
      if (alreadyExited) {
        const exit = self.processes.getExit(pid);
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
        const unsub = self.processes.subscribeLogs(pid, (c) => {
          ctx.stdout.write(renderChunk(c));
        });
        const unsubExit = self.processes.subscribeExit(pid, (exit) => {
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
        const exitNow = self.processes.getExit(pid);
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
      const running = self.processes.getRunning();
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

    const shellKillCommand = createKillCommand(processRegistry);
    registry.register('kill', async (ctx: any) => {
      const pidArg = ctx.args[0];
      if (!pidArg) { ctx.stderr.write('Usage: kill <pid>\n'); return 1; }
      if (pidArg.startsWith('-') || pidArg.startsWith('%')) {
        return shellKillCommand(ctx);
      }
      const pid = parseInt(pidArg);
      if (isNaN(pid)) { ctx.stderr.write('kill: invalid pid\n'); return 1; }
      if (processRegistry.get(pid)) {
        return shellKillCommand(ctx);
      }

      // runtime primitive support (P11): if the target is the vite shim PID
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
        try { self.processes.kill(pid); } catch {}
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

type ShellFeatureTerminal = {
  write(data: string): void;
  writeln(data: string): void;
  onData(callback: (data: string) => void): void;
  readonly cols: number;
  readonly rows: number;
  focus(): void;
  clear(): void;
};

function installShellExecutionFeatures(
  shell: Shell,
  terminal: ShellFeatureTerminal,
): void {
  HeredocHandler.install(shell, terminal);
}

function createHeadlessTerminal(): ShellFeatureTerminal {
  return {
    cols: 80,
    rows: 24,
    write() {},
    writeln() {},
    onData() {},
    focus() {},
    clear() {},
  };
}
