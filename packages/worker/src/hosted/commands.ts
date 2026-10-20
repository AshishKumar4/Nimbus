import { Shell, createCurlCommand, createNpmCommand, createTopCommand, createWatchCommand, createHelpCommand } from '@nimbus-sh/core/substrate/lifo/index.js';
import { createKillCommand, type HostProcessSignals } from '@nimbus-sh/core/substrate/lifo/commands/system/kill.js';
import { installSummary } from '@nimbus-sh/core/substrate/lifo/commands/system/npm-log.js';
import { signalAbortReason, signalDisposition } from '@nimbus-sh/core/substrate/lifo/shell/signals.js';
import type { Command, CommandContext } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
import type { ShellCommandIdentity } from '@nimbus-sh/core/substrate/lifo/shell/Shell.js';
import { outputHooks } from '@nimbus-sh/core/_shared/byte-stream.js';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { BASH_RUNNER_CONTRACTS, CPYTHON_RUNNER_CONTRACTS, GIT_RUNNER_CONTRACTS, CRED_KERNEL, CRED_SESSION_USER, requireVfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { engineKey, ProcessView } from '@nimbus-sh/core/runtime/process-files.js';
import { handKernelArtifact, projectFs } from '../runtime/project-fs.js';
import { makeEsbuildCommand } from '@nimbus-sh/core/runtime/esbuild-cli.js';
import { runEsbuildCli, supervisorEsbuildService } from '../facets/esbuild-transform.js';
import { prewarmBuildFacet } from '../facets/build-facet.js';
import { runFresh } from '../runtime/node-runner.js';
import { runBunScript, BUN_VERSION } from '../runtime/bun-runner.js';
import { buildRuntimeHandler, resolveRuntimeScriptPath, type RuntimeSpec } from '@nimbus-sh/core/runtime/runtime-registry.js';
import { jsReplProgram } from '@nimbus-sh/core/runtime/js-repl.js';
import { resolveContext } from '@nimbus-sh/core/substrate/lifo/commands/registry.js';
import { normalizeVfsPath, resolveVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { NimbusWrangler } from '../wrangler/nimbus-wrangler.js';
import { loaderCodeRegistry } from '../wrangler/loader-code-store.js';
import { filterWranglerFlags, detectBundlerBin, checkNodeModulesGuard, detectUnsupportedWranglerConfig, refusedNextSubcommand, NEXT_REFUSAL_MESSAGE } from '../session/helpers.js';
import { createViteCommand } from '../session/vite-command.js';
import { HeredocHandler, LineEditorExtender } from '@nimbus-sh/core/shell/features.js';
import { registerShellEntrypointCommands, type ShellEntrypointExecutor } from '@nimbus-sh/core/shell/shell-entrypoints.js';
import { makeChshCommand } from '@nimbus-sh/core/substrate/lifo/shell/default-shell.js';
import { installNpmBinFallbackResolver } from '../shell/npm-bin-entrypoints.js';
import { createNpmInstallPort } from '../session/npm-install-port.js';
import { createRuntimeCommandHintResolver } from '../runtime/package-manager.js';
import { rpcExposeApp, rpcListApps, rpcRemoveApp, rpcRotateLink } from '../session/programmatic.js';
import { listInstalledRuntimes, type RunnerFactory } from '@nimbus-sh/core/runtime/installed-runtimes.js';
import type { ClangRunnerFactory } from '@nimbus-sh/core/runtime/clang-runner.js';
import type { CPythonRunnerFactory } from '@nimbus-sh/core/runtime/cpython-runner.js';
import type { RubyRunnerFactory } from '@nimbus-sh/core/runtime/ruby-runner.js';
import { notifyTerminalEvent } from '../runtime/process-logs-api.js';
import { stripAnsi, type LogChunk } from '@nimbus-sh/core/runtime/process-logs.js';
import { DEFAULT_HOME, NODE_VERSION, NPM_VERSION } from '@nimbus-sh/core/constants.js';
import { afterDevServerRestore, devServerProcess, recordDevServer, spawnOf } from '../session/dev-servers.js';
import type { SessionInternal } from '../session/internal.js';

import { HeadlessTerminal } from '@nimbus-sh/core/substrate/lifo/index.js';
import type { RuntimeCatalogEnv } from '../runtime/runtime-catalog.js';
import { makeNimbusVerbHandler } from '@nimbus-sh/core/runtime/nimbus-command.js';

/** Internal runtime services; callers use composeHostedRuntime, not this recipe. */
export type RuntimeCommandHost = Pick<SessionInternal,
  '_emitShellExecDone' | '_setCpRegistry' | '_viteShimPid' | '_viteShimPort' | 'cirrusReal' | 'ensureFacetManager' | 'facetManager' | 'ensureNpmInstaller' | 'ensureSqliteFs' | 'esbuildService' | 'nimbusWrangler' | 'portRegistry' | 'processEnv' | 'processes' | 'restoreDevServers' | 'sessionBasePath' | 'terminal' | 'viteBasePath' | 'viteDevServer' | 'wranglerAliasBannerShown'
> & {
  readonly ctx: DurableObjectState;
  readonly env: RuntimeCatalogEnv;
  routeLoopback: SessionInternal['routeLoopback'];
  ensureGlobalPrefixDirs: SessionInternal['ensureGlobalPrefixDirs'];
  _ensureChildProcessManager: SessionInternal['_ensureChildProcessManager'];
};

export async function registerHostedCommands(self: RuntimeCommandHost, workspace: NimbusWorkspace): Promise<void> {
  const sqliteFs = workspace.vfs;
  // The nimbus verb's runtime installs are Nimbus's own system state.
  const kernelFs = sqliteFs.as(CRED_KERNEL);
  // The build service's default view, for a build that names none: the
  // session's user, never the kernel. A command's own build names its view.
  const ownerFs = workspace.filesystem.namespaceFs(CRED_SESSION_USER);
  const kernel = workspace.kernel;
  const shell = workspace.shell;
  const registry = workspace.registry;
  const env = workspace.env;
  const terminal = self.terminal;
  if (!terminal) throw new Error('runtime terminal is not initialized');
  const facetMgr = self.ensureFacetManager().manager;
  const runAsProcess = shell.getRunAsHost();
  const commandIdentityFor = (pid: number): ShellCommandIdentity => ({
    pid,
    get cred() { return self.processes.cred(pid); },
    setUmask: (mask) => self.processes.setUmask(pid, mask),
    runAs: runAsProcess,
  });
  // `kill` is the shell's builtin; the session's processes past its jobs
  // (resident servers, the vite shim, another shell's jobs) are reached
  // through here, and their teardown releases what they hold.
  const hostSignals: HostProcessSignals = {
    isLive: (pid) => self._viteShimPid === pid || self.processes.get(pid)?.state === 'running',
    async signal(pid, signal, stderr, caller) {
      if (!self.processes.maySignal(caller, pid)) return 'not-permitted';
      if (signal === '0') return 'delivered';
      // The terminal's shell outlives every line it runs.
      if (pid === workspace.shellProcessPid) return 'not-permitted';
      const disposition = signalDisposition(signal);
      // A default-ignored signal to a process of the session's own (a shell's
      // job, an exec) does nothing, as on Linux; a resident's program may
      // handle it, which nothing here can deliver.
      if (disposition === 'ignore' && self._viteShimPid !== pid && !facetMgr.hasResidentProcess(pid)) return 'delivered';
      // Ending one is the only thing a resident's teardown can do: it has no
      // stop, continue or handler delivery behind it.
      if (disposition !== 'terminate') return 'unsupported';
      // A dev server the session runs ends with its process (bindDevServer).
      return facetMgr.kill(pid, signal, signalAbortReason(signal)) ? 'delivered' : 'no-such-process';
    },
  };
  shell.setHostProcessSignals(hostSignals);

self._setCpRegistry(registry);

registry.register('chsh', makeChshCommand({
  isBashInstalled: async () =>
    (await listInstalledRuntimes(sqliteFs)).some((runtime) => runtime.name === 'bash'),
}));

// ── Git integration (isomorphic-git) ──
// ctx + env are passed for clone/fetch/pull which run in a facet to avoid
// exhausting the supervisor DO's CPU budget on large repos. The command
// module (+ its ~106 KB network-facet dependency) is loaded lazily on the
// first `git` invocation so it stays out of the cold script-eval graph.
// The one `git`: with real git installed (below), the same command, routing
// what it lacks there (git/routing.ts).
const runGit = async (ctx: CommandContext, realGit?: Command): Promise<number> => {
  const { runGitCommand } = await import('../git/commands.js');
  return runGitCommand(ctx, sqliteFs, self.ctx, self.env, workspace.network, workspace.filesystem, self.processes,
    realGit === undefined ? undefined : () => realGit(ctx));
};
registry.registerBuiltin('git', (ctx) => runGit(ctx));
const remoteHelper: Command = async (ctx) => {
  const [{ runRemoteHelper }, { createRemoteEngine }, { createLocalGit }, { pulledStdinReader, stdinBytesOf }] = await Promise.all([
    import('../git/remote-helper.js'), import('../git/engine.js'), import('../git/local-git.js'), import('@nimbus-sh/core/shell/stdin-adapter.js'),
  ]);
  const stdinBytes = ctx.stdin === undefined ? { readBytes: async () => null } : stdinBytesOf(ctx.stdin);
  const stdin = pulledStdinReader(() => stdinBytes.readBytes(65536));
  return runRemoteHelper({
    args: ctx.args, env: ctx.env, cwd: ctx.cwd,
    readLine: async () => stdin?.readLine ? stdin.readLine() : null,
    stdout: (text) => ctx.stdout.write(text),
    stderr: (text) => ctx.stderr.write(text),
    async readFile(path) {
      try { return await ctx.vfs.readFile(path); }
      catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
        throw error;
      }
    },
  }, createRemoteEngine({ ctx: self.ctx, env: self.env, pid: ctx.pid, network: workspace.network, signal: ctx.signal }),
  createLocalGit(self._ensureChildProcessManager(), ctx));
};
registry.registerBuiltin('git-remote-http', remoteHelper);
registry.registerBuiltin('git-remote-https', remoteHelper);

// ── runtime package manager: `nimbus install` package manager + runner registry.
//
// 1. Register the clang-runner factory FIRST so the rehydration step
//    below can re-bind `clang` / `wasm-ld` from an already-installed
//    manifest.
// 2. Register the `nimbus` shell verb (install/uninstall/list/available).
// 3. Rehydrate any previously-installed runtimes from VFS so their
//    bins reappear in the registry after DO eviction or WS reconnect.
// Real git (git.wasm), one WASI process per invocation: core runtime/git-runner.ts.
// Its `git` is the built-in one above with real git behind it; uninstalled,
// the built-in answers alone again. The image cache is incarnation-local;
// fsmonitor issued-token provenance is durable host metadata so a wake can
// keep the VFS revision token.
// Each runner key's build, on its own contract (GIT_RUNNER_CONTRACTS).
for (const [key, contract] of Object.entries(GIT_RUNNER_CONTRACTS)) {
  let gitFactory: Promise<RunnerFactory> | null = null;
  workspace.runtimes.registerRunner(
    key,
    (manifest, installRoot, binName, binKind) => {
      let handler: Promise<Command> | null = null;
      const realGit: Command = async (ctx) => {
        gitFactory ??= (async () => {
          const { makeGitRunnerFactory } = await import('@nimbus-sh/core/runtime/git-runner.js');
          const { sqliteGitFsmonitorState } = await import('@nimbus-sh/core/runtime/git-fsmonitor.js');
          const { facetHostForManager } = await import('../runtime/facet-loader-host.js');
          return makeGitRunnerFactory({
            facets: facetHostForManager(facetMgr), filesystem: workspace.filesystem, processes: self.processes,
            fsmonitorState: sqliteGitFsmonitorState(self.ctx.storage.sql, workspace.filesystem.namespace),
            session: self.ctx.id.toString(),
            ...contract,
          });
        })().catch((error) => { gitFactory = null; throw error; });
        handler ??= gitFactory.then((factory) => factory(manifest, installRoot, binName, binKind))
          .catch((error) => { handler = null; throw error; });
        return (await handler)(ctx);
      };
      return binName === 'git' && binKind === undefined ? (ctx) => runGit(ctx, realGit) : realGit;
    },
  );
}
let clangFactory: Promise<ClangRunnerFactory> | null = null;
workspace.runtimes.registerRunner(
  'clang-runner',
  (manifest, installRoot, binName, binKind) => async (ctx: CommandContext) => {
    // One factory per session: it holds the session's warm clang and wasm-ld workers' keys.
    clangFactory ??= (async () => {
      const { makeClangRunnerFactory } = await import('@nimbus-sh/core/runtime/clang-runner.js');
      const { facetHostForManager } = await import('../runtime/facet-loader-host.js');
      return makeClangRunnerFactory({ facets: facetHostForManager(facetMgr), filesystem: workspace.filesystem, processes: self.processes, session: self.ctx.id.toString() });
    })().catch((error) => { clangFactory = null; throw error; });
    return await (await clangFactory)(manifest, installRoot, binName, binKind)(ctx);
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
const cpythonFactories = new Map<boolean, Promise<CPythonRunnerFactory>>();
const cpython = (restartsWaits: boolean): RunnerFactory => (manifest, installRoot, binName, binKind) => async function pythonReplOrOneShot(ctx: CommandContext): Promise<number> {
  const argv: string[] = ctx.args || [];
  // No args at all → REPL session. Hand off to runPythonRepl
  // which builds its own IsolatePool (separate from the
  // one-shot dispatch's pool) and drives a ReplSession.
  if (argv.length === 0 && terminal) {
    const { runPythonRepl } = await import('../runtime/python-repl.js');
    return await runPythonRepl({
      facetMgr,
      authority: workspace.filesystem,
      terminal: terminal,
      installRoot,
      home: ctx.env?.HOME || shell.getEnv().HOME || DEFAULT_HOME,
      manifest,
      // REPL-R7-1: thread the shell so ReplSession can drain
      // shell.pasteQueue on attach (multi-line WS frames like
      // `python\nexit(7)` would otherwise drop the tail input).
      shell: shell,
      // The supervisor derives the write credential from this; without
      // it the prompt cannot write to the session filesystem.
      pid: ctx.pid,
      cred: requireVfsCred(ctx.cred, 'Python REPL'),
      restartsWaits,
      start: { cwd: ctx.cwd || shell.getCwd(), binName },
    });
  }
  // Args present (one-shot mode: -c, script, -m, -). Fall through to the
  // canonical handler, one per runner contract for the session (imported
  // lazily on first use): it holds the session's warm CPython workers' keys.
  let factory = cpythonFactories.get(restartsWaits);
  if (!factory) {
    factory = (async () => {
      const { makeCPythonRunnerFactory } = await import('@nimbus-sh/core/runtime/cpython-runner.js');
      const { facetHostForManager } = await import('../runtime/facet-loader-host.js');
      const { cpythonResidentStart } = await import('../runtime/cpython-resident.js');
      return makeCPythonRunnerFactory({
        facets: facetHostForManager(facetMgr),
        filesystem: workspace.filesystem,
        processes: self.processes,
        startResident: cpythonResidentStart(facetMgr),
        network: workspace.network,
        restartsWaits,
        session: self.ctx.id.toString(),
      });
    })();
    factory.catch(() => cpythonFactories.delete(restartsWaits));
    cpythonFactories.set(restartsWaits, factory);
  }
  return await (await factory)(manifest, installRoot, binName, binKind)(ctx);
};
// Each runner key's build, on its own contract (CPYTHON_RUNNER_CONTRACTS).
for (const [key, { restartsWaits }] of Object.entries(CPYTHON_RUNNER_CONTRACTS)) workspace.runtimes.registerRunner(key, cpython(restartsWaits));
// Ruby v1 — Ruby 3.3.4 via ruby.wasm 2.9.3-2.9.4. Same architecture
// as python-runner: ruby+stdlib.wasm rides via LOADER modules-map; each
// one-shot boots a VM of its own on the session's warm Ruby workers (one
// factory per session, which holds their keys). See
// src/runtime/ruby-runner.ts +
//
// REPL Stream A: wrap the one-shot factory so `ruby` with NO args
// drops into an interactive REPL. The wrap is purely additive —
// args-bearing invocations pass through to the existing handler.
let rubyFactory: Promise<RubyRunnerFactory> | null = null;
workspace.runtimes.registerRunner(
  'ruby-runner',
  (manifest, installRoot, binName, binKind) => async function rubyReplOrOneShot(ctx: any): Promise<number> {
    const argv: string[] = ctx.args || [];
    if (argv.length === 0 && terminal) {
      const { runRubyRepl } = await import('../runtime/ruby-repl.js');
      return await runRubyRepl({
        facetMgr,
        authority: workspace.filesystem,
        terminal: terminal,
        installRoot,
        // The caller's filesystem and credential, from its working directory.
        pid: ctx.pid,
        cred: requireVfsCred(ctx.cred, 'Ruby REPL'),
        home: ctx.env?.HOME || shell.getEnv().HOME || DEFAULT_HOME,
        cwd: ctx.cwd || shell.getCwd(),
        binName,
      });
    }
    rubyFactory ??= (async () => {
      const { makeRubyRunnerFactory } = await import('@nimbus-sh/core/runtime/ruby-runner.js');
      const { facetHostForManager } = await import('../runtime/facet-loader-host.js');
      const { rubyResidentStart } = await import('../runtime/ruby-resident.js');
      return makeRubyRunnerFactory({
        facets: facetHostForManager(facetMgr),
        filesystem: workspace.filesystem,
        processes: self.processes,
        registry,
        startResident: rubyResidentStart(facetMgr),
        getHome: () => workspace.shell.getEnv().HOME ?? DEFAULT_HOME,
        network: workspace.network,
        session: self.ctx.id.toString(),
      });
    })().catch((error) => { rubyFactory = null; throw error; });
    const runner = await (await rubyFactory)(manifest, installRoot, binName, binKind);
    return runner(ctx);
  },
);
// GNU bash 5.2.37 (wasm32-wasi, asyncified) — dedicated facet
// runner driving the fork/pipe/exec/setjmp scheduler (fork M1-M3
// mechanisms). Interactive terminal invocations use the shared
// ReplSession line editor; -c, scripts, and piped stdin retain the
// canonical one-shot handler.
const bash: RunnerFactory = (manifest, installRoot, binName, binKind) => async (ctx: CommandContext) => {
  const argv = ctx.args || [];
  const explicitInteractive = argv.includes('-i');
  const terminalStdin = ctx.isFdTerminal?.(0) ?? !ctx.stdin;
  if (terminal && (explicitInteractive || (argv.length === 0 && terminalStdin))) {
    const { runBashRepl } = await import('../runtime/bash-repl.js');
    return await runBashRepl({
      facetMgr,
      authority: workspace.filesystem,
      terminal: terminal,
      installRoot,
      manifest,
      cred: ctx.cred,
      pid: ctx.pid,
      processes: self.processes,
      filesystem: workspace.filesystem.bind({ pid: ctx.pid, cred: ctx.cred, signal: ctx.signal }),
      env: ctx.env,
      cwd: ctx.cwd || '/home/user',
      shell: shell ?? undefined,
    });
  }
  const { makeBashRunnerFactory } = await import('@nimbus-sh/core/runtime/bash-runner.js');
  const { facetHostForManager } = await import('../runtime/facet-loader-host.js');
  return await makeBashRunnerFactory({ facets: facetHostForManager(facetMgr), filesystem: workspace.filesystem, processes: self.processes })(
    manifest, installRoot, binName, binKind,
  )(ctx);
};
for (const key of Object.keys(BASH_RUNNER_CONTRACTS)) workspace.runtimes.registerRunner(key, bash);
{
  // Cast registry to the minimal package-manager shape. CommandRegistry
  // CommandRegistry has register(name, handler) which matches.


  registry.register(
    'nimbus',
    makeNimbusVerbHandler({
      runtimes: workspace.runtimes,
      vfs: kernelFs,
      registry: registry,
      // The application verbs are the session's own (programmatic.ts):
      // the shell, the SDK and the Agent all reach the same policy.
      apps: {
        expose: (target, options) => rpcExposeApp(self as any, target, options),
        list: () => rpcListApps(self as any),
        rotateLink: (target) => rpcRotateLink(self as any, target),
        remove: (target) => rpcRemoveApp(self as any, target),
      },
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
          const pid = ctx.pid;
          const cred = requireVfsCred(ctx.cred, 'python warm-up');
          const code = await py({
            ...ctx,
            args: ['-c', 'pass'],
            pid,
            cred,
            setUmask: (mask: number) => ctx.setUmask(mask),
            runAs: (targetCred, argv, options) => ctx.runAs(targetCred, argv, options),
            vfs: new ProcessView(workspace.filesystem.bind({ pid, cred })),
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
          authority: workspace.filesystem,
          installRoot: target.root,
          home: ctx.env?.HOME || shell.getEnv().HOME || DEFAULT_HOME,
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
    const rehydration = await workspace.runtimes.rehydrate();
    if (rehydration.count > 0) {
      // Surface to terminal via the standard MOTD-style line so
      // users see what's been auto-rebound. Not an error path.
      terminal?.write?.(`\x1b[2m[nimbus] rehydrated ${rehydration.count} runtime bin(s): ${rehydration.bins.join(', ')}\x1b[0m\r\n`);
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
//   - G4 binSpawn ctx propagation (when a broker or launch wrapper set
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
  routesServers: true,
  nodeCommandLine: true,
  repl: jsReplProgram(`Welcome to Node.js ${NODE_VERSION}.\nType ".help" for more information.\n`),
};
{
  const nodeCommand = buildRuntimeHandler(nodeSpec, {
    getEsbuild: () => {
      if (!self.esbuildService) {
        self.ensureSqliteFs();
        self.esbuildService = supervisorEsbuildService(self.ctx, self.env, ownerFs);
      }
      return self.esbuildService!;
    },
    registry,
  });
  registry.register('node', nodeCommand);
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
// binSpawn ctx propagation (supportsBinSpawn): a .bin handler always
// dispatches through `node`, but a child_process broker or a background
// job hands Bun the pid it already allocated, as it hands Node's: the
// program runs as that pid, so its output reaches the parent's queues and
// it runs on that child's launch admission.
/** `scripts` from the cwd's package.json, read as the command's own view; empty when there is none. */
const readPackageScripts = async (vfs: ProcessView, cwd: string): Promise<Record<string, string>> => {
  try {
    const pkg = JSON.parse(await vfs.readFileString(`/${cwd}/package.json`));
    const scripts = pkg?.scripts;
    return scripts && typeof scripts === 'object' ? scripts : {};
  } catch {
    return {};
  }
};

/**
 * `bun install|i|add …` as npm's install: bun's own spellings that npm reads
 * otherwise (-p/--production, -d/--dev, --optional, --exact) said npm's way,
 * so npm's configuration (npm-config.ts) is the one reader of the rest.
 */
async function bunInstall(ctx: any, reg: any, verb: string): Promise<number> {
  const npmCmd = await reg.resolve('npm');
  if (!npmCmd) {
    ctx.stderr.write(`bun ${verb}: npm handler unavailable\n`);
    return 1;
  }
  const BUN_TO_NPM: Record<string, string> = { '-p': '--omit=dev', '--production': '--omit=dev', '-d': '--save-dev', '--dev': '--save-dev', '--optional': '--save-optional', '--exact': '--save-exact' };
  const args = (ctx.args || []).slice(1).map((arg: string) => BUN_TO_NPM[arg] ?? arg);
  return await npmCmd({ ...ctx, args: ['install', ...args] });
}

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
  supportsBinSpawn: true,
  routesServers: true,
  // Bun binds require, __filename and __dirname in an ES module.
  moduleScope: 'bun',
  repl: jsReplProgram(`Welcome to Bun v${BUN_VERSION}\nType ".help" for more information.\n`),
  subcommands: {
    // bun install / i / add → npm install (same VFS, same R2 caches).
    install: (ctx: any, reg) => bunInstall(ctx, reg, 'install'),
    i: (ctx: any, reg) => bunInstall(ctx, reg, 'i'),
    add: (ctx: any, reg) => bunInstall(ctx, reg, 'add'),
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
      const scripts = await readPackageScripts(ctx.vfs, cwd);

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
        const hooks = outputHooks(ctx);
        try {
          const shellResult = await shell.execute(command, {
            cwd: ctx.cwd,
            env: ctx.env,
            onStdout: hooks.onStdout,
            onStderr: hooks.onStderr,
            // The script runs as the process that ran `bun run`, as an
            // `npm run` script does, not as the workspace shell.
            commandContext: { pid: ctx.pid, cred: ctx.cred, setUmask: ctx.setUmask },
          });
          return shellResult.exitCode;
        } catch (e: any) {
          ctx.stderr.write(`bun run: ${e?.message ?? String(e)}\n`);
          return 1;
        } finally {
          await hooks.end();
        }
      }

      const resolved = (await resolveRuntimeScriptPath(ctx.vfs, cwd, target, {
        preferModuleField: true,
      }));
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
  const bunCommand = buildRuntimeHandler(bunSpec, {
    getEsbuild: () => {
      if (!self.esbuildService) {
        self.ensureSqliteFs();
        self.esbuildService = supervisorEsbuildService(self.ctx, self.env, ownerFs);
      }
      return self.esbuildService!;
    },
    registry,
  });
  registry.register('bun', bunCommand);
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
        filesystem: workspace.filesystem,
        facets: loaderFacetHost(self.env, self.ctx, workspace.network),
        processes: self.processes,
      });
      wasmHandler = buildRuntimeHandler(wasmSpec, {
        getEsbuild: () => {
          if (!self.esbuildService) {
            self.ensureSqliteFs();
            self.esbuildService = supervisorEsbuildService(self.ctx, self.env, ownerFs);
          }
          return self.esbuildService!;
        },
        registry,
      });
    }
    return await wasmHandler(ctx);
  });
}

kernel.routeLoopback = (port, request) => self.routeLoopback(port, request);

try {
  registry.register('curl', createCurlCommand(kernel));
} catch {}

// ── esbuild: the real esbuild CLI, in the session's esbuild facet ─────
// See @nimbus-sh/core runtime/esbuild-cli.ts.
registry.register('esbuild', makeEsbuildCommand({
  run: (args, ctx, output) => runEsbuildCli(self.ctx, self.env, ctx.pid, args, output),
}));

// ── vite command: start/stop the dev server ──────────────────────────
registry.register('vite', createViteCommand(self));

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
// The Worker dev server runs as a process of its own (devServerProcess), from
// before its start, and ends with it: `wrangler stop`, a `wrangler dev` that
// replaces it, a kill.
let wranglerPid: number | null = null;
const stopWranglerServer = (): boolean => {
  if (wranglerPid === null) return false;
  self.processes.exit(wranglerPid, 0);
  return true;
};
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

    // A start or stop comes after the restore of the servers the session ran before it restarted.
    if (args[0] === 'stop' || args[0] === 'dev') await afterDevServerRestore(self, self.processes, ctx);

    if (args[0] === 'stop') {
      if (stopWranglerServer()) {
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

    // Its first build waits on the build facet: start loading it now.
    prewarmBuildFacet(self.ctx, self.env);

    // First-run banner — only when invoked as `wrangler`, and only once
    // per session. Makes it OBVIOUS to the user that they're not running
    // real wrangler, and that Nimbus is doing something different.
    if (invokedAs === 'wrangler' && !self.wranglerAliasBannerShown) {
      ctx.stdout.write(
        '\x1b[2m\u2388  wrangler (Nimbus DO-in-DO mode) — bundling via rolldown, running via env.LOADER\x1b[0m\n',
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
      self.esbuildService = supervisorEsbuildService(self.ctx, self.env, ownerFs);
    }

    // Parse --root flag; default to the shell cwd so `npm run dev` from
    // a project directory picks up that project's wrangler.jsonc.
    let root = ctx.cwd || '/home/user';
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--root' && args[i + 1]) root = args[i + 1];
    }

    const rootPath = resolveVfsPath(root, ctx.cwd || '/home/user');
    // The dev server reads the Worker, and its KV/R2/D1 emulators keep
    // their data, through the engine, per request and after this command
    // has returned: at the project's engine key, which a mount has none of.
    const vfsRoot = await engineKey(ctx.vfs, sqliteFs, `/${rootPath}`);
    if (vfsRoot === null) {
      ctx.stderr.write(`${invokedAs}: the Worker dev server serves only projects on the workspace filesystem; /${rootPath} is on a mounted one\n`);
      return 1;
    }

    // The dev server before this one stops, a start still under way included:
    // left to finish, it would serve, watch and rebuild beside this one.
    stopWranglerServer();
    let starting = true;

    // Pre-flight: read the wrangler config ourselves and call out any
    // binding fields nimbus-wrangler can't provide. NimbusWrangler will
    // still try to bundle + load, but user sees up-front why their
    // Worker may fail when it tries to access a missing binding.
    const unsupportedFields = await detectUnsupportedWranglerConfig(ctx.vfs, `/${vfsRoot}`);

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

    // The dev server reads its config, migrations and stores, and bundles
    // its Worker, as the process that started it, for as long as it runs.
    const cred = requireVfsCred(ctx.cred, invokedAs);
    // Releases through worker 0.17.0 kept the KV and R2 stores as root: what
    // is still root's is handed to the project's owner (handKernelArtifact).
    // `.nimbus` alone, without what else is in it: in a HOME it holds the
    // kernel's runtime store too.
    await handKernelArtifact(workspace.filesystem, ctx.vfs, cred, `/${rootPath}/.nimbus`, { descend: false });
    for (const store of ['.nimbus/kv', '.nimbus/r2']) {
      await handKernelArtifact(workspace.filesystem, ctx.vfs, cred, `/${rootPath}/${store}`);
    }
    // The server's process: what `ps` lists, a kill ends (a start under way
    // included), and a new incarnation of the session runs again.
    const running: { pid: number | null; server: NimbusWrangler | null } = { pid: null, server: null };
    const started = devServerProcess(self.processes, invokedAs, ctx, () => {
      running.server?.stop();
      if (self.nimbusWrangler === running.server) self.nimbusWrangler = null;
      if (wranglerPid === running.pid) wranglerPid = null;
    });
    if (started === null) {
      ctx.stderr.write(`${invokedAs}: the process that ran it has ended\n`);
      return 1;
    }
    const { entry, adopted } = started;
    running.pid = wranglerPid = entry.pid;
    self.nimbusWrangler = running.server = new NimbusWrangler({
      // The dev server's Worker goes out through the network of the command that started it.
      network: workspace.network.forProcess(ctx.pid),
      vfs: sqliteFs.as(cred),
      bundleFs: workspace.filesystem.namespaceFs(cred),
      namespace: workspace.filesystem.vfs,
      esbuild: self.esbuildService!,
      env: self.env,
      // Supervisor DO ctx — required for ctx.facets.get() when
      // synthesizing durable_objects bindings on the inner Worker.
      ctx: self.ctx,
      loaderStore: loaderCodeRegistry(sqliteFs),
      root: vfsRoot,
      // While the command runs, its own stderr says why a start fails; after
      // it returns, rebuilds report to the terminal.
      onLog: (msg) => {
        if (starting) { ctx.stderr.write(msg); return; }
        self.processes.appendOutput(entry.pid, 'stderr', msg);
        if (terminal) {
          try { terminal.write(msg); } catch {}
        }
      },
      onHmrMessage: (msg) => {
        if (terminal) {
          try { terminal.ws?.send(JSON.stringify({ type: 'hmr', data: msg })); } catch {}
        }
      },
    });

    const server = self.nimbusWrangler;
    const ok = await server.start().finally(() => { starting = false; });
    if (!ok) {
      ctx.stderr.write(server.wasStopped
        ? '  \x1b[33mWorker dev server stopped before it started.\x1b[0m\n'
        : '  \x1b[31mFailed to start Worker dev server.\x1b[0m\n');
      // One handed to it ends with its caller's status.
      if (!adopted) self.processes.exit(entry.pid, 1);
      return 1;
    }
    await recordDevServer(self, entry.pid, { ...spawnOf(entry), env: ctx.env, root: vfsRoot });
    if (!adopted) {
      notifyTerminalEvent(terminal, { type: 'spawn', pid: entry.pid, command: entry.command, longRunning: true, attachedTty: false });
    }

    const cfg = server.stats;
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
    ctx.stdout.write('  \x1b[2mRun \x1b[0m' + invokedAs + ' stop\x1b[2m, or \x1b[0mkill ' + entry.pid + '\x1b[2m, to stop.\x1b[0m\n\n');
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
  const pkgJsonPath = `/${cwd}/package.json`;
  if (!await ctx.vfs.exists(pkgJsonPath)) {
    await ctx.vfs.writeFile(pkgJsonPath, '{"name":"project","version":"1.0.0","dependencies":{}}\n');
  }

  ctx.stdout.write('\x1b[36mNimbus npm v2 (batched writes)\x1b[0m\n');

  const installer = await self.ensureNpmInstaller();
  const result = await installer.install(cwd, {
    packages, pid: ctx.pid, cred: requireVfsCred(ctx.cred, 'npm-fast'), registry: ctx.env?.NPM_REGISTRY, signal: ctx.signal,
    onProgress: (msg: string) => ctx.stdout.write('[npm] ' + msg + '\n'),
  });

  const summary = installSummary({
    installed: result.installed.length, failed: result.failed, elapsedMs: result.elapsed,
    totalFiles: result.totalFiles, fromCacheHits: result.cachedHits,
  });
  if (summary.stderr) ctx.stderr.write(summary.stderr);
  if (summary.stdout) ctx.stdout.write(summary.stdout);
  return result.failed.length > 0 ? 1 : 0;
});

HeredocHandler.install(shell, terminal);

// ── Readline-parity keybindings (Ctrl+K, Ctrl+W, Alt+B, Alt+F, Alt+D,
//    Ctrl+Y, Ctrl+T, Ctrl+L, Ctrl+R, Alt+. , Ctrl+←/→, Alt+←/→, Linux
//    Home/End variants, Ctrl+B/F/N/P, …). Installed AFTER Heredoc so
//    its handleInput wrapper takes precedence when heredoc mode is
//    active. ──
LineEditorExtender.install(shell, terminal);

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
    // The command that runs the script (`sh x.sh`) awaits its shell, which is
    // this session's work behind the child's pid: a kill stops it.
    const endAwait = self.processes.beginAwait(parentPid, childProcess.pid);
    const stop = new AbortController();
    const stopped = self.processes.holdWork(childProcess.pid, (reason) => stop.abort(reason), stop.signal);
    let exitCode = 1;
    try {
      const identity = commandIdentityFor(childProcess.pid);
      const terminal = new HeadlessTerminal();
      const childShell = new Shell(
        terminal,
        workspace.filesystem,
        registry,
        { ...env, ...(options?.env || {}) },
        self.processes,
        identity,
      );
      childShell.setHostProcessSignals(hostSignals);
      HeredocHandler.install(childShell, terminal);
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
        signal: stop.signal,
      });
      exitCode = result.exitCode;
      return result;
    } finally {
      endAwait();
      self.processes.exit(childProcess.pid, exitCode);
      stopped();
    }
  },
} satisfies ShellEntrypointExecutor;
registerShellEntrypointCommands(registry, shellEntrypointExecutor);

/**
 * Whether a server adopted `pid` (the bin-spawn contract) and runs on as
 * it: a dev server binds its stop to the pid (runsWork), a node resident
 * holds it in the facet manager.
 */
const adopted = (pid: number): boolean =>
  self.processes.runsWork(pid) || (self.facetManager?.hasResidentProcess(pid) ?? false);

// Shell scripts that execute through the local shell still need the same
// process-table and log-store contract as facet-backed processes. Answers
// 'resident' for a long-running script a server adopted, which runs on.
const shellExecuteTracked = async (
  cmd: string,
  cmdCtx: CommandContext,
  opts: { longRunning?: boolean } = {},
): Promise<number | 'resident'> => {
  const entry = self.processes.spawn(
    cmd,
    [cmd],
    cmdCtx.cwd || '/home/user',
    { parentPid: cmdCtx.pid },
  );
  const pid = entry.pid;
  if (opts.longRunning) self.processes.setLongRunning(pid);
  const startedAt = Date.now();

  // Spawn banner — matches facets/manager.ts onSpawn format.
  if (terminal) {
    const label = opts.longRunning ? 'started (long-running)' : 'started';
    terminal.write(
      `\x1b[2m[shell ${label}: pid=${pid} cmd="${cmd}"]\x1b[0m\r\n`,
    );
  }
  // Structured spawn event for the tabs UI (mirrors the facet-manager
  // onSpawn hook). Long-running shell commands like `vite` and
  // `wrangler dev` trigger auto-open of a log tab.
  notifyTerminalEvent(terminal, {
    type: 'spawn', pid, command: cmd, longRunning: !!opts.longRunning, attachedTty: false,
  });

  // Wrap the caller-supplied streams so every chunk is both displayed
  // AND captured in the ring buffer keyed by this PID.
  const shown = outputHooks(cmdCtx);
  const tee = (stream: 'stdout' | 'stderr') => async (d: Uint8Array) => {
    await self.processes.appendOutputBytes(pid, stream, d);
    await (stream === 'stdout' ? shown.onStdout(d) : shown.onStderr(d));
  };

  // The script runs as the wrapper, on a shell of its own (as npm runs a
  // script under `sh -c`): the session shell is the terminal's, and scripts
  // run at once, so two on it would each save and restore its state over the
  // other's. The command that runs it (`npm run x`) awaits it, and its
  // commands are its work (SessionProcessSupervisor): a chain of them doing
  // nothing but await a program is told as such.
  const scriptShell = workspace.shellFor(pid, { cwd: cmdCtx.cwd || '/home/user', env: cmdCtx.env });
  const endAwait = self.processes.beginAwait(cmdCtx.pid, pid);
  // The script is this session's work behind the pid until its shell has
  // closed what it opened: a kill stops it, and only then is what it bound
  // released.
  const stop = new AbortController();
  const stopped = self.processes.holdWork(pid, (reason) => stop.abort(reason), stop.signal);
  let exitCode = 1;
  let handedOffToLongRunningFacet = false;
  try {
    const result = await scriptShell.execute(cmd, {
      cwd: cmdCtx.cwd,
      env: cmdCtx.env,
      onStdout: tee('stdout'),
      onStderr: tee('stderr'),
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
      signal: stop.signal,
    });
    exitCode = result.exitCode;
  } catch (e: any) {
    // Surface the error in the terminal and the ring buffer.
    const msg = (e && (e.stack || e.message)) || String(e);
    const line = 'shellExecuteTracked error: ' + msg + '\n';
    try { self.processes.appendOutput(pid, 'stderr', line); } catch {}
    try { cmdCtx.stderr.write(line); } catch {}
    exitCode = 1;
  } finally {
    try {
      await shown.end();
    } finally {
      endAwait();
      try { await scriptShell.closeDescriptors(); } catch {}
      stopped();
      // When a long-running script handed off to a live server (the registry
      // command adopted this pid and returned 0), the process stays running;
      // emitting an immediate exit would print a false `[shell exited]` and
      // flip the process to terminated in /api/processes. Mirror the npm-bin
      // resolver's `handedOffToLongRunningFacet` contract.
      handedOffToLongRunningFacet = opts.longRunning === true && exitCode === 0 && adopted(pid);
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
        notifyTerminalEvent(terminal, { type: 'exit', pid, code: exitCode, command: cmd });

        // Keep shell execution diagnostics on the same session helper used by
        // the rest of the process subsystem.
        try { self._emitShellExecDone(pid, cmd, exitCode, Date.now() - startedAt); } catch {}
      }
    }
  }
  return handedOffToLongRunningFacet ? 'resident' : exitCode;
};
const runtimeCommandHint = createRuntimeCommandHintResolver(self.env as any);
installNpmBinFallbackResolver(registry, {
  filesystem: workspace.filesystem,
  getCwd: () => shell?.getCwd() || '/home/user',
  getFacetManager: () => {
    self.ensureFacetManager();
    return facetMgr!;
  },
  learnedServer: (server) => {
    self.ensureFacetManager();
    return facetMgr!.learnedServers.has(server);
  },
  terminal: terminal,
  notifyTerminalEvent: (event) => notifyTerminalEvent(terminal, event),
  runtimeCommandHint,
  emitShellExecDone: (pid, command, exitCode, durationMs) => {
    try { self._emitShellExecDone(pid, command, exitCode, durationMs); } catch {}
  },
});

