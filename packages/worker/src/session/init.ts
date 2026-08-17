/**
 * session/init.ts — initSession boot + shell-command registrations.
 *
 * Why this is one big function and not a class:
 * initSession runs once per /ws upgrade and walks the session
 * through Phase R (rehydrate from SQL), Phase B (compose the
 * workspace + register the session's commands), Phase W (attach
 * terminal), and (cold-only) Phase O (MOTD + framework hint). The
 * phases share lots of locals (vfs, kernel, registry, shell) and
 * ordering matters strictly — there's no interesting reuse boundary
 * that a class decomposition would expose.
 *
 * What it no longer does is COMPOSE the operating system. The kernel,
 * the provider mounts, the command registry, the coreutils, the exec
 * resolver, the default environment and the shell come from
 * `NimbusWorkspace` (@nimbus-sh/core/workspace), which an embedder off
 * Cloudflare builds the same way. What stays here is everything that
 * only makes sense with a socket, a Durable Object and a product behind
 * it: the terminal and its scrollback, the phase machine, the persisted
 * shell state, npm, git, vite, wrangler and the facet-backed runtimes.
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
  Shell, createCurlCommand, createNpmCommand,
  NPM_VERSION, createTopCommand, createWatchCommand, createHelpCommand,
  rehydrateGlobalPackages,
} from '@nimbus-sh/core/substrate/lifo/index.js';
import { createKillCommand } from '@nimbus-sh/core/substrate/lifo/commands/system/kill.js';
import type { CommandContext, CommandRunAsHost } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
import type { ShellCommandIdentity } from '@nimbus-sh/core/substrate/lifo/shell/Shell.js';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { CRED_KERNEL, requireVfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { WebSocketTerminal } from '../facets/ws-terminal.js';
import { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { runFresh } from '../runtime/node-runner.js';
import { runBunScript, BUN_VERSION } from '../runtime/bun-runner.js';
import {
  buildRuntimeHandler,
  resolveRuntimeScriptPath,
  type RuntimeSpec,
} from '@nimbus-sh/core/runtime/runtime-registry.js';
import { parseViteConfigSource, type ParsedViteConfig } from '@nimbus-sh/core/runtime/vite-config-parser.js';
import { startRealVite } from './start-real-vite.js';
import { findHtmlScriptEntrypoint, rewriteViteBuildHtml } from '../runtime/html-entrypoint.js';
import { normalizeVfsPath, parentVfsPath, resolveVfsPath, stripLeadingSlashes } from '@nimbus-sh/core/vfs/path.js';
import { ViteDevServer } from '../facets/vite-dev-server.js';
import { shouldUseRealVite } from '../facets/cirrus-real.js';
import {
  makeLongRunningPortStub,
  resolveLongRunningPort,
  expandArgvShellDefaults,
} from '@nimbus-sh/core/runtime/long-running-handle.js';
import { NimbusWrangler } from '../wrangler/nimbus-wrangler.js';
import {
  filterWranglerFlags, detectBundlerBin, checkNodeModulesGuard,
  detectUnsupportedWranglerConfig,
} from './helpers.js';
import { HeredocHandler, LineEditorExtender } from '@nimbus-sh/core/shell/features.js';
import { registerShellEntrypointCommands, type ShellEntrypointExecutor } from '@nimbus-sh/core/shell/shell-entrypoints.js';
import { makeChshCommand } from '@nimbus-sh/core/substrate/lifo/shell/default-shell.js';
import { installNpmBinFallbackResolver } from '../shell/npm-bin-entrypoints.js';
import { parseNpmInstallInvocation } from '../npm/install-args.js';
import { npmLogEnabled, type NpmLogLevel } from '../npm/npm-log.js';
import { materializeNpmBinShims } from '../npm/bin-links.js';
import { registerGitCommands } from '../git/commands.js';
import {
  makeNimbusVerbHandler,
  createRuntimeCommandHintResolver,
} from '../runtime/package-manager.js';
import {
  listInstalledRuntimes,
  rehydrateInstalledRuntimes,
  registerRunnerFactory,
} from '@nimbus-sh/core/runtime/installed-runtimes.js';
// Runtime factories (clang/python/ruby/bash/wasm) are imported lazily at
// first-use inside their registered handlers — see the registrations below.
// Keeping them off the top-level import graph shaves their module-eval cost
// (zod, embedded socket-kernel/shim sources, wasm loaders) out of the
// one-time Worker Startup Time paid on every fresh-isolate cold run.
import { seedProject, hasSeededProject, SEED_PROJECT_DIR } from '@nimbus-sh/core/vfs/seed-project.js';
import { notifyTerminalEvent } from '../runtime/process-logs-api.js';
import { stripAnsi, type LogChunk } from '@nimbus-sh/core/runtime/process-logs.js';
import {
  DEFAULT_MOUNT_POINTS, CF_COMPAT_DATE, NODE_VERSION,
} from '@nimbus-sh/core/constants.js';
import {
  ensureSessionStateSchema, loadShellState, persistShellState,
  stampHydratedAt, countSessionStateKeys,
  loadKernelMounts, persistKernelMounts,
  appendScrollback, loadScrollback,
  type ShellStateSnapshot,
} from './state-store.js';
import { recordRecoveryEvent } from '@nimbus-sh/core/observability/oom-discriminator.js';
import { sessionAiEnv } from './ai.js';
import { routeSessionLoopback } from './loopback.js';
import { setPhase } from './init-phases.js';
import { VITE_CONFIG_KEY } from './keys.js';
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

function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}


export async function initSession(self: InitHost, ws: WebSocket): Promise<void> {
    self.ensureSqliteFs();
    const kernelFs = self.sqliteFs!.as(CRED_KERNEL);
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
      // The scrollback stops mid-command when the previous instance was
      // reset under it — the platform kills the isolate without running a
      // line of our code, so nothing could be said at the time and the
      // socket died with close code 1006 and no frame. Say it now, on the
      // first socket that exists to say it on: this is the only moment the
      // session can tell a user why their terminal went dead.
      //
      // Deliberately claims nothing about the cause. A restarted instance
      // cannot observe whether it was evicted, redeployed, or killed for
      // memory — that verdict only ever reaches an operator's `wrangler
      // tail`, and inventing one here would be worse than the silence.
      // What IS certain is stated: the process table is this instance's,
      // and it starts empty.
      self.terminal.write(
        '\x1b[33m[nimbus] this session resumed on a new instance. Anything still '
          + 'running was lost with the old one — re-run it if it had not finished.\x1b[0m\r\n',
      );
    }

    // A reset that killed a resident launch left its journal row behind
    // (facets/manager.ts, _recoverInterruptedLaunches). The alarm the dying
    // instance was using for launch turns is NOT a trigger recovery can rely
    // on — measured live, a launch killed early in its first chunks rolls the
    // alarm-map put back with the rest of the dying turn, so the replacement
    // instance never fires an alarm at all. What always follows a dead session
    // is this reconnect, so recovery runs here: after the terminal exists (the
    // report lands in front of the user, live) and after the constructor's
    // pidBase gate (the journal predicate needs this instance's generation).
    // Idempotent per instance; a no-op whenever no launch was interrupted.
    await self.facetManager!.pumpResidentLaunches();

    // [B'.4] Phase B — Build. Compose the workspace (kernel + mounts +
    // shell + the OS command set), then install the session's own
    // commands and wiring on top. CPU-intensive phase. Spans from here
    // through Phase O.
    setPhase(self, 'build', 'init-session');

    // ── Mount list = DEFAULT_MOUNT_POINTS ∪ persisted-mounts [B'.2] ──
    //
    // The defaults are always present (they're platform invariants);
    // any extras a future custom-mount feature might add survive
    // reconnect via the nimbus_kernel_mounts table. The persist step
    // below writes the merged list back so the table tracks the live
    // mount tree — today the same 7 rows every initSession.
    const persistedMounts = loadKernelMounts(self.ctx);
    const mountPoints = Array.from(new Set([
      ...DEFAULT_MOUNT_POINTS,
      ...persistedMounts,
    ]));

    // ── What the session adds to the workspace's environment [B'.1] ──
    //
    // The platform defaults — PATH, PS1, HOME, PORT, HOST and the rest —
    // belong to the workspace (core/workspace/nimbus-workspace.ts) because
    // they are the OS's, not this transport's. What is genuinely the
    // session's layers here:
    //
    //   NIMBUS_SESSION_ID — derived from sessionBasePath = "/s/<id>". Set
    //                here as a placeholder ("") and patched below right
    //                after the shell exists, so the user's first command
    //                sees the real id. Sentry / Datadog / any ops
    //                integration that wants a session-stable token reads it.
    //
    //   sessionAiEnv() — the session AI gateway (session/ai.ts). A coding
    //                agent, a user's own script or curl reaches the
    //                session's models from these without being configured:
    //                by OPENAI_BASE_URL if it reads one, and otherwise by
    //                CLOUDFLARE_API_KEY, this session's capability token,
    //                which mediates the tool's own egress back to the
    //                gateway (_shared/ai-egress.ts).
    //
    //   persisted.env — the user's own `export FOO=bar`, which survives
    //                reconnect and wins over everything above. A user who
    //                exports their own OPENAI_BASE_URL or CLOUDFLARE_API_KEY
    //                still wins; their key is not this session's token, so
    //                their request goes to their own account.
    const envOverlay: Record<string, string> = {
      NIMBUS_SESSION_ID: '',
      ...sessionAiEnv(),
      ...(persisted.env || {}),
    };

    // ── The identity the shell acts under ──
    //
    // Every command the shell runs is credentialed by a live entry in the
    // session's process table, which is what makes `sudo`, `chown` and the
    // per-process umask mean anything. A workspace with no host process
    // table falls back to a bare uid-1000 identity; this one has one.
    if (self.shellProcessPid !== null) {
      self.processes.exit(self.shellProcessPid, 0);
    }
    const shellProcess = self.processes.spawn(
      'sh',
      ['sh'],
      persisted.cwd || '/home/user',
    );
    self.shellProcessPid = shellProcess.pid;

    const runAsProcess: CommandRunAsHost = async (parent, cred, argv) => {
      if (argv.length === 0) return 0;
      const child = self.processes.spawn(
        argv.join(' '),
        argv,
        parent.cwd,
        { parentPid: parent.pid, cred },
      );
      const activeShell = self.shell;
      if (!activeShell) {
        self.processes.exit(child.pid, 1);
        throw new Error('shell is not initialized');
      }

      const identity = commandIdentityFor(child.pid);
      let exitCode = 1;
      try {
        const stdin = parent.stdin && parent.stdin !== parent.terminalStdin
          ? await parent.stdin.readAll()
          : undefined;
        const result = await activeShell.execute(
          argv.map(quoteShellArgument).join(' '),
          {
            cwd: parent.cwd,
            env: parent.env,
            stdin,
            terminalStdin: parent.terminalStdin,
            signal: parent.signal,
            isolateShellState: true,
            terminalFds: {
              stdin: parent.isFdTerminal?.(0) ?? false,
              stdout: parent.isFdTerminal?.(1) ?? false,
              stderr: parent.isFdTerminal?.(2) ?? false,
            },
            onStdout: (data) => parent.stdout.write(data),
            onStderr: (data) => parent.stderr.write(data),
            commandContext: {
              pid: identity.pid,
              cred: identity.cred,
              setUmask: identity.setUmask,
            },
            runAs: runAsProcess,
          },
        );
        exitCode = result.exitCode;
        return exitCode;
      } finally {
        self.processes.exit(child.pid, exitCode);
      }
    };

    const commandIdentityFor = (pid: number): ShellCommandIdentity => ({
      pid,
      get cred() {
        return self.processes.cred(pid);
      },
      setUmask(mask: number) {
        self.processes.setUmask(pid, mask);
      },
      runAs: runAsProcess,
    });

    // ── The workspace: one recipe for kernel + mounts + shell + coreutils ──
    //
    // No `facets`: the session registers its own runtime factories below,
    // because the ones it needs carry REPLs, a resident-process substrate
    // and clang, none of which a bare facet host reaches. Everything the
    // workspace does register is the OS, and is identical either way.
    const workspace = await NimbusWorkspace.create({
      sql: self.ctx.storage.sql,
      // The filesystem this DO already opened. `ensureSqliteFs` above may
      // have been called many requests ago; a second SqliteVFS over the
      // same rows would be a second cache serving stale reads.
      vfs: self.sqliteFs!,
      mounts: mountPoints,
      env: envOverlay,
      terminal: self.terminal,
      identity: commandIdentityFor(shellProcess.pid),
    });
    self.kernel = workspace.kernel;
    self.shell = workspace.shell;

    const kernel = workspace.kernel;
    const registry = workspace.registry;
    const processRegistry = kernel.processRegistry;
    const env = workspace.env;
    const sqliteFs = self.sqliteFs!;
    const facetMgr = self.facetManager!;

    try { persistKernelMounts(self.ctx, mountPoints); } catch { /* fail-soft */ }

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
          if (!kernelFs.exists(p)) {
            reply({ type: 'fs-read-result', path: msg.path, error: 'ENOENT: no such file or directory' });
            return;
          }
          if (kernelFs.isDirectory(p)) {
            reply({ type: 'fs-read-result', path: msg.path, error: 'EISDIR: is a directory' });
            return;
          }
          // Read bytes; attempt strict UTF-8 decode. Non-UTF-8 → mark
          // binary so the editor shows a friendly placeholder rather
          // than mojibake.
          const bytes = kernelFs.readFile(p);
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
          if (parent) try { kernelFs.mkdir(parent, { recursive: true }); } catch {}
          const content = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
          kernelFs.writeFile(p, content);
          reply({ type: 'fs-write-result', path: msg.path, ok: true });
          return;
        }
        if (msg.type === 'fs-list') {
          const dir = stripLeadingSlashes(String(msg.dir || ''));
          const recursive = msg.recursive === true;
          if (dir && !kernelFs.exists(dir)) {
            reply({ type: 'fs-list-result', dir: msg.dir, entries: [], error: 'ENOENT' });
            return;
          }
          if (dir && !kernelFs.isDirectory(dir)) {
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
            try { entries = kernelFs.readdir(cur); } catch { continue; }
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

    // W8: hand the registry to the cp broker so child_process.spawn from
    // a parent facet can resolve and dispatch commands the same way the
    // shell does.
    self._setCpRegistry(registry);

    registry.register('chsh', makeChshCommand({
      isBashInstalled: (home) =>
        listInstalledRuntimes(sqliteFs, home).some((runtime) => runtime.name === 'bash'),
    }));

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
    registerRunnerFactory(
      'clang-runner',
      (manifest, installRoot, binName, binKind) => async (ctx: CommandContext) => {
        const { makeClangRunnerFactory } = await import('@nimbus-sh/core/runtime/clang-runner.js');
        const { facetHostForManager } = await import('../runtime/facet-loader-host.js');
        return await makeClangRunnerFactory({ facets: facetHostForManager(facetMgr), vfs: sqliteFs })(
          manifest, installRoot, binName, binKind,
        )(ctx);
      },
    );
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
    registerRunnerFactory(
      'cpython-runner',
      (manifest, installRoot, binName, binKind) => async function pythonReplOrOneShot(ctx: any): Promise<number> {
        const argv: string[] = ctx.args || [];
        // No args at all → REPL session. Hand off to runPythonRepl
        // which builds its own LoaderPool (separate from the
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
            // The supervisor derives the write credential from this; without
            // it the prompt cannot write to the session filesystem.
            pid: ctx.pid,
          });
        }
        // Args present (one-shot mode: -c, script, -m, -). Fall through
        // to the canonical handler (imported lazily on first use).
        const { makeCPythonRunnerFactory } = await import('@nimbus-sh/core/runtime/cpython-runner.js');
        const { facetHostForManager } = await import('../runtime/facet-loader-host.js');
        const { cpythonResidentStart } = await import('../runtime/cpython-resident.js');
        return await makeCPythonRunnerFactory({
          facets: facetHostForManager(facetMgr),
          vfs: sqliteFs,
          startResident: cpythonResidentStart(facetMgr),
        })(manifest, installRoot, binName, binKind)(ctx);
      },
    );
    // Ruby v1 — Ruby 3.3.4 via ruby.wasm 2.9.3-2.9.4. Same architecture
    // as python-runner: ruby+stdlib.wasm rides via LOADER modules-map,
    // bootstrap runs at child-facet module-init time, per-call
    // __rubyRun drives rb-eval-string-protect with a wrapper that
    // catches SystemExit. See src/runtime/ruby-runner.ts +
    //
    // REPL Stream A: wrap the one-shot factory so `ruby` with NO args
    // drops into an interactive REPL. The wrap is purely additive —
    // args-bearing invocations pass through to the existing handler.
    registerRunnerFactory(
      'ruby-runner',
      (manifest, installRoot, binName, binKind) => async function rubyReplOrOneShot(ctx: any): Promise<number> {
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
        const { makeRubyRunnerFactory } = await import('@nimbus-sh/core/runtime/ruby-runner.js');
        const { facetHostForManager } = await import('../runtime/facet-loader-host.js');
        const { rubyResidentStart } = await import('../runtime/ruby-resident.js');
        return await makeRubyRunnerFactory({
          facets: facetHostForManager(facetMgr),
          vfs: sqliteFs,
          registry,
          startResident: rubyResidentStart(facetMgr),
        })(manifest, installRoot, binName, binKind)(ctx);
      },
    );
    // GNU bash 5.2.37 (wasm32-wasi, asyncified) — dedicated facet
    // runner driving the fork/pipe/exec/setjmp scheduler (fork M1-M3
    // mechanisms). Interactive terminal invocations use the shared
    // ReplSession line editor; -c, scripts, and piped stdin retain the
    // canonical one-shot handler.
    registerRunnerFactory(
      'bash-runner',
      (manifest, installRoot, binName, binKind) => async (ctx: CommandContext) => {
        const argv = ctx.args || [];
        const explicitInteractive = argv.includes('-i');
        const terminalStdin = ctx.isFdTerminal?.(0) ?? !ctx.stdin;
        if (self.terminal && (explicitInteractive || (argv.length === 0 && terminalStdin))) {
          const { runBashRepl } = await import('../runtime/bash-repl.js');
          return await runBashRepl({
            facetMgr,
            vfs: sqliteFs,
            terminal: self.terminal,
            installRoot,
            manifest,
            cred: ctx.cred,
            env: ctx.env,
            cwd: ctx.cwd || '/home/user',
            shell: self.shell ?? undefined,
          });
        }
        const { makeBashRunnerFactory } = await import('@nimbus-sh/core/runtime/bash-runner.js');
        const { facetHostForManager } = await import('../runtime/facet-loader-host.js');
        return await makeBashRunnerFactory({ facets: facetHostForManager(facetMgr), vfs: sqliteFs })(
          manifest, installRoot, binName, binKind,
        )(ctx);
      },
    );
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
            // The runtime name, which is what `nimbus install python` installs
            // — not the name the user typed. Left as 'python' through the
            // migration, this matched only the superseded Pyodide entry, so the
            // interpreter people actually install was never warmed and the
            // first invocation after installing paid the wasm compile.
            if (target.name !== 'cpython') return;
            ctx.stdout.write(`[${target.name}] warming runtime...\n`);
            const stdout = { write(_s: string) {} };
            const stderrText: string[] = [];
            const stderr = { write: (s: string) => { stderrText.push(String(s)); } };
            const py = await registry.resolve('python');
            if (py) {
              const pid = 'pid' in ctx ? ctx.pid : undefined;
              const setUmask = 'setUmask' in ctx ? ctx.setUmask : undefined;
              const runAs = 'runAs' in ctx ? ctx.runAs : undefined;
              if (
                typeof pid !== 'number'
                || typeof setUmask !== 'function'
                || typeof runAs !== 'function'
                || self.kernel === null
              ) {
                throw new Error('python warm-up requires a process identity');
              }
              const cred = requireVfsCred('cred' in ctx ? ctx.cred : undefined, 'python warm-up');
              const code = await py({
                ...ctx,
                args: ['-c', 'pass'],
                pid,
                cred,
                setUmask: (mask: number) => setUmask(mask),
                runAs: (targetCred, argv) => runAs(targetCred, argv),
                vfs: self.kernel.vfs,
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
    //   - --watch/--inspect/--inspect-brk routing via runFresh →
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
      run: (code, opts) => runFresh(facetMgr, code, opts),
      supportsBinSpawn: true,
    };
    {
      const oneShotNode = buildRuntimeHandler(nodeSpec, {
        vfs: sqliteFs,
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
    /** `scripts` from the cwd's package.json; empty when there is none. */
    const readPackageScripts = (cwd: string): Record<string, string> => {
      try {
        const pkg = JSON.parse(kernelFs.readFileString(cwd + '/package.json'));
        const scripts = pkg?.scripts;
        return scripts && typeof scripts === 'object' ? scripts : {};
      } catch {
        return {};
      }
    };

    const bunSpec: RuntimeSpec = {
      name: 'bun',
      version: BUN_VERSION,
      helpText:
        'Usage: bun [options] [script.[js|ts|tsx]] [args...]\n' +
        '       bun -e "code"\n' +
        '       bun install [pkg ...]\n' +
        '       bun run <script>\n\n' +
        'Bun-runtime shim provides Bun.file/Bun.write/\n' +
        'Bun.spawn/Bun.password/Bun.gunzip backed by Workers-native\n' +
        'primitives. Bun.serve / Bun.sql / Bun.S3 throw with supported alternatives.\n' +
        'Execution via DO Facets (isolated V8 isolate per call).',
      run: (code, opts) => runBunScript(facetMgr, code, opts),
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
        // bun run <target> — a package.json script, or a file.
        //
        // Real bun's precedence, and the reason this is not just a script
        // lookup: a path-shaped target (`./cli.ts`, `sub/x`, `.`) is ALWAYS
        // a file and never consults scripts, while a bare name checks
        // scripts first and only then falls back to a file. The file case
        // delegates to the standard runtime flow, so `bun run ./cli.ts`
        // and `bun cli.ts` execute through one path — TypeScript transform,
        // facet dispatch and all.
        run: async (ctx: any, _reg, runAsBun) => {
          const args: string[] = ctx.args || [];
          // bun's own run flags sit between the verb and the target.
          let targetIdx = 1;
          while (targetIdx < args.length && args[targetIdx].startsWith('-')) targetIdx++;
          const target = args[targetIdx];
          const cwd = normalizeVfsPath(ctx.cwd || '/home/user');
          const scripts = readPackageScripts(cwd);

          if (!target) {
            ctx.stdout.write('Usage: bun run [flags] <file or script>\n');
            const names = Object.keys(scripts);
            if (names.length) {
              ctx.stdout.write(`\npackage.json scripts (${names.length} found):\n\n`);
              for (const n of names) ctx.stdout.write(`  bun run ${n}\n    ${scripts[n]}\n\n`);
            }
            return 0;
          }

          const pathShaped = target === '.' || target === '..' || target.includes('/');
          const pkgScript = pathShaped ? undefined : scripts[target];
          if (pkgScript) {
            // Trailing args append to the script command; bun drops a single
            // `--` separator between the script name and them.
            const extra = args.slice(targetIdx + 1);
            if (extra[0] === '--') extra.shift();
            const command = extra.length ? `${pkgScript} ${extra.join(' ')}` : pkgScript;
            try {
              const shellResult = await shell.execute(command, {
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

          const resolved = resolveRuntimeScriptPath(kernelFs, cwd, target, {
            preferModuleField: true,
          });
          if (resolved === null) {
            ctx.stderr.write(
              pathShaped
                ? `error: Module not found "${target}"\n`
                : `error: Script not found "${target}"\n`,
            );
            return 1;
          }
          return runAsBun([...args.slice(1, targetIdx), '/' + resolved, ...args.slice(targetIdx + 1)]);
        },
      },
    };
    {
      const oneShotBun = buildRuntimeHandler(bunSpec, {
        vfs: sqliteFs,
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

    // ── wasm-runner: native WebAssembly, on this session's facet host ──
    //
    // Bytes ride INSIDE the inner worker's code blob, the one phase where
    // workerd permits wasm code generation; request-time
    // WebAssembly.instantiate(bytes) is CSP-blocked and avoided.
    //
    // wasm-csp/findings.md — add(3,4)===7 in 11ms warm against the
    // deployed Cloudflare fleet.
    //
    // Lazy: the wasm-runner module (WASI instance preamble + snapshot
    // machinery) is imported on first `wasm-runner` invocation and the
    // built handler memoized, so its module-eval cost stays off the cold
    // Worker Startup Time path.
    {
      let wasmHandler: ((ctx: any) => Promise<number>) | null = null;
      registry.register('wasm-runner', async (ctx: any): Promise<number> => {
        if (!wasmHandler) {
          const { wasmRunnerSpec } = await import('@nimbus-sh/core/runtime/wasm-runner.js');
          const { loaderFacetHost } = await import('../runtime/facet-loader-host.js');
          const wasmSpec: RuntimeSpec = wasmRunnerSpec({
            // filesystem WASI: extended VFS surface for WASI file-IO. The
            // wasm-runner snapshots a session subtree into the facet, flushes
            // the diff back via this surface after _start returns.
            vfs: sqliteFs,
            facets: loaderFacetHost(self.env, self.ctx),
            processes: self.processes,
          });
          wasmHandler = buildRuntimeHandler(wasmSpec, {
            vfs: sqliteFs,
            getEsbuild: () => {
              if (!self.esbuildService) {
                self.ensureSqliteFs();
                self.esbuildService = new EsbuildService(self.sqliteFs!);
              }
              return self.esbuildService!;
            },
            registry,
          });
        }
        return await wasmHandler(ctx);
      });
    }

    kernel.routeLoopback = (port, request) => routeSessionLoopback(self as any, port, request);

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
          code = kernelFs.readFileString(filePath);
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
            if (parent && !kernelFs.exists(parent)) kernelFs.mkdir(parent, { recursive: true });
            kernelFs.writeFile(outPath, result.code);
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
          if (parent && !kernelFs.exists(parent)) kernelFs.mkdir(parent, { recursive: true });
          kernelFs.writeFile(outPath, f.contents);
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
        if (kernelFs.exists(cfgPath)) {
          try {
            let cfgCode = kernelFs.readFileString(cfgPath);
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
          origHtml = kernelFs.readFileString(htmlPath);
          const htmlEntrypoint = await findHtmlScriptEntrypoint(origHtml);
          if (htmlEntrypoint) entryPoint = cwd + '/' + stripLeadingSlashes(htmlEntrypoint);
        } catch { ctx.stderr.write('Warning: no index.html\n'); }
        if (!kernelFs.exists(entryPoint)) {
          const alts = [cwd+'/src/main.tsx', cwd+'/src/main.ts', cwd+'/src/index.tsx', cwd+'/src/index.ts'];
          entryPoint = alts.find(p => kernelFs.exists(p)) || entryPoint;
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
            if (!kernelFs.exists(nmDir + '/' + pkgBase)) {
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
          kernelFs.mkdir(distDir + '/assets', { recursive: true });
          kernelFs.writeFile(jsPath, jsContent);
          ctx.stdout.write('  \x1b[2m' + outDir + '/assets/' + jsFilename + '\x1b[0m  ' + (jsContent.length / 1024).toFixed(2) + ' kB\n');

          // Collect all CSS files from src/
          let allCss = '';
          const collectCss = (dir: string) => {
            try {
              for (const e of kernelFs.readdir(dir)) {
                const fp = dir + '/' + e.name;
                if (e.type === 'directory') collectCss(fp);
                else if (e.name.endsWith('.css')) {
                  try { allCss += kernelFs.readFileString(fp) + '\n'; } catch {}
                }
              }
            } catch {}
          };
          collectCss(cwd + '/src');
          const cssFilename = 'index-' + hash + '.css';
          if (allCss.trim()) {
            kernelFs.writeFile(distDir + '/assets/' + cssFilename, allCss);
            ctx.stdout.write('  \x1b[2m' + outDir + '/assets/' + cssFilename + '\x1b[0m  ' + (allCss.length / 1024).toFixed(2) + ' kB\n');
          }

          // Generate dist/index.html
          if (origHtml) {
            const distHtml = await rewriteViteBuildHtml(origHtml, {
              jsFilename,
              cssFilename: allCss.trim() ? cssFilename : undefined,
              removeImportMap: cdnPackages.length === 0,
            });
            kernelFs.writeFile(distDir + '/index.html', distHtml);
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
        if (!kernelFs.exists(distRoot)) {
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
          self.portRegistry.bindFacetStub(previewProcEntry.pid, previewStub);
          self.portRegistry.register(previewPort, previewProcEntry.pid);
          self._viteShimPid = previewProcEntry.pid;
          self._viteShimPort = previewPort;
        } catch {}
        try { await self.ctx.storage.put(VITE_CONFIG_KEY, { root: distRoot, basePath: previewBasePath, port: previewPort }); } catch {}
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
        await self.ctx.storage.put(VITE_CONFIG_KEY, {
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
      self.portRegistry.bindFacetStub(viteProcEntry.pid, viteStub);
      self.portRegistry.register(resolvedPort, viteProcEntry.pid);
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
        const unsupportedFields = detectUnsupportedWranglerConfig(kernelFs, vfsRoot);

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
          vfs: kernelFs,
          vfsEvents: sqliteFs.events,
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
      if (!kernelFs.exists(pkgJsonPath)) {
        kernelFs.writeFile(pkgJsonPath, '{"name":"project","version":"1.0.0","dependencies":{}}\n');
      }

      ctx.stdout.write('\x1b[36mNimbus npm v2 (batched writes)\x1b[0m\n');

      self.ensureNpmInstaller((msg: string) => {
        ctx.stdout.write('[npm] ' + msg + '\n');
      });
      const result = await self.npmInstaller!.install(cwd, { packages, pid: ctx.pid });

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

    // Primitive #7: patch NIMBUS_SESSION_ID into the live shell env.
    // sessionBasePath is "/s/<sid>" set by the X-Nimbus-Base header on
    // the first /ws upgrade — by the time initSession runs (after the
    // ws handshake), it's populated. Older /ws-pre-base callers see
    // an empty string, which is the safe placeholder (no false id).
    //
    // We patch the live env (not the overlay the workspace was built
    // from) so persisted shell state on warm-rejoin still picks up the
    // SAME session id — the DO's name is stable across hibernation
    // cycles. Any user `export NIMBUS_SESSION_ID=...` would have been
    // persisted to persisted.env and the overlay's spread would have
    // overridden the empty placeholder; we only set when the live env
    // is empty (don't clobber a user-set value).
    const sessionIdFromBase = (self.sessionBasePath || '').replace(/^\/s\//, '');
    if (sessionIdFromBase) {
      // Shell.env is declared private but mutable at runtime — there's
      // no public setter. We `any`-cast deliberately; the alternative
      // (replacing the whole Shell after construction) would lose the
      // kernel + registry wiring. Anti-req note: this is NOT a defensive
      // cast, it's a deliberate single-write operation to plug the
      // contract gap that env-construction couldn't fill (sessionBasePath
      // wasn't yet hydrated when the workspace was composed).
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
    const shellExecute = async (cmd: string, cmdCtx: CommandContext): Promise<number> => {
      const stdin = cmdCtx.stdin && cmdCtx.stdin !== cmdCtx.terminalStdin
        ? await cmdCtx.stdin.readAll()
        : undefined;
      const result = await shell.execute(cmd, {
        cwd: cmdCtx.cwd,
        env: cmdCtx.env,
        onStdout: (d: string) => cmdCtx.stdout.write(d),
        onStderr: (d: string) => cmdCtx.stderr.write(d),
        stdin,
        terminalStdin: cmdCtx.terminalStdin,
        // `npm run x` runs x on npm's own fds. Handing the nested execution a
        // sink without saying where that sink leads would make every fd look
        // redirected, and a runtime whose stdout is redirected stops streaming.
        terminalFds: {
          stdin: cmdCtx.isFdTerminal?.(0) ?? false,
          stdout: cmdCtx.isFdTerminal?.(1) ?? false,
          stderr: cmdCtx.isFdTerminal?.(2) ?? false,
        },
        commandContext: {
          pid: cmdCtx.pid,
          cred: cmdCtx.cred,
          setUmask: cmdCtx.setUmask,
        },
        runAs: runAsProcess,
      });
      return result.exitCode;
    };
    const shellEntrypointExecutor = {
      execute: async (cmd, options) => {
        const parentPid = options?.commandContext?.['pid'];
        if (typeof parentPid !== 'number') {
          throw new Error('shell entrypoint requires a parent process');
        }
        const childProcess = self.processes.spawn(
          'sh',
          ['sh'],
          options?.cwd || '/home/user',
          { parentPid },
        );
        let exitCode = 1;
        try {
          const identity = commandIdentityFor(childProcess.pid);
          const kernel = self.kernel;
          if (kernel === null) throw new Error('shell kernel is not initialized');
          const terminal = createHeadlessTerminal();
          const childShell = new Shell(
            terminal,
            kernel.vfs,
            registry,
            { ...env, ...(options?.env || {}) },
            processRegistry,
            identity,
          );
          installShellExecutionFeatures(childShell, terminal);
          if (options?.cwd) childShell.setCwd(options.cwd);
          const result = await childShell.execute(cmd, {
            ...options,
            commandContext: {
              ...options?.commandContext,
              pid: identity.pid,
              cred: identity.cred,
              setUmask: identity.setUmask,
            },
            runAs: runAsProcess,
          });
          exitCode = result.exitCode;
          return result;
        } finally {
          self.processes.exit(childProcess.pid, exitCode);
        }
      },
    } satisfies ShellEntrypointExecutor;
    registerShellEntrypointCommands(registry, shellEntrypointExecutor, kernelFs);

    // Shell scripts that execute through the local shell still need the same
    // process-table and log-store contract as facet-backed processes.
    const shellExecuteTracked = async (
      cmd: string,
      cmdCtx: CommandContext,
      opts: { longRunning?: boolean } = {},
    ): Promise<number> => {
      const entry = self.processes.spawn(
        cmd,
        [cmd],
        cmdCtx.cwd || '/home/user',
        { parentPid: cmdCtx.pid },
      );
      const pid = entry.pid;
      if (opts.longRunning) self.processes.setLongRunning(pid);
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
        type: 'spawn', pid, command: cmd, longRunning: !!opts.longRunning, attachedTty: false,
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
          // The tee is a sink, not a redirection: the script's fds are still
          // whatever the caller's were, and a runtime asks that question before
          // deciding whether it may stream past the shell.
          terminalFds: {
            stdin: cmdCtx.isFdTerminal?.(0) ?? false,
            stdout: cmdCtx.isFdTerminal?.(1) ?? false,
            stderr: cmdCtx.isFdTerminal?.(2) ?? false,
          },
          // Single spawn path for long-running handoff: a registry command
          // (vite/wrangler/serve) ADOPTS this wrapper pid via the bin-spawn
          // contract instead of allocating a second one, and suppresses its
          // own `[started (long-running)]` notice.
          commandContext: {
            pid,
            cred: entry.cred,
            setUmask: (mask: number) => self.processes.setUmask(pid, mask),
            ...(opts.longRunning
              ? {
                __nimbusBinSpawn: {
                  skipSpawn: true,
                  callerPid: pid,
                  command: cmd,
                  forceLongRunning: true,
                },
              }
              : {}),
          },
          runAs: runAsProcess,
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
      vfs: kernelFs,
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
            const pkg = JSON.parse(kernelFs.readFileString(pkgPath));
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
          const pkg = JSON.parse(kernelFs.readFileString(pkgPath));
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
            const guard = checkNodeModulesGuard(kernelFs, cwdKey);
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
          const pkg = JSON.parse(kernelFs.readFileString(pkgPath));
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
              const installed = JSON.parse(kernelFs.readFileString(nmDir + '/' + name + '/package.json'));
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
        if (kernelFs.exists(pkgPath) && !args.includes('-y') && !args.includes('--yes')) {
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
        kernelFs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
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
              for (const e of kernelFs.readdir(dir)) {
                const fp = dir + '/' + e.name;
                if (e.type === 'directory') deleteRecursive(fp);
                else try { kernelFs.unlink(fp); } catch {}
              }
              try { kernelFs.rmdir(dir); } catch {}
            } catch {}
          };
          deleteRecursive(pkgDir);
          ctx.stdout.write('removed ' + pkg + '\n');
        }
        // Update package.json
        const pkgPath = cwdKey + '/package.json';
        try {
          const pkgJson = JSON.parse(kernelFs.readFileString(pkgPath));
          for (const pkg of packages) {
            delete pkgJson.dependencies?.[pkg];
            delete pkgJson.devDependencies?.[pkg];
          }
          kernelFs.writeFile(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n');
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
        if (globalPrefix) self.ensureGlobalPrefixDirs(globalPrefix);
        const installCwd = globalPrefix ? `${globalPrefix}/lib` : cwdKey;

        // Ensure package.json exists for bare `npm install`
        if (!globalPrefix && explicitPkgs.length === 0) {
          const pkgJsonPath = installCwd + '/package.json';
          if (!kernelFs.exists(pkgJsonPath)) {
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

        // `--loglevel` selects npm's own log protocol on stderr, where npm
        // writes it. Tooling that drives npm parses those lines rather than
        // our prose — pi's installer advances its progress label off them.
        const npmLogLevel = installInvocation.loglevel;
        const npmLog = npmLogLevel === null ? undefined : (
          (level: NpmLogLevel, line: string) => {
            if (npmLogEnabled(npmLogLevel, level)) ctx.stderr.write(line + '\n');
          }
        );

        try {
          const result = await self.npmInstaller!.install(installCwd, {
            packages: explicitPkgs.length > 0 ? explicitPkgs : undefined,
            production: installInvocation.production,
            pid: ctx.pid,
            npmLog,
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
          if (globalPrefix) {
            // Materialize on-PATH bin shims even for partial installs. The
            // only writer of shims into ${globalPrefix}/bin used to be gated
            // behind zero failures across the whole dependency tree — but a
            // global install of a 100+-dep package almost always has at least
            // one transitive failure, so /usr/local/bin was ~never created
            // and the installed package's bin was unreachable. materialize →
            // validateEntry → resolveExistingTarget already skips bins whose
            // target file didn't land, so a partial install safely exposes
            // exactly the bins that actually installed.
            const linked = materializeNpmBinShims(
              kernelFs,
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
        self.sqliteFs!.as(requireVfsCred('cred' in ctx ? ctx.cred : undefined, 'npx')),
        ctx.cwd || '/home/user',
        npxArgs,
        (msg: string) => ctx.stdout.write(msg + '\n'),
        ctx.pid,
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
        ctx.stdout.write(`  \x1b[33m${'---'.padStart(pidWidth)}\x1b[0m  \x1b[32mrunning\x1b[0m                     vite dev server (${self.viteBasePath}/)\n`);
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
            try { await self.ctx.storage.delete(VITE_CONFIG_KEY); } catch {}
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
        const motd = kernelFs.readFileString('etc/motd');
        self.terminal.write(motd + '\r\n');
      } catch {}

      // ── Starter-app hint (only if seed sentinel still exists) ──
      // We check the live VFS, not a static file, so that if the user
      // deletes ~/.nimbus-seeded (or ~/app) the hint stops appearing on
      // next login.
      try {
        if (hasSeededProject(self.sqliteFs!) && kernelFs.exists(SEED_PROJECT_DIR)) {
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
          if (!kernelFs.exists(pkgPath)) return;
          const pkg = JSON.parse(kernelFs.readFileString(pkgPath));
          const files = new Set<string>();
          try {
            for (const e of kernelFs.readdir(projDir)) files.add(e.name);
          } catch {}
          const fileContents: Record<string, string> = {};
          for (const c of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
            if (files.has(c)) {
              try { fileContents[c] = kernelFs.readFileString(projDir + '/' + c); } catch {}
            }
          }
          const { detectFramework, describeDetect } = await import('@nimbus-sh/core/runtime/framework-detect.js');
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
    //
    // Now, and not inside the workspace, because the login files are the
    // user's and may name any of the commands registered above. Not awaited:
    // `shell.start()` runs synchronously and the rc files apply as they
    // finish, which is what the terminal has always done. A user's broken
    // rc file must not take the socket down with it.
    workspace.start().catch((e: any) => {
      console.warn('[nimbus] shell start failed:', e?.message || e);
    });

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
