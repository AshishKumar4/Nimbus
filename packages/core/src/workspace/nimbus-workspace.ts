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
import { createDigCommand } from '../substrate/lifo/commands/net/dig.js';
import { createPingCommand } from '../substrate/lifo/commands/net/ping.js';
import { workspaceNetwork, type WorkspaceEgress, type WorkspaceNetwork } from '../_shared/workspace-network.js';
import { runCommand, type CommandResult, type RunOptions } from '../substrate/lifo/sandbox/run-command.js';
import { HeadlessTerminal } from '../substrate/lifo/sandbox/HeadlessTerminal.js';
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
import { registerUnixCommands } from '../shell/unix-commands.js';
import { rehydrateGlobalPackages } from '../substrate/lifo/commands/system/lifo.js';
import { formatProcMounts, registerMountCommands } from '../shell/mount-commands.js';
import { installPathExecResolver } from '../shell/exec-dispatch.js';
import { adoptCtxExports, composeFabric, type CtxExports, type FabricComposition } from '@nimbus-sh/platform/composition.js';
import { createSupervisorOpHandler, type SupervisorOpEnvelope, type SupervisorOpHandler } from './supervisor-op.js';
import { NamedShells, SHELLS_TABLE, type NamedShell, type NamedShellOptions } from './named-shells.js';

export { parseShellState, type NamedShell, type NamedShellOptions, type ShellState } from './named-shells.js';