// Register core npm — the install work itself goes through the port,
// which owns the NpmInstaller, prefix dirs and bin materialisation.
/** npm run's events whose scripts serve until stopped: run as long-running processes. */
const LONG_RUNNING_EVENTS: Readonly<Record<string, true>> = { dev: true, start: true, serve: true, watch: true };
const coreNpmCmd = createNpmCommand(
  registry,
  // Each script npm runs is a process of its own, on a shell of its own.
  (cmd, cmdCtx, script) => shellExecuteTracked(cmd, cmdCtx, { longRunning: script !== undefined && Object.hasOwn(LONG_RUNNING_EVENTS, script.event) }),
  kernel,
  {
    installer: createNpmInstallPort(self, workspace.filesystem),
    // Releases before 0.13.2 wrote package.json as root.
    beforeWrite: (ctx, path) => handKernelArtifact(workspace.filesystem, ctx.vfs, ctx.cred, path),
    beforeRun: async (ctx, { event: ran, scripts, manifest }) => {
      // Nimbus's own flags, anywhere on the command line, before `--` or after.
      const words: readonly string[] = ctx.args;
      // ── node_modules preflight ────────────────────────────────────
      // If the script invokes a known bundler/framework CLI (vite, next,
      // webpack, tsc, ...) and node_modules is missing, HARD-FAIL before
      // running it — the tool would crash with a cryptic "command not
      // found" / "cannot find package" error that's less helpful.
      // For custom/unknown scripts (e.g. `echo hi`), emit a warning but
      // continue — the user's intent might not need deps at all.
      // Bypass with --force / --no-install-check, or by setting
      // NIMBUS_SKIP_INSTALL_CHECK=1 in env.
      const bypassRunCheck =
        words.includes('--force') ||
        words.includes('--no-install-check') ||
        ctx.env?.NIMBUS_SKIP_INSTALL_CHECK === '1';
      if (!bypassRunCheck) {
        const guard = await checkNodeModulesGuard(ctx.vfs, `/${normalizeVfsPath(ctx.cwd || '/home/user')}`);
        if (guard.missing) {
          for (const { event, script } of scripts) {
            const bundler = detectBundlerBin(script);
            if (!bundler) continue;
            // Hard fail: script needs a bundler binary that lives in node_modules/.bin.
            await ctx.stderr.write(
              '\x1b[31m\u2718\x1b[0m \x1b[1mnode_modules/ not found\x1b[0m — ' +
              `script "${event}" runs \x1b[36m${bundler}\x1b[0m which needs installed dependencies ` +
              `(${guard.depCount} declared).\n` +
              '  Run \x1b[36mnpm install\x1b[0m first,\n' +
              '  or re-run with \x1b[36mnpm run ' + ran + ' -- --force\x1b[0m to skip this check.\n'
            );
            return 1;
          }
          // Soft warning: script might not need deps; let it try.
          await ctx.stderr.write(
            '\x1b[33m\u26A0\x1b[0m  node_modules/ not found (' + guard.depCount + ' deps declared) — ' +
            'proceeding anyway. Run \x1b[36mnpm install\x1b[0m if the script fails.\n\n'
          );
        }
      }

      // Next.js dev/start/build/export need a custom http.Server,
      // child_process.fork with v8-IPC and webpack/Turbopack, none of which
      // Nimbus ships: a deterministic refusal, rather than a script that hangs
      // or (build) resets the isolate during spawn. A one-off symbol-detection
      // guard, not a per-framework code path.
      if (scripts.some(({ event, script }) => refusedNextSubcommand(event, script, manifest, words))) {
        await ctx.stderr.write(NEXT_REFUSAL_MESSAGE);
        return 127;
      }
      return null;
    },
  },
);
registry.register('npm', async (ctx: any) => {
  const args: string[] = ctx.args || [];
  const sub = args[0];
  const cwdKey = normalizeVfsPath(ctx.cwd || '/home/user');

  // npm init, npm create, npm innit: core npm's (npm-init.ts), npm's own
  // package.json or the initializer it names, run by npx.
  if (sub === 'init' || sub === 'create' || sub === 'innit') {
    // Releases before 0.13.2 wrote package.json as root.
    await handKernelArtifact(workspace.filesystem, ctx.vfs, requireVfsCred(ctx.cred, 'npm'), `/${cwdKey}/package.json`);
    return coreNpmCmd(ctx);
  }

  // Fall through to core npm for other subcommands
  return coreNpmCmd(ctx);
});
// npx: check registered commands first, then resolve/install through
// Nimbus's NpmInstaller and execute the package bin via the Node runtime.
registry.register('npx', async (ctx: any) => {
  const npxArgs: string[] = ctx.args || [];
  const { formatNpxHelp, parseNpxInvocation, resolveNpxBinary } = await import('../npm/npx-install.js');
  const invocation = parseNpxInvocation(npxArgs);
  if (invocation.self === 'missing') { ctx.stderr.write('Usage: npx <command> [args...]\n'); return 1; }
  if (invocation.self === 'version') {
    ctx.stdout.write(NPM_VERSION + '\n');
    return 0;
  }
  if (invocation.self === 'help') {
    ctx.stdout.write(formatNpxHelp());
    return 0;
  }
  const cmd = invocation.command;

  // Check if it's a built-in command (vite, esbuild, etc.)
  const resolved = cmd ? await registry.resolve(cmd, resolveContext(ctx.cwd, ctx.env, ctx.vfs)) : null;
  if (resolved) {
    return await resolved({ ...ctx, args: invocation.args });
  }

  // Nimbus-native npx install + run path. Routes package installation
  // through NpmInstaller's full-packument resolver.
  const installer = await self.ensureNpmInstaller();
  self.ensureSqliteFs();
  const resolveResult = await resolveNpxBinary(
    installer,
    projectFs(ctx.vfs),
    requireVfsCred(ctx.cred, 'npx'),
    ctx.cwd || '/home/user',
    npxArgs,
    (msg: string) => ctx.stdout.write(msg + '\n'),
    ctx.pid,
    ctx.env?.NPM_REGISTRY,
    ctx.signal,
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
  const procs = self.processes.publishedAll();
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
  if (procs.length === 0 && !self.viteDevServer?.isRunning) {
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

  // Follow mode: subscribe to live appends, poll for exit. Ended as its
  // observers are told it: an end still held behind its output is followed.
  const entry = self.processes.published(pid);
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
  const running = self.processes.publishedAll().filter((p) => p.state === 'running');
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

registry.register('kill', createKillCommand(hostSignals));

registry.register('top', createTopCommand(self.processes));
registry.register('watch', createWatchCommand(registry));
registry.register('help', createHelpCommand(registry, () => shell.builtinNames()));

}
