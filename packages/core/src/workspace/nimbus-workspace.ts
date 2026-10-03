/**
 * nimbus-workspace.ts — Nimbus as a component someone else can hold.
 *
 * A workspace is a durable filesystem plus a shell over it. It owns no
 * transport, no session, no socket and no Durable Object: the host supplies
 * the filesystem and gets back `.fs`, `.exec`, and a command registry to add
 * to. That is what makes it embeddable in a Durable Object that is already
 * busy powering something else, and what makes it runnable in a plain bun
 * process over `bun:sqlite`.
 *
 * The composition here is not new. It is the one `session/init.ts` performed
 * inline, lifted out of the session so there is one recipe rather than one per
 * caller — the session now reads its kernel, shell and registry off a
 * workspace, and five unit tests were already hand-rolling the same steps.
 *
 * Deliberately not `Sandbox.create`, which is the lifo demo sandbox's boot
 * rather than this one: it registers `systemctl`, `tunnel` and the network
 * command set, boots enabled service units out of `/etc/systemd`, and starts
 * the shell before the host can register a command of its own. A session
 * routed through it would silently acquire all of that.
 */

import { createKillCommand } from '../substrate/lifo/commands/system/kill.js';
import { Kernel } from '../substrate/lifo/kernel/index.js';
import { Shell } from '../substrate/lifo/shell/Shell.js';
import type { ShellCommandIdentity } from '../substrate/lifo/shell/Shell.js';
import { createDefaultRegistry } from '../substrate/lifo/commands/registry.js';
import type { CommandRegistry } from '../substrate/lifo/commands/registry.js';
import type { Command, CommandRunAsHost } from '../substrate/lifo/commands/types.js';
import { createNodeCommand } from '../substrate/lifo/commands/system/node.js';
import { createCurlCommand } from '../substrate/lifo/commands/net/curl.js';
import { createWgetCommand } from '../substrate/lifo/commands/net/wget.js';
import { SandboxCommandsImpl } from '../substrate/lifo/sandbox/SandboxCommands.js';
import { HeadlessTerminal } from '../substrate/lifo/sandbox/HeadlessTerminal.js';
import type { CommandResult, RunOptions } from '../substrate/lifo/sandbox/types.js';
import type { ITerminal } from '../substrate/lifo/terminal/ITerminal.js';
import { SqliteVFS } from '../vfs/sqlite-vfs.js';
import {
  DEFAULT_HOME, DEFAULT_HOSTNAME, defaultPath, SEEDED_TOP_LEVEL_DIRS,
  DEFAULT_SHELL, DEFAULT_USER, NIMBUS_VERSION,
} from '../constants.js';
import { BASH_RUNNER, CRED_KERNEL, CRED_SESSION_USER } from '../runtime/os-contracts.js';
import type { SqlDatabase, TransactionHost, NimbusFilesystemAuthority } from '../runtime/os-contracts.js';
import { ProcessFiles } from '../runtime/process-files.js';
import { ProcessView } from '../runtime/process-files.js';
import { WorkspaceFs } from './workspace-fs.js';
import { PID_GEN_STRIDE, type ProcessEntry } from '../runtime/process-table.js';
import { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import type { FacetHost } from '../runtime/facet-host.js';
import { runtimeEntrypoints, type RunnerFactory } from '../runtime/installed-runtimes.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import { makeNimbusVerbHandler } from '../runtime/nimbus-command.js';
import {
  composeRuntimeSources,
  suppliedRuntimeSource,
  type RuntimePackage,
  type RuntimeSource,
} from '../runtime/runtime-package.js';
import type { EsbuildService } from '../runtime/esbuild-service.js';
import { registerUnixCommands } from '../shell/unix-commands.js';
import { rehydrateGlobalPackages } from '../substrate/lifo/commands/system/lifo.js';
import { formatProcMounts, registerMountCommands } from '../shell/mount-commands.js';
import { installPathExecResolver } from '../shell/exec-dispatch.js';
import { adoptCtxExports, composeFabric, type CtxExports, type FabricComposition } from '@nimbus-sh/platform/composition.js';
import { createSupervisorOpHandler, type SupervisorOpEnvelope, type SupervisorOpHandler } from './supervisor-op.js';

export interface NimbusWorkspaceOptions {
  /** The host's SQLite. In a Durable Object: `ctx.storage.sql`. */
  readonly sql: SqlDatabase;
  /**
   * Carries `transactionSync`. In a Durable Object: `ctx`.
   *
   * Every atomic write in the filesystem rests on this being a real
   * transaction. An implementation that merely calls the callback converts
   * each one into a torn write that reports success.
   *
   * `NimbusWorkspace.create` is a first-write-wins composition root beside
   * `worker/index.ts` and `loom/actor.ts`: when `ctxExports` is absent the
   * host's ctx `exports` bag is adopted as the isolate's.
   */
  readonly transactions?: TransactionHost & { readonly exports?: CtxExports };
  /**
   * The filesystem already open over `sql`, for a host that has one.
   *
   * A Durable Object does: its installer, its git commands and its RPC
   * surfaces read those rows without a shell in sight, and they hold a
   * SqliteVFS from the first request that needed one. It must hand over THAT
   * one — a second SqliteVFS over the same database is a second cache, and
   * one of the two will serve a stale read. Such a host has also already
   * revoked the previous generation's append writers, which is why that only
   * happens below when the workspace is the one opening the filesystem.
   */
  readonly vfs?: SqliteVFS;
  /**
   * Process-id generation. Two things rest on it: the workspace revokes every
   * append capability at or below `generation * 1_000_000` before serving
   * anything, and the wasm runner allocates pids above it. A value that
   * repeats across restarts hands a dead process live write authority, so
   * hosts that persist must supply a counter that never repeats.
   */
  readonly generation?: number;
  /** Overlaid on the Nimbus default environment. */
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  /** Absent means headless: `.exec` captures output and nothing is drawn. */
  readonly terminal?: ITerminal;
  /**
   * Who the shell acts as, when the host keeps a process table that can answer
   * for it. Absent, commands run as uid 1000 with a umask of 022 and no
   * process behind them, which is the Shell's own default.
   */
  readonly identity?: ShellCommandIdentity;
  /**
   * Language runtimes to install before the shell is served, as npm packages
   * the embedder imported (`@nimbus-sh/runtime-bash`,
   * `@nimbus-sh/runtime-cpython`).
   *
   * A Durable Object gets these from R2 through `nimbus install`; an embedder
   * off Cloudflare has no bucket and needs none, because npm already fetched
   * and integrity-checked the same bytes. Both write the same tree at the same
   * path, so what is installed here is indistinguishable from what is
   * installed there — see runtime/runtime-package.ts.
   *
   * Independent of `facets`: this decides what the filesystem HOLDS, and
   * `facets` decides whether anything can run it. A workspace given runtimes
   * and no facet host installs them and still answers "command not found",
   * because it still has nothing that could compile a module.
   */
  readonly runtimes?: readonly RuntimePackage[];
  /**
   * Where WebAssembly runs.
   *
   * Absent, the workspace is the JavaScript half of Nimbus: the durable
   * filesystem, the shell and the coreutils, and `bash` or `./prog.wasm` is
   * "command not found" — not disabled, ABSENT, because nothing has been
   * supplied that could compile a module or run one. Supplied, the wasm
   * runtimes already installed in this filesystem become invokable commands
   * and `wasm-runner` joins them, which is what makes a `\0asm` file on the
   * PATH executable (see shell/exec-dispatch.ts).
   *
   * A plain process passes `localFacetHost()`. A Durable Object passes nothing
   * here and registers its own runners instead, because the ones it needs
   * carry REPLs and a resident-process substrate this cannot reach.
   */
  readonly facets?: FacetHost;
  /**
   * Isolate-wide fabric composition, including the hosting namespace, for a
   * host whose only composition root is this factory. It is the same
   * `composeFabric`: a second, different composition in the isolate throws.
   * The bindings a workspace mints carry their route, so composing here
   * rather than at module scope is safe for them; the host's own
   * namespace lookups (fan-out, peer placement) read the isolate's
   * composition and so every instance of the host composes before serving.
   */
  readonly fabric?: FabricComposition;
  /** Explicit exports override the bag on the transaction host. */
  readonly ctxExports?: CtxExports;
  /** The process table that allocated supervisor-binding pids. */
  readonly processes?: SessionProcessSupervisor;
  readonly processOutput?: (stream: 'stdout' | 'stderr', pid: number, data: string) => void | Promise<void>;
  readonly filesystemNamespace?: string;
  /**
   * The namespace and process bindings, when the host made them before the
   * workspace (a session's facets and RPC bind processes before it composes
   * one). Must be over `vfs`. Embedders mount on `filesystem.vfs`.
   */
  readonly filesystem?: ProcessFiles;
  /** Host operations, including overrides for host-specific accounting. */
  readonly supervisorOps?: Readonly<Record<string, SupervisorOpHandler>>;
  /**
   * When supplied `runtimes` land on disk: `eager` (default) writes every
   * package at create; `on-demand` registers each bin as a stub that installs
   * on first invocation, so a workspace that never runs a runtime never
   * carries its rows. Remote `runtimeSource` packages are never touched at
   * create either way — `nimbus install` reaches them.
   */
  readonly runtimeInstall?: 'eager' | 'on-demand';
  /** Beyond the supplied `runtimes`: a remote catalog the `nimbus` verb and
   *  install stubs can resolve against. Supplied packages win same-name
   *  lookups. */
  readonly runtimeSource?: RuntimeSource;
}

/**
 * A durable filesystem and a shell over it.
 *
 * The composition itself is synchronous. {@link create} awaits only the
 * optional work — installing runtime packages, loading the wasm runner modules
 * — so a host that asks for neither is never suspended between mounting the
 * filesystem and registering the commands. A Durable Object needs that: it
 * must not take delivery of an event with a half-built shell. The remaining
 * async step, running the user's login files, is {@link start}, which the host
 * calls once its own commands are in place.
 */
export class NimbusWorkspace {
  /**
   * The namespace as the session user sees it: the shell process's own view,
   * so every write passes the same lease check a command's does. Never the
   * kernel's authority (see CRED_SESSION_USER in os-contracts.ts). A relative
   * path is taken from its own working directory, the one the shell starts
   * in (create's `cwd`, else HOME), which a `cd` in the shell does not move.
   * `move` is mv's: a rename, or across mounts a copy that happens whole or
   * not at all. Helpers such as readText, writeText and exists are vfs.ts
   * free functions over it.
   */
  readonly fs: WorkspaceFs;
  /** The raw durable filesystem, for hosts that need uid-aware operations. */
  readonly vfs: SqliteVFS;
  readonly kernel: Kernel;
  readonly shell: Shell;
  /** What the shell resolves a command name against. A host adds its own. */
  readonly registry: CommandRegistry;
  /**
   * The environment the shell was composed with. The shell's own copy drifts
   * from this one the moment the user exports anything; this is what a host
   * hands to a subordinate shell it starts itself.
   */
  readonly env: Record<string, string>;

  /** The process table this workspace's shell and wasm-runner allocate from —
   *  the host's own when it supplied one. */
  readonly processes: SessionProcessSupervisor;
  /** Runtime installs, runners and the `nimbus` verb's backing store. */
  readonly runtimes: RuntimeManager;
  /** The pid the shell's commands run as — the host's identity pid when it
   *  supplied one, else the `sh` this workspace spawned. */
  readonly shellProcessPid: number;

  private readonly commands: SandboxCommandsImpl;

  private constructor(
    vfs: SqliteVFS,
    kernel: Kernel,
    shell: Shell,
    registry: CommandRegistry,
    env: Record<string, string>,
    private readonly sql: SqlDatabase,
    processes: SessionProcessSupervisor,
    runtimes: RuntimeManager,
    shellProcessPid: number,
    private readonly supervisorOps: (envelope: SupervisorOpEnvelope) => Promise<unknown>,
    readonly filesystem: ProcessFiles,
    private readonly runtimeLease: import('../runtime/os-contracts.js').NimbusHostFilesystemLease,
  ) {
    this.vfs = vfs;
    this.kernel = kernel;
    this.shell = shell;
    this.registry = registry;
    this.env = env;
    this.processes = processes;
    this.runtimes = runtimes;
    this.shellProcessPid = shellProcessPid;
    this.commands = new SandboxCommandsImpl(shell, registry);
    // The shell's own process view: a host calling `.fs` acts as the
    // session user, never as the kernel. Its working directory is the
    // shell's before anything has run: create's `cwd`, else HOME.
    this.fs = new WorkspaceFs(shell.getVfs(), shell.getCwd());
  }

  static async create(options: NimbusWorkspaceOptions): Promise<NimbusWorkspace> {
    if (options.fabric) composeFabric(options.fabric);
    const exports = options.ctxExports ?? options.transactions?.exports;
    if (exports) adoptCtxExports(exports);
    const vfs = options.vfs ?? openFilesystem(options);
    if (options.filesystemNamespace !== undefined && options.filesystemNamespace !== vfs.namespace) {
      throw new Error('filesystemNamespace differs from the supplied filesystem namespace');
    }
    // Everything the OS keeps per user follows the configured home: the
    // seeded home directory, its /etc/passwd entry, PATH and the XDG dirs.
    const home = options.env?.HOME ?? DEFAULT_HOME;
    if (!home.startsWith('/')) throw new Error(`HOME must be an absolute path, got ${JSON.stringify(home)}`);
    seedBaseFilesystem(vfs, home);

    // The namespace (SQLite at `/`, /proc, /dev) and what binds processes to it.
    const filesystem = options.filesystem ?? new ProcessFiles(vfs);
    if (filesystem.engine !== vfs) throw new Error('The workspace filesystem must be over the workspace SqliteVFS');
    const kernel = new Kernel();
    const registry = createDefaultRegistry();
    // The durable coreutils replace ~25 lifo builtins. They are the ones that
    // carry credentials and read this filesystem's uid/gid, so they must win.
    registerUnixCommands(registry, vfs);
    // df, mount and /proc/mounts all read the selected authority's listing.
    registerMountCommands(registry, filesystem);

    const processes = options.processes ?? new SessionProcessSupervisor();
    // Only a supervisor this workspace created gets its pid base set here; a
    // host-supplied one keeps the base its owner configured.
    if (!options.processes) processes.setPidBase((options.generation ?? 1) * PID_GEN_STRIDE);

    const env = { ...defaultEnv(home), ...options.env };

    // The identity every shell command runs as. A host that supplied one keeps
    // it verbatim — its pid is already alive in ITS process table. Otherwise
    // the workspace's own supervisor spawns the shell process, so `sudo`,
    // `chown` and the per-process umask have a live table entry behind them
    // rather than the Shell's pid-less uid-1000 default.
    let shell: Shell;
    let identity: ShellCommandIdentity;
    let shellProcessPid: number;
    if (options.identity) {
      identity = options.identity;
      shellProcessPid = options.identity.pid;
    } else {
      const shellProcess = processes.spawn('sh', ['sh'], options.cwd ?? home);
      shellProcessPid = shellProcess.pid;
      identity = workspaceShellIdentity(processes, shellProcess, () => shell);
    }
    shell = new Shell(
      options.terminal ?? new HeadlessTerminal(),
      filesystem,
      registry,
      env,
      kernel.processRegistry,
      identity,
    );
    if (options.cwd) shell.setCwd(options.cwd);

    // node/curl/wget are bound to THIS workspace's kernel: their localhost
    // traffic resolves through its port registry and loopback router, not the
    // process-wide defaults the lazily-loaded commands would share.
    registry.register('node', createNodeCommand(kernel));
    registry.register('curl', createCurlCommand(kernel));
    registry.register('wget', createWgetCommand(kernel));
    // kill signals this workspace's own processes and jobs (bash's builtin).
    registry.register('kill', createKillCommand(kernel.processRegistry));

    const getHome = () => shell.getEnv().HOME ?? DEFAULT_HOME;
    const kernelFs = vfs.as(CRED_KERNEL);
    const runtimeLease = filesystem.openHost(CRED_KERNEL);
    // Kernel-credentialed on purpose: this only INSPECTS a file to decide how
    // to run it, and re-checks the caller's own execute permission at
    // invocation time — the `authorize` wrapper in exec-dispatch.ts. It
    // inspects through the namespace's awaiting face, so a script on an
    // asynchronous mount runs by its path like any other.
    installPathExecResolver(registry, new ProcessView(runtimeLease.fs), () => shell.getCwd());

    // Everything past the lease can throw — a runtime source that fails to
    // list, a package that will not install. The workspace it would have
    // belonged to is never constructed, so nobody is left to close() it.
    try {
      const runtimes = new RuntimeManager({
        vfs: new ProcessView(runtimeLease.fs),
        registry,
        getHome,
        source: options.runtimeSource
          ? composeRuntimeSources([suppliedRuntimeSource(options.runtimes ?? []), options.runtimeSource])
          : suppliedRuntimeSource(options.runtimes ?? []),
      });

      if (options.facets) {
        registerWasmRuntimes({
          facets: options.facets,
          vfs,
          filesystem,
          registry,
          processes,
          runtimes,
          getHome,
        });
        // With a facet host the workspace owns the runner table, and it is
        // complete here: a supplied package naming a runner outside it would
        // install and then answer "command not found" forever. Refused by
        // name instead. Without facets the host binds runners after create,
        // and catalog resolution and rehydration keep their own fallbacks.
        for (const runtimePackage of options.runtimes ?? []) {
          const missing = runtimes.missingRunners(runtimePackage.manifest);
          if (missing.length === 0) continue;
          const { name, version } = runtimePackage.manifest;
          throw new Error(
            `runtime package ${name}@${version} needs runner '${missing.join("', '")}', `
            + `which this @nimbus-sh/core does not provide (it provides '${runtimes.runnerKeys().join("', '")}'). `
            + 'Install the runtime package release built for this core.',
          );
        }
      }
      if (options.runtimeInstall === 'on-demand') {
        // Stubs only for bins nothing already answers: a coreutil never yields
        // its name, and a rehydrated runtime is rebound below anyway.
        const stubbed = new Set<string>();
        for (const runtimePackage of options.runtimes ?? []) {
          for (const ep of runtimeEntrypoints(runtimePackage.manifest)) {
            if (stubbed.has(ep.binName) || registry.has(ep.binName)) continue;
            runtimes.registerInstallStub(ep.binName);
            stubbed.add(ep.binName);
          }
        }
        // Beyond the supplied packages: a name the registry cannot answer is
        // offered to the source — catalog reads only, no payload — and gets a
        // stub when something could satisfy it. Registered last so every real
        // command and the PATH resolver still win.
        const baseResolve = registry.resolve.bind(registry);
        registry.resolve = async (name, from) => {
          const found = await baseResolve(name, from);
          if (found) return found;
          if (!name || name.includes('/')) return undefined;
          try {
            if (!await runtimes.resolvable(name)) return undefined;
          } catch {
            return undefined;
          }
          runtimes.registerInstallStub(name);
          return baseResolve(name, from);
        };
      } else {
        // Before the runners are wired, because registration reads what the
        // filesystem holds — the same order `nimbus install` observes, and the
        // same order a Durable Object observes when it rehydrates after
        // eviction. No runner factories yet means a filesystem-only install,
        // exactly as before.
        for (const runtimePackage of options.runtimes ?? []) {
          await runtimes.installPackage(runtimePackage);
        }
      }
      await runtimes.rehydrate();
      // Globally installed npm and lifo packages come back as commands, once,
      // here: the workspace is composed with them registered (a failure
      // leaves those commands out, and says so).
      try {
        await rehydrateGlobalPackages(new ProcessView(runtimeLease.fs), registry);
      } catch (error) {
        console.error('[nimbus] global npm commands were not restored:', error);
      }

      // The one `nimbus` verb: installs go through the manager, and a host with
      // application verbs supplies them — a bare workspace reports that it has
      // no session to address.
      registry.register('nimbus', makeNimbusVerbHandler({
        runtimes,
        registry,
        vfs: kernelFs,
      }));

      const supervisorOps = createSupervisorOpHandler({
        vfs, filesystem,
        processes,
        output: options.processOutput,
        extend: options.supervisorOps,
      });
      return new NimbusWorkspace(
        vfs, kernel, shell, registry, env, options.sql,
        processes, runtimes, shellProcessPid,
        supervisorOps, filesystem, runtimeLease,
      );
    } catch (error) {
      await runtimeLease.dispose();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.runtimeLease.dispose();
  }

  exec(command: string, options?: RunOptions): Promise<CommandResult> {
    return this.commands.run(command, options);
  }

  /** The hosting object forwards its supervisorOp RPC to this method. */
  supervisorOp(envelope: SupervisorOpEnvelope): Promise<unknown> {
    return this.supervisorOps(envelope);
  }

  /**
   * Apply the login files, and begin reading the terminal when there is one.
   *
   * Separate from {@link create} because a host with commands of its own must
   * register them first: `/etc/profile` and `~/.nimbusrc` are the user's
   * files, and either may name a command the host has yet to supply.
   */
  async start(): Promise<void> {
    // Sources /etc/profile and the first user rc file it finds, then prompts.
    const started = this.shell.start();
    // Nimbus's own rc file, which the shell's list predates.
    await this.shell.sourceFile(`${this.shell.getEnv().HOME ?? DEFAULT_HOME}/.nimbusrc`);
    // Settled only once the shell has prompted, so a host that awaits this
    // can hand the shell input that belongs after the prompt.
    await started;
  }

  /**
   * Files, directories and bytes this workspace occupies.
   *
   * A host sharing its Durable Object needs this because the filesystem's own
   * `df` reports the workspace's usage against the whole 10 GB limit, and the
   * host's rows draw on that same limit without appearing here.
   */
  stats(): { files: number; dirs: number; usedBytes: number } {
    const s = this.vfs.getStats();
    return { files: s.files, dirs: s.directories, usedBytes: s.usedBytes };
  }

  /**
   * Drop this workspace's tables. The host's own rows are untouched.
   *
   * Deliberately not `ctx.storage.deleteAll()`, which is what the session's
   * own destroy uses: a session owns its Durable Object, and a workspace does
   * not. Calling deleteAll here would erase the data of whatever else the host
   * keeps in that object.
   */
  destroy(): void {
    for (const table of WORKSPACE_TABLES) {
      this.sql.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  }
}

/**
 * Open the durable filesystem for a host that has not opened one itself.
 *
 * The revocation is here rather than in `create` because it is the act of
 * OPENING that carries it: pids at or below this generation's floor belong to
 * an instance that is gone, and their append capabilities must stop being
 * honoured before the first read. A host that opened the filesystem itself has
 * already done this, at the same seam, for the same reason.
 */
function openFilesystem(options: NimbusWorkspaceOptions): SqliteVFS {
  const vfs = new SqliteVFS(options.sql, options.transactions, options.filesystemNamespace);
  vfs.revokeAppendWritersThrough((options.generation ?? 1) * PID_GEN_STRIDE);
  return vfs;
}

/**
 * The environment a Nimbus shell starts in.
 *
 * `PATH` and `EDITOR` restate what the seeded `/etc/profile` exports, so a
 * workspace whose host never runs the login files is still on the real PATH.
 * `PORT` and `HOST` are here because every scaffolded server reads them and
 * gets `undefined` otherwise — Express's default app, every create-vite
 * template, `${PORT:-3000}` in a package.json script. `NODE_ENV` is NOT here,
 * as on any real machine: every bundler reads a set NODE_ENV as the user's
 * choice of mode, so a default of `development` made `vite build` emit a
 * development bundle (jsxDEV calls, React's development build).
 */
function defaultEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    USER: DEFAULT_USER,
    SHELL: DEFAULT_SHELL,
    HOSTNAME: DEFAULT_HOSTNAME,
    TERM: 'xterm-256color',
    PWD: home,
    PATH: defaultPath(home),
    PS1: `\x1b[1;32muser@${DEFAULT_HOSTNAME}\x1b[0m:\x1b[1;34m\\w\x1b[0m$ `,
    LANG: 'en_US.UTF-8',
    EDITOR: 'nano',
    NIMBUS_VERSION: NIMBUS_VERSION,
    TMPDIR: '/tmp',
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_DATA_HOME: `${home}/.local/share`,
    npm_config_prefix: '/usr/local',
    PORT: '3000',
    HOST: '0.0.0.0',
  };
}

/**
 * The identity the workspace's own `sh` runs commands under.
 *
 * Every command is credentialed by a live entry in the process table, which is
 * what makes `sudo`, `chown` and the per-process umask mean anything. `runAs`
 * is how a command starts another (sudo, su, find -exec): a child of the
 * calling process under the requested credential, a real table entry rather
 * than a flag on the parent's, that execvp's its argv as a program, with no
 * shell between them to find a function or an alias by that name.
 */
function workspaceShellIdentity(
  processes: SessionProcessSupervisor,
  shellProcess: ProcessEntry,
  getShell: () => Shell,
): ShellCommandIdentity {
  const runAsProcess: CommandRunAsHost = async (parent, cred, argv) => {
    if (argv.length === 0) return { status: 0, signal: null };
    const child = processes.spawn(argv.join(' '), argv, parent.cwd, {
      parentPid: parent.pid,
      cred,
    });
    let exitCode = 1;
    try {
      // The child inherits its parent's descriptors, environment and directory.
      const ended = await getShell().runProgram(argv, {
        identity: commandIdentityFor(child.pid),
        cwd: parent.cwd,
        env: parent.env,
        stdin: parent.stdin,
        stdout: parent.stdout,
        stderr: parent.stderr,
        terminalStdin: parent.terminalStdin,
        isFdTerminal: parent.isFdTerminal,
        isFdPipe: parent.isFdPipe,
        signal: parent.signal,
        runAs: runAsProcess,
      });
      exitCode = ended.status;
      return ended;
    } finally {
      processes.exit(child.pid, exitCode);
    }
  };

  const commandIdentityFor = (pid: number): ShellCommandIdentity => ({
    pid,
    get cred() {
      return processes.cred(pid);
    },
    setUmask(mask: number) {
      processes.setUmask(pid, mask);
    },
    runAs: runAsProcess,
  });

  return commandIdentityFor(shellProcess.pid);
}

/**
 * Turn a facet host into commands: runner factories for the runtimes this
 * filesystem may hold, plus `wasm-runner` for everything else with a `\0asm`
 * header.
 *
 * The factories are registered on THIS workspace's RuntimeManager rather than
 * a process-global table, because each one closes over THIS workspace's
 * filesystem and facet host — a second workspace in the same process would
 * otherwise silently retarget the first one's bash. `rehydrate` on the
 * manager is what binds them to the bins the filesystem already holds.
 *
 * Each runner's module is imported by the first command that needs it, not at
 * boot: the runners carry the WASI shim and the bash scheduler as source
 * strings, and a workspace pays to parse only the ones its commands run.
 * Importing all five at create cost every workspace isolate 0.65 MB whether
 * or not a runner ever ran (measured by Kinu, 2026-09-30). The runner table
 * is still complete at create, so a package naming a runner outside it is
 * refused by name as before.
 */
function registerWasmRuntimes(deps: {
  facets: FacetHost;
  vfs: SqliteVFS;
  filesystem: ProcessFiles;
  registry: CommandRegistry;
  processes: SessionProcessSupervisor;
  runtimes: RuntimeManager;
  getHome(): string;
}): void {
  // wasm-runner allocates pids for what it runs, off the SAME supervisor the
  // shell identity uses — the host's own when it supplied one.
  const processes = deps.processes;

  // Loaded on the first TypeScript or ESM script and not before. The module
  // statically imports `esbuild-wasm/esbuild.wasm`, which only wrangler
  // resolves — node instantiates it as a wasm module and fails on its Go
  // imports — so a host outside Cloudflare must be able to run a shell, bash
  // and python without that module ever entering its graph.
  let esbuild: Promise<EsbuildService> | null = null;
  const wasmRunner = once(async (): Promise<Command> => {
    const [{ wasmRunnerSpec }, { buildRuntimeHandler }] = await Promise.all([
      import('../runtime/wasm-runner.js'),
      import('../runtime/runtime-registry.js'),
    ]);
    return buildRuntimeHandler(
      wasmRunnerSpec({ filesystem: deps.filesystem, facets: deps.facets, processes }),
      {
        getEsbuild: () => {
          if (!esbuild) {
            esbuild = import('../runtime/esbuild-service.js')
              .then((module) => new module.EsbuildService(deps.filesystem.namespaceFs(CRED_KERNEL)));
          }
          return esbuild;
        },
        registry: deps.registry,
      },
    );
  });
  deps.registry.register('wasm-runner', async (ctx) => (await wasmRunner())(ctx));

  // Each factory is made once, on the first install or rehydrate that binds
  // its runner, and every later bin reuses it.
  const lazy = (make: () => Promise<RunnerFactory>): RunnerFactory => {
    const factory = once(make);
    return async (...args) => (await factory())(...args);
  };
  const runners: Record<string, RunnerFactory> = {
    [BASH_RUNNER]: lazy(async () => (await import('../runtime/bash-runner.js'))
      .makeBashRunnerFactory({ facets: deps.facets, filesystem: deps.filesystem })),
    // No `startResident`: a workspace owns no actor that could outlive the
    // call, so a program that keeps serving is refused by name rather than
    // run as a one-shot that dies with it. Same for ruby, where a script is
    // the shape that may bind a port.
    'cpython-runner': lazy(async () => (await import('../runtime/cpython-runner.js'))
      .makeCPythonRunnerFactory({ facets: deps.facets })),
    'ruby-runner': lazy(async () => (await import('../runtime/ruby-runner.js'))
      .makeRubyRunnerFactory({ facets: deps.facets, filesystem: deps.filesystem, registry: deps.registry, getHome: deps.getHome })),
    'clang-runner': lazy(async () => (await import('../runtime/clang-runner.js'))
      .makeClangRunnerFactory({ facets: deps.facets, filesystem: deps.filesystem })),
  };
  for (const [key, factory] of Object.entries(runners)) {
    deps.runtimes.registerRunner(key, factory);
  }
}

/** `make`, run on the first call; every call gets its one promise. A rejection is not kept. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= make().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

/**
 * Every table the filesystem creates.
 *
 * Listed rather than discovered because the namespace is the contract an
 * embedder is owed: these names, and nothing else in their database, belong
 * to the workspace. Every one carries the `vfs_` prefix. The pre-v2 tables
 * (`inodes`, `file_chunks`, `content_lifecycle`) are not listed: SqliteVFS
 * drops them itself, and only once their columns prove they are its own.
 */
const WORKSPACE_TABLES = [
  'vfs_append_receipts_v2',
  'vfs_append_writer_state_v2',
  'vfs_append_module_state_v2',
  'vfs_append_pid_revocations_v2',
  'vfs_append_acked_gaps_v2',
  'vfs_state',
  'vfs_inodes',
  'vfs_chunks',
  'vfs_contents',
  'vfs_content_chunks',
  'vfs_inode_history',
  'vfs_gc_queue',
  'vfs_jobs',
  'vfs_snapshots',
  'vfs_tombstones',
  'vfs_cold_trash',
  'vfs_append_receipts',
  'vfs_append_writer_state',
  'vfs_append_module_state',
  'vfs_append_pid_revocations',
  'vfs_append_acked_gaps',
] as const;

/**
 * The directories and account files the shell cannot start without.
 *
 * Idempotent by construction: every write is guarded by an existence check, so
 * a workspace reopened over a populated database keeps whatever the user did
 * to these files. `/etc/passwd` and `/etc/group` are load-bearing rather than
 * decorative — `id`, `chown` and `su` resolve names through them.
 *
 * What a PRODUCT puts in a fresh filesystem — a banner, a welcome file, a
 * starter app — is not here. This is the base an OS needs in order to boot,
 * and it is exported because a host may need the filesystem before it needs a
 * shell: the Nimbus session seeds its starter project for a browser that hits
 * `/preview` without ever opening a terminal.
 *
 * `home` is the session user's home directory: it is made and owned by the
 * user, and /etc/passwd names it.
 */
export function seedBaseFilesystem(vfs: SqliteVFS, home: string = DEFAULT_HOME): void {
  const fs = vfs.as(CRED_SESSION_USER);
  const rootFs = vfs.as(CRED_KERNEL);

  // Top-level directories are the kernel's to make (`/` is 0755 root), and
  // handed to the session user, who owns their own tree: seeding them owned
  // by the kernel is what makes a workspace where `.fs` cannot write.
  for (const top of SEEDED_TOP_LEVEL_DIRS) {
    if (top === 'etc' || rootFs.exists(top)) continue;
    rootFs.mkdir(top, { mode: 0o777 & ~CRED_SESSION_USER.umask });
    rootFs.chown(top, CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  }
  // The home is made the way useradd -m makes it: by root, wherever it is,
  // then handed to the user. Its parents stay root's.
  const homeDir = home.replace(/^\/+/, '').replace(/\/+$/, '');
  if (homeDir !== '' && !rootFs.exists(homeDir)) {
    rootFs.mkdir(homeDir, { recursive: true, mode: 0o755 });
    rootFs.chown(homeDir, CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  }
  // HOME=/ is root's directory, not one Nimbus populates for the user.
  const homeChildren = homeDir === '' ? [] : [`${homeDir}/.config`, `${homeDir}/projects`];
  for (const dir of [
    ...homeChildren,
    'tmp', 'var/log',
    'usr/bin', 'usr/lib', 'usr/lib/node_modules',
    'usr/share', 'usr/share/pkg', 'usr/share/pkg/node_modules',
    'usr/local', 'usr/local/lib', 'usr/local/lib/node_modules', 'usr/local/bin',
  ]) {
    if (!fs.exists(dir)) fs.mkdir(dir, { recursive: true });
  }

  // /etc belongs to root, and is re-asserted rather than only created: a
  // user-writable /etc is an authority bug, not an untidy directory.
  if (!rootFs.exists('etc')) {
    rootFs.mkdir('etc', { mode: 0o755 });
  } else {
    const etc = rootFs.stat('etc');
    if (etc.uid !== 0 || etc.gid !== 0) rootFs.chown('etc', 0, 0);
    if ((etc.mode & 0o7777) !== 0o755) rootFs.chmod('etc', 0o755);
  }

  if (!rootFs.exists('etc/hostname')) {
    rootFs.writeFile('etc/hostname', `${DEFAULT_HOSTNAME}\n`);
    rootFs.chown('etc/hostname', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  }
  if (!rootFs.exists('etc/os-release')) {
    rootFs.writeFile('etc/os-release',
      `NAME="Nimbus"\nVERSION="${NIMBUS_VERSION}"\nID=nimbus\n`
      + 'PRETTY_NAME="Nimbus — Cloud Dev Environment"\n',
    );
    rootFs.chown('etc/os-release', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  }

  // Root-owned 0644, and re-asserted rather than only created: these decide
  // what `id`, `chown` and `su` believe, so a user-writable /etc/passwd would
  // be an authority bug rather than an untidy file.
  const accountFile = (path: string, content: string): void => {
    if (!rootFs.exists(path)) rootFs.writeFile(path, content, { mode: 0o644 });
    const stat = rootFs.stat(path);
    if (stat.uid !== 0 || stat.gid !== 0) rootFs.chown(path, 0, 0);
    if ((stat.mode & 0o7777) !== 0o644) rootFs.chmod(path, 0o644);
  };
  const passwdFor = (dir: string) => `root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:Nimbus User:${dir}:/bin/sh\n`;
  accountFile('etc/passwd', passwdFor(home));
  // The passwd every workspace got before its home was configurable named
  // /home/user. Exactly that file is Nimbus's to move to the configured home;
  // any other content is the user's.
  if (home !== DEFAULT_HOME && rootFs.readFileString('etc/passwd') === passwdFor(DEFAULT_HOME)) {
    rootFs.writeFile('etc/passwd', passwdFor(home));
  }
  accountFile('etc/group', 'root:x:0:\nuser:x:1000:user\n');

  // `$HOME` is expanded when the profile is sourced, so one profile serves
  // whatever home the session has.
  const defaultProfile = `export PATH=${defaultPath('$HOME')}\nexport EDITOR=nano\n`;
  // Profiles Nimbus seeded before: the lifo default, from before Nimbus had a
  // PATH of its own, and Nimbus's own with the home spelled out. Nobody ever
  // chose them, so replacing them is not overwriting a user's file.
  const seededProfiles = [
    'export PATH=/usr/bin:/bin\nexport EDITOR=nano\n',
    `export PATH=${defaultPath(DEFAULT_HOME)}\nexport EDITOR=nano\n`,
  ];
  if (!rootFs.exists('etc/profile')) {
    rootFs.writeFile('etc/profile', defaultProfile);
    rootFs.chown('etc/profile', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  } else if (seededProfiles.includes(rootFs.readFileString('etc/profile'))) {
    rootFs.writeFile('etc/profile', defaultProfile);
  }

  if (homeDir !== '' && !fs.exists(`${homeDir}/.nimbusrc`)) {
    fs.writeFile(`${homeDir}/.nimbusrc`,
      '# Nimbus shell config\nalias ll="ls -la"\nalias la="ls -a"\nalias l="ls -1"\n',
    );
  }
}