/** {@link NimbusWorkspace.exec}'s options: the command's, and which shell runs it. */
export interface WorkspaceExecOptions extends RunOptions {
  /**
   * Run in this named shell, whose cwd and environment persist between calls
   * the way a terminal tab's do; calls on one name run one at a time. 1 to
   * 160 characters from `A-Z a-z 0-9 . _ : -`, starting with a letter or
   * digit. Omitted, the call runs in a shell of its own.
   */
  readonly shellId?: string;
}

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
   * A plain process passes `localFacetHost(network)`, its network the
   * workspace's: `workspaceNetwork(egress)` beside `egress`, else
   * `ISOLATE_NETWORK`. A Durable Object passes nothing here and registers its
   * own runners instead, because the ones it needs carry REPLs and a
   * resident-process substrate this cannot reach.
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
  /**
   * The workspace's egress: every network request made on behalf of the
   * workspace's commands and programs goes through it. A Fetcher's `fetch`
   * and `connect` (`WorkspaceEgress`): `fetch` sees HTTP and WebSocket
   * upgrades, `connect` plain TCP sockets. Typically a service binding or a
   * `ctx.exports` entrypoint minted with the workspace's identity in its
   * props, which may record, rewrite or refuse each request.
   *
   * Covered: git's clone, fetch, pull and push (every Dynamic Worker they
   * load) and its on-demand object fetches; npm's registry and tarball
   * requests (the install facets, in this Durable Object and in peers);
   * curl, wget, dig and ping; pip's and gem's index requests and downloads;
   * a process's fetch, http/https, WebSocket and plain TCP
   * sockets; the one-shot runtimes and REPLs, whose facets go out through it
   * (with `facets`, bind them to this network: `loaderFacetHost(env, ctx,
   * workspaceNetwork(egress))`, `localFacetHost(workspaceNetwork(egress))`),
   * TLS CPython makes itself included; an inline
   * `node` program's fetch and http/https, streamed and redirected as Node's
   * fetch does; a worker or dev server a command starts.
   *
   * Refused: a process's TLS socket (`tls.connect`), because a Fetcher's
   * `connect()` carries plain TCP only and the TLS session could only be
   * made off the egress (HTTPS by fetch or `https` is not affected); the
   * WebSocket of an inline `node` program or a `localFacetHost` facet, which
   * cannot cross its realm.
   *
   * Not covered: responses from Nimbus's shared npm packument cache are not
   * used under an egress, so the egress sees every registry read, but
   * integrity-checked tarballs may still come from the shared tarball cache;
   * Nimbus's own infrastructure traffic (R2, the runtime catalog, OAuth, AI
   * inference, static assets, its own Durable Objects).
   *
   * Absent, the workspace uses the isolate's own network, as before.
   */
  readonly egress?: WorkspaceEgress;
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
  /**
   * The network the workspace's commands and programs use: its egress when
   * the host supplied one ({@link NimbusWorkspaceOptions.egress}), else the
   * isolate's. Everything that loads a Dynamic Worker for the workspace
   * gives it `loaderOutbound(workspace.network)`.
   */
  get network(): WorkspaceNetwork { return this.kernel.network; }
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

  private readonly namedShells: NamedShells;

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
    /** Who the workspace shell acts as, and so every call's process. */
    private readonly identity: ShellCommandIdentity,
  ) {
    this.vfs = vfs;
    this.kernel = kernel;
    this.shell = shell;
    this.registry = registry;
    this.env = env;
    this.processes = processes;
    this.runtimes = runtimes;
    this.shellProcessPid = shellProcessPid;
    // The shell's own process view: a host calling `.fs` acts as the
    // session user, never as the kernel. Its working directory is the
    // shell's before anything has run: create's `cwd`, else HOME.
    this.fs = new WorkspaceFs(shell.getVfs(), shell.getCwd());
    this.namedShells = new NamedShells(sql, this.fs.cwd, (pid, state) => this.shellFor(pid, state));
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
    // The namespace (SQLite at `/`, /proc, /dev, and an embedder's mounts)
    // and what binds processes to it. The base is seeded through it, so a
    // mount over /home or /etc gets what a program writing there would.
    const filesystem = options.filesystem ?? new ProcessFiles(vfs);
    if (filesystem.engine !== vfs) throw new Error('The workspace filesystem must be over the workspace SqliteVFS');
    await seedBaseFilesystem(filesystem, home);
    const kernel = new Kernel();
    kernel.network = workspaceNetwork(options.egress);
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
    // Its processes bind to this filesystem, so a reap releases them here:
    // the one place the table and the filesystem meet.
    processes.setRelease((pid) => filesystem.releaseProcess(pid));

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
    registry.register('dig', createDigCommand(kernel));
    registry.register('ping', createPingCommand(kernel));
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
          network: kernel.network,
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
        supervisorOps, filesystem, runtimeLease, identity,
      );
    } catch (error) {
      await runtimeLease.dispose();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.runtimeLease.dispose();
  }

  /**
   * Run `command` as a process of its own and collect what it printed.
   *
   * Without a `shellId` the call runs in a shell built for it alone (see
   * {@link shellFor}), from the workspace shell's cwd and environment with the
   * call's `cwd` and `env` on top, under a new process with the workspace
   * shell's credential and umask. What it changes (its cwd, variables,
   * functions, aliases, options, umask, descriptors) ends with it: none of it
   * reaches the next call or the workspace shell, and calls run at once
   * without seeing each other's. With a `shellId` it runs in that named shell
   * instead (see {@link withNamedShell}), and `cwd` and `env` hold for this
   * call only. Either way the process, and its child processes that have
   * ended, leave the process table when the result is returned.
   */
  exec(command: string, options: WorkspaceExecOptions = {}): Promise<CommandResult> {
    const { shellId, ...call } = options;
    if (shellId === undefined) return this.runProcess(command, call, null);
    return this.withNamedShell(shellId, {}, (named) => this.runProcess(command, call, named));
  }

  private async runProcess(command: string, options: RunOptions, named: NamedShell | null): Promise<CommandResult> {
    const cwd = options.cwd ?? named?.cwd ?? this.shell.getCwd();
    const { pid } = this.processes.spawn(command, [command], cwd, { cred: this.identity.cred });
    // A shell of the call's own already starts from its cwd and env. A named
    // shell takes them for the call only: passed as its state they would pin
    // it there, and its `cd` would not survive the call.
    const shell = named?.open(pid) ?? this.shellFor(pid, { cwd, env: options.env });
    let exitCode = 1;
    try {
      const result = await runCommand(shell, command, named ? options : { ...options, cwd: undefined, env: undefined });
      exitCode = result.exitCode;
      return result;
    } finally {
      this.processes.exit(pid, exitCode);
      // Its descriptors close as it exits; its entry, and what it bound in
      // the filesystem, go even if one fails to.
      try {
        await shell.closeDescriptors();
      } finally {
        await this.processes.reapTree(pid);
      }
    }
  }

  /**
   * A shell of its own for process `pid`, a second cwd and environment over
   * the workspace shell's filesystem, commands and kernel. It starts in
   * `state.cwd` with the workspace shell's environment and `state.env` on
   * top. Its commands act as `pid` (`$$`, and the credential and umask
   * {@link processes} holds for it); `sudo` and `su` go through the workspace
   * shell's identity, and `kill` reaches what the workspace shell's does.
   *
   * For a host that runs a command under a process of its own. When that
   * process ends, {@link Shell.closeDescriptors} closes what an `exec` in it
   * left open.
   */
  shellFor(pid: number, state: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> }): Shell {
    const processes = this.processes;
    const shell = new Shell(
      new HeadlessTerminal(),
      this.filesystem,
      this.registry,
      { ...this.shell.getEnv(), ...state.env, $: String(pid) },
      this.kernel.processRegistry,
      {
        pid,
        get cred() { return processes.cred(pid); },
        setUmask: (mask: number) => processes.setUmask(pid, mask),
        runAs: this.shell.getRunAsHost(),
        accountWork: (worker: number) => processes.beginWork(worker),
      },
    );
    const hostSignals = this.shell.getHostProcessSignals();
    if (hostSignals) shell.setHostProcessSignals(hostSignals);
    shell.setCwd(state.cwd);
    return shell;
  }

  /**
   * Run `body` in the named shell `id` (see named-shells.ts): in the cwd and
   * environment the last call on that name left it with, else
   * `options.start`, one call on the name at a time.
   *
   * {@link exec} with a `shellId` is this around one command. A host that
   * runs its own process around the shell (a session's exec and background
   * jobs) calls it directly, and builds the shell with `open(pid)`.
   */
  withNamedShell<T>(id: string, options: NamedShellOptions, body: (shell: NamedShell) => Promise<T>): Promise<T> {
    return this.namedShells.hold(id, options, body);
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
    // The command that started it (sudo, su, find -exec) awaits it, and its
    // program is its own work, until it ends: the session tells a chain of
    // them doing nothing but await a program (SessionProcessSupervisor).
    const endAwait = processes.beginAwait(parent.pid, child.pid);
    const endWork = processes.beginWork(child.pid);
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
      endWork();
      endAwait();
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
    accountWork: (worker: number) => processes.beginWork(worker),
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
  network: WorkspaceNetwork;
}): void {
  // wasm-runner allocates pids for what it runs, off the SAME supervisor the
  // shell identity uses — the host's own when it supplied one.
  const processes = deps.processes;

  const wasmRunner = once(async (): Promise<Command> => {
    const [{ wasmRunnerSpec }, { buildRuntimeHandler }] = await Promise.all([
      import('../runtime/wasm-runner.js'),
      import('../runtime/runtime-registry.js'),
    ]);
    return buildRuntimeHandler(
      wasmRunnerSpec({ filesystem: deps.filesystem, facets: deps.facets, processes }),
      {
        // wasm-runner reads its .wasm itself (bypassesScriptRead), so the
        // registry never asks a workspace for a transformer: none is loaded.
        getEsbuild: () => {
          throw new Error('Nimbus: a workspace runs no JavaScript source, so it has no transformer');
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
      .makeCPythonRunnerFactory({ facets: deps.facets, network: deps.network })),
    'ruby-runner': lazy(async () => (await import('../runtime/ruby-runner.js'))
      .makeRubyRunnerFactory({ facets: deps.facets, filesystem: deps.filesystem, registry: deps.registry, getHome: deps.getHome, network: deps.network })),
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
 * Every table the workspace creates: the filesystem's, and its named shells.
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
  SHELLS_TABLE,
] as const;

/**
 * A step of the base seed (baseSeed): a read whose answer it needs, or a
 * write. Paths are keys (no leading slash); `as` is whose call it is.
 */
type SeedStep =
  | { op: 'exists'; as: 'kernel' | 'user'; path: string }
  | { op: 'stat'; as: 'kernel'; path: string }
  | { op: 'readText'; as: 'kernel'; path: string }
  | { op: 'mkdir'; as: 'kernel' | 'user'; path: string; recursive?: boolean; mode?: number }
  | { op: 'chown'; as: 'kernel'; path: string; uid: number; gid: number }
  | { op: 'chmod'; as: 'kernel'; path: string; mode: number }
  | { op: 'writeFile'; as: 'kernel' | 'user'; path: string; content: string; mode?: number };

/** What a `stat` step answers. */
interface SeedStat { uid: number; gid: number; mode: number }

/**
 * The base seed's one statement, driven by seedBaseFilesystem: on the
 * engine directly, or on a namespace, where each step lands where a
 * program's call would (a mount over /home or /etc included).
 */
function* baseSeed(home: string): Generator<SeedStep, void, unknown> {
  const exists = function* (as: 'kernel' | 'user', path: string): Generator<SeedStep, boolean, unknown> {
    return (yield { op: 'exists', as, path }) as boolean;
  };
  const stat = function* (path: string): Generator<SeedStep, SeedStat, unknown> {
    return (yield { op: 'stat', as: 'kernel', path }) as SeedStat;
  };

  // Top-level directories are the kernel's to make (`/` is 0755 root), and
  // handed to the session user, who owns their own tree: seeding them owned
  // by the kernel is what makes a workspace where `.fs` cannot write.
  for (const top of SEEDED_TOP_LEVEL_DIRS) {
    if (top === 'etc' || (yield* exists('kernel', top))) continue;
    yield { op: 'mkdir', as: 'kernel', path: top, mode: 0o777 & ~CRED_SESSION_USER.umask };
    yield { op: 'chown', as: 'kernel', path: top, uid: CRED_SESSION_USER.uid, gid: CRED_SESSION_USER.gid };
  }
  // The home is made the way useradd -m makes it: by root, wherever it is,
  // then handed to the user. Its parents stay root's.
  const homeDir = home.replace(/^\/+/, '').replace(/\/+$/, '');
  if (homeDir !== '' && !(yield* exists('kernel', homeDir))) {
    yield { op: 'mkdir', as: 'kernel', path: homeDir, recursive: true, mode: 0o755 };
    yield { op: 'chown', as: 'kernel', path: homeDir, uid: CRED_SESSION_USER.uid, gid: CRED_SESSION_USER.gid };
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
    if (!(yield* exists('user', dir))) yield { op: 'mkdir', as: 'user', path: dir, recursive: true };
  }

  // /etc belongs to root, and is re-asserted rather than only created: a
  // user-writable /etc is an authority bug, not an untidy directory.
  if (!(yield* exists('kernel', 'etc'))) {
    yield { op: 'mkdir', as: 'kernel', path: 'etc', mode: 0o755 };
  } else {
    const etc = yield* stat('etc');
    if (etc.uid !== 0 || etc.gid !== 0) yield { op: 'chown', as: 'kernel', path: 'etc', uid: 0, gid: 0 };
    if ((etc.mode & 0o7777) !== 0o755) yield { op: 'chmod', as: 'kernel', path: 'etc', mode: 0o755 };
  }

  if (!(yield* exists('kernel', 'etc/hostname'))) {
    yield { op: 'writeFile', as: 'kernel', path: 'etc/hostname', content: `${DEFAULT_HOSTNAME}\n` };
    yield { op: 'chown', as: 'kernel', path: 'etc/hostname', uid: CRED_SESSION_USER.uid, gid: CRED_SESSION_USER.gid };
  }
  if (!(yield* exists('kernel', 'etc/os-release'))) {
    yield {
      op: 'writeFile', as: 'kernel', path: 'etc/os-release',
      content: `NAME="Nimbus"\nVERSION="${NIMBUS_VERSION}"\nID=nimbus\n` + 'PRETTY_NAME="Nimbus — Cloud Dev Environment"\n',
    };
    yield { op: 'chown', as: 'kernel', path: 'etc/os-release', uid: CRED_SESSION_USER.uid, gid: CRED_SESSION_USER.gid };
  }

  // Root-owned 0644, and re-asserted rather than only created: these decide
  // what `id`, `chown` and `su` believe, so a user-writable /etc/passwd would
  // be an authority bug rather than an untidy file.
  const accountFile = function* (path: string, content: string): Generator<SeedStep, void, unknown> {
    if (!(yield* exists('kernel', path))) yield { op: 'writeFile', as: 'kernel', path, content, mode: 0o644 };
    const current = yield* stat(path);
    if (current.uid !== 0 || current.gid !== 0) yield { op: 'chown', as: 'kernel', path, uid: 0, gid: 0 };
    if ((current.mode & 0o7777) !== 0o644) yield { op: 'chmod', as: 'kernel', path, mode: 0o644 };
  };
  const passwdFor = (dir: string) => `root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:Nimbus User:${dir}:/bin/sh\n`;
  yield* accountFile('etc/passwd', passwdFor(home));
  // The passwd every workspace got before its home was configurable named
  // /home/user. Exactly that file is Nimbus's to move to the configured home;
  // any other content is the user's.
  if (home !== DEFAULT_HOME && (yield { op: 'readText', as: 'kernel', path: 'etc/passwd' }) === passwdFor(DEFAULT_HOME)) {
    yield { op: 'writeFile', as: 'kernel', path: 'etc/passwd', content: passwdFor(home) };
  }
  yield* accountFile('etc/group', 'root:x:0:\nuser:x:1000:user\n');

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
  if (!(yield* exists('kernel', 'etc/profile'))) {
    yield { op: 'writeFile', as: 'kernel', path: 'etc/profile', content: defaultProfile };
    yield { op: 'chown', as: 'kernel', path: 'etc/profile', uid: CRED_SESSION_USER.uid, gid: CRED_SESSION_USER.gid };
  } else if (seededProfiles.includes((yield { op: 'readText', as: 'kernel', path: 'etc/profile' }) as string)) {
    yield { op: 'writeFile', as: 'kernel', path: 'etc/profile', content: defaultProfile };
  }

  if (homeDir !== '' && !(yield* exists('user', `${homeDir}/.nimbusrc`))) {
    yield {
      op: 'writeFile', as: 'user', path: `${homeDir}/.nimbusrc`,
      content: '# Nimbus shell config\nalias ll="ls -la"\nalias la="ls -a"\nalias l="ls -1"\n',
    };
  }
}

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
export function seedBaseFilesystem(vfs: SqliteVFS, home?: string): void;
export function seedBaseFilesystem(filesystem: ProcessFiles, home?: string): Promise<void>;
export function seedBaseFilesystem(target: SqliteVFS | ProcessFiles, home: string = DEFAULT_HOME): void | Promise<void> {
  const steps = baseSeed(home);
  if (target instanceof ProcessFiles) return seedOnNamespace(steps, target);
  const views = { kernel: target.as(CRED_KERNEL), user: target.as(CRED_SESSION_USER) };
  for (let step = steps.next(); !step.done; ) step = steps.next(engineStep(views[step.value.as], step.value));
}

/**
 * The base seed on a namespace: a step on a mount is the call a program
 * would make there; any other is the engine's, as the session's own seed
 * makes it (a directory above a mount point included, which the namespace
 * shows once the root holds it).
 */
async function seedOnNamespace(steps: Generator<SeedStep, void, unknown>, filesystem: ProcessFiles): Promise<void> {
  const mounted = { kernel: filesystem.vfs.as(CRED_KERNEL), user: filesystem.vfs.as(CRED_SESSION_USER) };
  const engine = { kernel: filesystem.engine.as(CRED_KERNEL), user: filesystem.engine.as(CRED_SESSION_USER) };
  const text = new TextEncoder();
  for (let step = steps.next(); !step.done; ) {
    const call = step.value;
    let answer: unknown;
    if (filesystem.vfs.mountOf('/' + call.path) === '/') {
      answer = engineStep(engine[call.as], call);
    } else {
      const view = mounted[call.as];
      const path = '/' + call.path;
      switch (call.op) {
        case 'exists': answer = (await view.stat(path)) !== null; break;
        case 'stat': {
          const found = await view.stat(path);
          if (found === null) throw new Error(`seed: ${path} vanished`);
          answer = { uid: found.uid ?? 0, gid: found.gid ?? 0, mode: found.mode ?? 0 };
          break;
        }
        case 'readText': answer = new TextDecoder().decode(await view.readFile(path)); break;
        case 'mkdir': await view.mkdir(path, { ...(call.recursive ? { recursive: true } : {}), ...(call.mode === undefined ? {} : { mode: call.mode }) }); break;
        // A mount that keeps no owners or modes (ENOTSUP) has none to hand over.
        case 'chown': await unlessUnsupported(view.chown(path, call.uid, call.gid)); break;
        case 'chmod': await unlessUnsupported(view.chmod(path, call.mode)); break;
        case 'writeFile': await view.writeFile(path, text.encode(call.content), call.mode === undefined ? undefined : { mode: call.mode }); break;
      }
    }
    step = steps.next(answer);
  }
}

/** A seed step on an engine view: its answer. */
function engineStep(view: ReturnType<SqliteVFS['as']>, call: SeedStep): unknown {
  switch (call.op) {
    case 'exists': return view.exists(call.path);
    case 'stat': return view.stat(call.path);
    case 'readText': return view.readFileString(call.path);
    case 'mkdir': view.mkdir(call.path, { ...(call.recursive ? { recursive: true } : {}), ...(call.mode === undefined ? {} : { mode: call.mode }) }); return undefined;
    case 'chown': view.chown(call.path, call.uid, call.gid); return undefined;
    case 'chmod': view.chmod(call.path, call.mode); return undefined;
    case 'writeFile': view.writeFile(call.path, call.content, call.mode === undefined ? undefined : { mode: call.mode }); return undefined;
  }
}

async function unlessUnsupported(call: unknown): Promise<void> {
  try {
    await call;
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOTSUP') throw error;
  }
}
