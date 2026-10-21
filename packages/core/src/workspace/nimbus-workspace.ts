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

import { startProgram } from './start-program.js';
import type { Program, StartedSessionProgram } from '../runtime/program-start.js';
import { createKillCommand, type HostProcessSignals } from '../substrate/lifo/commands/system/kill.js';
import { Kernel } from '../substrate/lifo/kernel/index.js';
import { Shell } from '../substrate/lifo/shell/Shell.js';
import type { VariableAttributes } from '../substrate/lifo/shell/variables.js';
import type { ShellCommandIdentity } from '../substrate/lifo/shell/Shell.js';
import { createDefaultRegistry } from '../substrate/lifo/commands/registry.js';
import type { CommandRegistry } from '../substrate/lifo/commands/registry.js';
import type { Command, CommandRunAsHost } from '../substrate/lifo/commands/types.js';
import { createNodeCommand } from '../substrate/lifo/commands/system/node.js';
import { createCurlCommand } from '../substrate/lifo/commands/net/curl.js';
import { createWgetCommand } from '../substrate/lifo/commands/net/wget.js';
import { createDigCommand } from '../substrate/lifo/commands/net/dig.js';
import { createPingCommand } from '../substrate/lifo/commands/net/ping.js';
import { selectProcessEgress, workspaceNetwork, type EgressFor, type WorkspaceEgress, type WorkspaceNetwork } from '../_shared/workspace-network.js';
import { runCommand, type CommandResult, type RunOptions } from '../substrate/lifo/sandbox/run-command.js';
import { HeadlessTerminal } from '../substrate/lifo/sandbox/HeadlessTerminal.js';
import type { ITerminal } from '../substrate/lifo/terminal/ITerminal.js';
import { SqliteVFS, STORE_TABLES } from '../vfs/sqlite-vfs.js';
import {
  DEFAULT_HOME, DEFAULT_HOSTNAME, defaultPath, SEEDED_TOP_LEVEL_DIRS,
  DEFAULT_SHELL, DEFAULT_USER, NIMBUS_VERSION,
} from '../constants.js';
import { BASH_RUNNER_CONTRACTS, CPYTHON_RUNNER_CONTRACTS, GIT_RUNNER_CONTRACTS, CRED_KERNEL, CRED_SESSION_USER, type NimbusHostFilesystemLease } from '../runtime/os-contracts.js';
import type { SqlDatabase, TransactionHost, NimbusFilesystemAuthority } from '../runtime/os-contracts.js';
import { ProcessFiles } from '../runtime/process-files.js';
import { ProcessView } from '../runtime/process-files.js';
import { WorkspaceFs } from './workspace-fs.js';
import { PID_GEN_STRIDE, type ProcessEntry } from '../runtime/process-table.js';
import { isKillRefusal, SessionProcessSupervisor, type IdentityChangePolicy } from '../runtime/session-process-supervisor.js';
import { ChildProcessManager, type ChildProcessHost } from '../runtime/child-process-manager.js';
import { resolveWorkspaceChild } from './child-process-runner.js';
import { exitCodeForSignal, signalAbortReason, signalAbortReasonOf, signalDisposition, signalOfStatus } from '../substrate/lifo/shell/signals.js';
import type { FacetHost } from '../runtime/facet-host.js';
import { runtimeEntrypoints, type RunnerFactory } from '../runtime/installed-runtimes.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import { moveHomeRuntimes, RUNTIME_STORE } from '../runtime/runtime-store.js';
import { normalizeVfsPath } from '../vfs/path.js';
import { makeNimbusVerbHandler } from '../runtime/nimbus-command.js';
import {
  composeRuntimeSources,
  suppliedRuntimeSource,
  type RuntimePackage,
  type RuntimeSource,
} from '../runtime/runtime-package.js';
import { registerUnixCommands } from '../shell/unix-commands.js';
import { formatProcMounts, registerMountCommands } from '../shell/mount-commands.js';
import { installPathExecResolver } from '../shell/exec-dispatch.js';
import { adoptCtxExports, composeFabric, type CtxExports, type FabricComposition } from '@nimbus-sh/platform/composition.js';
import { createSupervisorOpHandler, type SupervisorOpEnvelope, type SupervisorOpHandler } from './supervisor-op.js';
import { NamedShells, SHELLS_TABLE, type NamedShell, type NamedShellOptions, type ShellState } from './named-shells.js';

export { parseShellState, parseVariableAttributes, TerminalNameSchema, type NamedShell, type NamedShellOptions, type ShellState } from './named-shells.js';
export type { VariableAttributes } from '../substrate/lifo/shell/variables.js';
export type { IdentityChangePolicy } from '../runtime/session-process-supervisor.js';

/** {@link NimbusWorkspace.exec}'s options: the command's, and which shell runs it. */
export interface WorkspaceExecOptions extends RunOptions {
  /**
   * Run in this named shell, whose cwd and environment persist between calls
   * the way a terminal tab's do; calls on one name run one at a time. 1 to
   * 160 characters from `A-Z a-z 0-9 . _ : -`, starting with a letter or
   * digit. Omitted, the call runs in a shell of its own.
   */
  readonly shellId?: string;
  /** Release a named shell without ending this process or saving its later state. */
  readonly detach?: AbortSignal;
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
   * Who the shell acts as: a process of `processes`, which the host keeps
   * alive. Absent, the workspace spawns the shell's process there.
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
  readonly childProcesses?: ChildProcessHost;
  readonly processOutput?: (stream: 'stdout' | 'stderr', pid: number, data: Uint8Array) => void | Promise<void>;
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
   * A process's TLS socket (`tls.connect`) goes through the egress's optional
   * `connectTls`, which makes the TLS session; without it, it is refused by
   * name. Refused: TLS over a socket the program opened
   * (`tls.connect({ socket })`, STARTTLS), since the egress carries that
   * connection and workerd starts no TLS on one through a service binding;
   * the WebSocket of an inline `node` program or a `localFacetHost` facet,
   * which cannot cross its realm.
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
  /**
   * The egress for one process of the workspace, `{ pid, execId }`: asked
   * once per process while it lives, so everything the process does goes
   * through the one it returns: its fetch, sockets and TLS, the commands it
   * runs (curl, git, npm, pip and the rest), and its own Dynamic Worker,
   * wherever it is hosted. Typically `egress` minted again with the exec in
   * its props, so the host can tell which exec made each request. Undefined
   * keeps `egress` for that process. Requires `egress`, which still carries
   * the workspace's work that no process makes. A host that builds the
   * network for its `facets` itself makes it with
   * `selectProcessEgress(egress, egressFor, processes)` over the same
   * `processes`; a process is still asked for once.
   */
  readonly egressFor?: EgressFor;
  /**
   * Whether a process running as `from` may start `command` as `to`: asked
   * before every process made under a credential other than its parent's
   * (sudo, su, any command's runAs), whichever path makes it. Refused, the
   * spawn fails with EPERM, naming both uids and the command. A process the
   * host starts with no parent (an exec, a restart) is the host's own choice
   * and not asked. Absent: every change is allowed.
   */
  readonly mayChangeIdentity?: IdentityChangePolicy;
}

/** Where a named terminal's history is kept unless it names a file of its own. */
function terminalHistory(home: string, name: string): string {
  return `${home}/.local/state/nimbus/terminals/${name}.history`;
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
    readonly children: ChildProcessManager,
    runtimes: RuntimeManager,
    shellProcessPid: number,
    private readonly supervisorOps: (envelope: SupervisorOpEnvelope) => Promise<unknown>,
    readonly filesystem: ProcessFiles,
    private readonly hostLeases: readonly NimbusHostFilesystemLease[],
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
    // Root makes a home and hands it to the user: inside the system's own
    // stores, the runtimes' (runtime-store.ts) or the kernel's, that would
    // hand the user a directory the kernel writes, unpacks into and clears.
    const homeKey = normalizeVfsPath(home);
    for (const store of [RUNTIME_STORE, '.nimbus']) {
      if (homeKey === store || homeKey.startsWith(`${store}/`)) {
        throw new Error(`HOME must not be inside /${store}, the system's own store, got ${JSON.stringify(home)}`);
      }
    }
    // The namespace (SQLite at `/`, /proc, /dev, and an embedder's mounts)
    // and what binds processes to it. The base is seeded through it, so a
    // mount over /home or /etc gets what a program writing there would.
    const filesystem = options.filesystem ?? new ProcessFiles(vfs);
    if (filesystem.engine !== vfs) throw new Error('The workspace filesystem must be over the workspace SqliteVFS');
    await seedBaseFilesystem(filesystem, home);
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
    if (options.mayChangeIdentity !== undefined) processes.governIdentityChanges(options.mayChangeIdentity);
    if (options.egressFor !== undefined && options.egress === undefined) {
      throw new TypeError('NimbusWorkspace: egressFor refines egress, the workspace\'s own network; give both');
    }
    kernel.network = options.egress !== undefined && options.egressFor !== undefined
      ? selectProcessEgress(options.egress, options.egressFor, processes)
      : workspaceNetwork(options.egress);
    // Its processes bind to this filesystem, so a reap releases them here,
    // and their output waits for what they wrote to be published: the one
    // place the table and the filesystem meet.
    processes.setRelease((pid) => filesystem.releaseProcess(pid), (pid) => filesystem.processEnded(pid));
    filesystem.holdOutput(processes);

    const env = { ...defaultEnv(home), ...options.env };
    let workspace: NimbusWorkspace | null = null;
    const children = new ChildProcessManager({
      processes,
      resolve: (request, origin) => {
        if (!workspace) throw new Error('Nimbus: workspace is not initialized');
        return resolveWorkspaceChild(workspace, request, origin);
      },
      terminate: (pid, signal) => processes.kill(pid, exitCodeForSignal(signal), signalAbortReason(signal)),
    });
    if (options.childProcesses) children.bindHost(options.childProcesses);
    const host = options.facets;
    const facets: FacetHost | undefined = host ? {
      parking: host.parking,
      memoryBudgetBytes: host.memoryBudgetBytes,
      open: spec => host.open({
        ...spec,
        syscalls: spec.syscalls ? { ...spec.syscalls, children } : undefined,
      }),
    } : undefined;

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
      processes,
      identity,
    );
    if (options.cwd) shell.setCwd(options.cwd);
    // Past a shell's own jobs, `kill` reaches by pid every process this
    // workspace runs work for (another shell's job, an exec, a child
    // process), and ends it by stopping that work; never the workspace's
    // own shell, which outlives every line it runs. A host that runs
    // processes of its own replaces this (Shell.setHostProcessSignals).
    const processSignals: HostProcessSignals = {
      isLive: (pid) => pid === shellProcessPid || processes.runsWork(pid),
      async signal(pid, signal, _stderr, caller) {
        const disposition = signal === '0' ? null : signalDisposition(signal);
        if (disposition === 'terminate' && pid !== shellProcessPid) {
          // The kill makes kill(2)'s check itself.
          try {
            return processes.killAs(caller, pid, exitCodeForSignal(signal), signalAbortReason(signal)) ? 'delivered' : 'no-such-process';
          } catch (error) {
            if (isKillRefusal(error)) return 'not-permitted';
            throw error;
          }
        }
        // A signal that ends nothing asks the same rule alone.
        if (!processes.maySignal(caller, pid)) return 'not-permitted';
        if (disposition === null) return 'delivered';
        if (pid === shellProcessPid) return 'not-permitted';
        // A default-ignored signal (CHLD, URG, WINCH) is delivered and does nothing, as on Linux.
        return disposition === 'ignore' ? 'delivered' : 'unsupported';
      },
    };
    shell.setHostProcessSignals(processSignals);

    // node/curl/wget are bound to THIS workspace's kernel: their localhost
    // traffic resolves through its port registry and loopback router, not the
    // process-wide defaults the lazily-loaded commands would share.
    registry.register('node', createNodeCommand(kernel));
    registry.register('curl', createCurlCommand(kernel));
    registry.register('wget', createWgetCommand(kernel));
    registry.register('dig', createDigCommand(kernel));
    registry.register('ping', createPingCommand(kernel));
    // kill as a program (`xargs kill`): no jobs, the processes the shell's reaches by pid.
    registry.register('kill', createKillCommand(processSignals));

    const getHome = () => shell.getEnv().HOME ?? DEFAULT_HOME;
    const kernelFs = vfs.as(CRED_KERNEL);
    // Everything from the first lease on can throw — a lease refused, a
    // runtime source that fails to list, a package that will not install.
    // The workspace it would have belonged to is never constructed, so
    // nobody is left to close() it: each lease is released here.
    const hostLeases: NimbusHostFilesystemLease[] = [];
    try {
      // The kernel's, for the runtime store; the session user's for what the
      // owner put there: a lookup with no caller of its own, and the packages
      // they installed globally, are read as they would read them.
      const runtimeLease = filesystem.openHost(CRED_KERNEL);
      hostLeases.push(runtimeLease);
      const ownerLease = filesystem.openHost(CRED_SESSION_USER);
      hostLeases.push(ownerLease);
      // A lookup without a caller's view INSPECTS a file to decide how to run
      // it as the session user, and the caller's own execute permission is
      // checked again at invocation — the `authorize` wrapper in
      // exec-dispatch.ts. It inspects through the namespace's awaiting face,
      // so a script on an asynchronous mount runs by its path like any other.
      installPathExecResolver(registry, new ProcessView(ownerLease.fs), () => shell.getCwd());

      const runtimes = new RuntimeManager({
        vfs: new ProcessView(runtimeLease.fs),
        registry,
        source: options.runtimeSource
          ? composeRuntimeSources([suppliedRuntimeSource(options.runtimes ?? []), options.runtimeSource])
          : suppliedRuntimeSource(options.runtimes ?? []),
      });
      // Runtimes an earlier release installed below the home move into the
      // store (/usr/lib/nimbus), once, before anything installs or binds.
      try {
        moveHomeRuntimes(kernelFs, home);
      } catch (error) {
        console.error('[nimbus] runtimes below ~/.nimbus/runtimes were not moved to /usr/lib/nimbus:', error);
      }

      if (facets) {
        registerWasmRuntimes({
          facets,
          sql: options.sql,
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
      workspace = new NimbusWorkspace(
        vfs, kernel, shell, registry, env, options.sql,
        processes, children, runtimes, shellProcessPid,
        supervisorOps, filesystem, hostLeases, identity,
      );
      return workspace;
    } catch (error) {
      // What ended create() is what it throws, though a release fails too.
      await releaseHostLeases(hostLeases).catch(() => {});
      throw error;
    }
  }

  async close(): Promise<void> {
    await releaseHostLeases(this.hostLeases);
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
   * ended, leave the process table when the result is returned; one that ends
   * later (a background job) leaves at the first call to start a minute after.
   */
  /**
   * `program` started by its argv (Kinu ask 67): the start contract a
   * mount's exec delegate meets (ExecDelegate.start), placed by its cwd as
   * every start is. Its stdin, output, exit and signals are the child
   * broker's (workspace/start-program.ts).
   */
  startProgram(program: Program, cancel: AbortSignal): Promise<StartedSessionProgram> {
    return startProgram({ children: this.children, processes: this.processes, cred: this.identity.cred }, program, cancel);
  }

  exec(command: string, options: WorkspaceExecOptions = {}): Promise<CommandResult> {
    const { shellId, detach, ...call } = options;
    if (shellId === undefined) return this.runProcess(command, call, null);
    return this.withNamedShell(shellId, { detach }, (named) => this.runProcess(command, call, named));
  }

  private async runProcess(command: string, options: RunOptions, named: NamedShell | null): Promise<CommandResult> {
    // The table is pruned as a launch begins, as a hosted session's is: what
    // ended more than a minute ago, a job that outlived its exec among them.
    await this.processes.reap();
    const cwd = options.cwd ?? named?.cwd ?? this.shell.getCwd();
    const { pid } = this.processes.spawn(command, [command], cwd, { cred: this.identity.cred });
    // A shell of the call's own already starts from its cwd and env. A named
    // shell takes them for the call only: passed as its state they would pin
    // it there, and its `cd` would not survive the call.
    const shell = named?.open(pid) ?? this.shellFor(pid, { cwd, env: options.env });
    // The call is this workspace's work behind the pid until its shell has
    // closed what it opened: a kill stops it, and only then is what it bound
    // released.
    const stop = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
    const stopped = this.processes.holdWork(pid, (reason) => stop.abort(reason), signal);
    let exitCode = 1;
    try {
      const result = await runCommand(shell, command, { ...(named ? options : { ...options, cwd: undefined, env: undefined }), signal });
      exitCode = result.exitCode;
      return result;
    } finally {
      this.processes.exit(pid, exitCode);
      // Its descriptors close as it exits; its entry, and what it bound in
      // the filesystem, go even if one fails to.
      try {
        await shell.closeDescriptors();
      } finally {
        stopped();
        await this.processes.reapTree(pid);
      }
    }
  }

  /**
   * A shell of its own for process `pid`, a second cwd and environment over
   * the workspace shell's filesystem, commands and kernel. It starts in
   * `state.cwd` with the workspace shell's environment (its exported
   * variables, as any process it started would have) and `state.env` on
   * top; with `inheritEnv: false`, with `state.env` alone (a command run again
   * as it was once run). Its commands act as `pid` (`$$`, and the credential and umask
   * {@link processes} holds for it); `sudo` and `su` go through the workspace
   * shell's identity, and `kill` reaches what the workspace shell's does.
   *
   * For a host that runs a command under a process of its own. When that
   * process ends, {@link Shell.closeDescriptors} closes what an `exec` in it
   * left open.
   */
  shellFor(pid: number, state: {
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly vars?: VariableAttributes;
    readonly inheritEnv?: boolean;
  }): Shell {
    const processes = this.processes;
    const shell = new Shell(
      new HeadlessTerminal(),
      this.filesystem,
      this.registry,
      // The workspace shell's environment as a process it starts gets it: its exported variables.
      { ...(state.inheritEnv === false ? {} : this.shell.getExportedEnv()), ...state.env },
      processes,
      {
        pid,
        get cred() { return processes.cred(pid); },
        setUmask: (mask: number) => processes.setUmask(pid, mask),
        runAs: this.shell.getRunAsHost(),
      },
    );
    const hostSignals = this.shell.getHostProcessSignals();
    if (hostSignals) shell.setHostProcessSignals(hostSignals);
    shell.setCwd(state.cwd);
    // A saved shell's bindings, over the variables it was saved with (named-shells.ts), after
    // setCwd's PWD: an array named PWD is the saved state's.
    if (state.vars !== undefined) shell.restoreVariableAttributes(state.vars, Object.keys(state.env ?? {}));
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

  /** Read a named shell's saved cwd and exact UTF-16 environment, or null if it has no saved state. */
  shellState(id: string): Promise<ShellState | null> {
    return this.namedShells.read(id);
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
    await this.startShell(this.shell);
  }

  /** A terminal's shell started as the workspace's is: its login files, then its first prompt. */
  async startShell(shell: Shell): Promise<void> {
    // Sources /etc/profile and the first user rc file it finds, then prompts.
    const started = shell.start();
    // Nimbus's own rc file, which the shell's list predates.
    await shell.sourceFile(`${shell.getEnv().HOME ?? DEFAULT_HOME}/.nimbusrc`);
    // Settled only once the shell has prompted, so a host that awaits this
    // can hand the shell input that belongs after the prompt.
    await started;
  }

  /**
   * The named terminal `name`'s shell, for its own process `pid`: where it
   * last was (its saved state), else where the workspace started, with its
   * history in a file of its own (HISTFILE, unexported, as bash's is) unless
   * it names one.
   */
  async terminalShell(name: string, pid: number): Promise<Shell> {
    const shell = this.shellFor(pid, this.namedShells.terminalState(name) ?? { cwd: this.fs.cwd });
    const env = shell.getEnv();
    if (env.HISTFILE === undefined) {
      const history = terminalHistory(env.HOME ?? DEFAULT_HOME, name);
      await shell.getVfs().mkdir(history.slice(0, history.lastIndexOf('/')), { recursive: true });
      env.HISTFILE = history;
    }
    return shell;
  }

  /** Save where the named terminal `name`'s shell is now: its cwd and variables. */
  saveTerminalShell(name: string, shell: Shell): void {
    this.namedShells.saveTerminalState(name, { cwd: shell.getCwd(), env: shell.getEnv(), vars: shell.getVariableAttributes() });
  }

  /** The named terminal `name`'s saved state forgotten, and the history file it was given removed. */
  async forgetTerminalShell(name: string): Promise<void> {
    const saved = this.namedShells.terminalState(name);
    this.namedShells.forgetTerminal(name);
    const history = saved?.env.HISTFILE;
    if (history !== undefined && history === terminalHistory(saved?.env.HOME ?? DEFAULT_HOME, name)) await this.fs.remove(history, { force: true });
  }

  /** The named terminals with saved state. */
  terminalNames(): string[] {
    return this.namedShells.terminalNames();
  }

  /** Where the named terminal `name`'s shell was last saved, or null. */
  terminalState(name: string): ShellState | null {
    return this.namedShells.terminalState(name);
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

/** Open the durable filesystem for a host that has not opened one itself. */
function openFilesystem(options: NimbusWorkspaceOptions): SqliteVFS {
  return new SqliteVFS(options.sql, options.transactions, options.filesystemNamespace);
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
    PORT: '3000',
    HOST: '0.0.0.0',
  };
}

/** Every lease released, though one release fails; the first failure is thrown once all have been tried. */
async function releaseHostLeases(leases: readonly NimbusHostFilesystemLease[]): Promise<void> {
  // Each asked in its own promise, so one that throws at once stops no other.
  const failed = (await Promise.allSettled(leases.map(async (lease) => lease.dispose()))).find((outcome) => outcome.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
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
    // Its program is this workspace's work behind its pid: a kill stops it.
    const stopped = processes.holdWork(child.pid, undefined, parent.signal);
    let exitCode = 1;
    try {
      stopped.signal.throwIfAborted();
      // The child inherits its parent's descriptors, environment and directory.
      const ran = await getShell().runProgram(argv, {
        identity: commandIdentityFor(child.pid),
        cwd: parent.cwd,
        env: parent.env,
        stdin: parent.stdin,
        stdout: parent.stdout,
        stderr: parent.stderr,
        terminalStdin: parent.terminalStdin,
        isFdTerminal: parent.isFdTerminal,
        isFdPipe: parent.isFdPipe,
        signal: stopped.signal,
        runAs: runAsProcess,
      });
      exitCode = ran.status;
      // A kill of it is its end, as its entry holds it (the one spawn gave,
      // kept even once a prune forgets it), whatever its program returned on
      // its way out (a closed pipe its cancellation met). Not killed, a signal
      // that stopped its work (its parent's) ends a program that returned a
      // plain status; its own signal stands.
      if (child.state === 'killed' && child.exitCode !== null) return { status: child.exitCode, signal: signalOfStatus(child.exitCode) };
      const stoppedBy = ran.signal === null ? signalAbortReasonOf(stopped.signal) : null;
      if (stoppedBy === null) return ran;
      exitCode = stoppedBy.exitCode;
      return { status: stoppedBy.exitCode, signal: stoppedBy.signal };
    } finally {
      endWork();
      endAwait();
      // Its program has returned, its cleanup done: what it bound is released at its end.
      stopped();
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
  sql: SqlDatabase;
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
  // This workspace is the session its runtimes' warm facets belong to (warm-facets.ts).
  const session = crypto.randomUUID();

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
  // No `startResident`: a workspace owns no actor that could outlive the
  // call, so a program that keeps serving is refused by name rather than run
  // as a one-shot that dies with it. Same for ruby, where a script is the
  // shape that may bind a port.
  const cpython = (restartsWaits: boolean) => lazy(async () => (await import('../runtime/cpython-runner.js'))
    .makeCPythonRunnerFactory({ facets: deps.facets, filesystem: deps.filesystem, processes, network: deps.network, restartsWaits, session }));
  const bash = lazy(async () => (await import('../runtime/bash-runner.js'))
    .makeBashRunnerFactory({ facets: deps.facets, filesystem: deps.filesystem, processes }));
  const runners: Record<string, RunnerFactory> = {
    ...Object.fromEntries(Object.keys(BASH_RUNNER_CONTRACTS).map((key) => [key, bash])),
    ...Object.fromEntries(Object.entries(CPYTHON_RUNNER_CONTRACTS).map(([key, { restartsWaits }]) => [key, cpython(restartsWaits)])),
    'ruby-runner': lazy(async () => (await import('../runtime/ruby-runner.js'))
      .makeRubyRunnerFactory({ facets: deps.facets, filesystem: deps.filesystem, processes, registry: deps.registry, getHome: deps.getHome, network: deps.network, session })),
    'clang-runner': lazy(async () => (await import('../runtime/clang-runner.js'))
      .makeClangRunnerFactory({ facets: deps.facets, filesystem: deps.filesystem, processes, session })),
    ...Object.fromEntries(Object.entries(GIT_RUNNER_CONTRACTS).map(([key, contract]) => [key, lazy(async () => {
      const [{ makeGitRunnerFactory }, { sqliteGitFsmonitorState }] = await Promise.all([
        import('../runtime/git-runner.js'), import('../runtime/git-fsmonitor.js'),
      ]);
      return makeGitRunnerFactory({
        facets: deps.facets, filesystem: deps.filesystem, processes,
        fsmonitorState: sqliteGitFsmonitorState(deps.sql, deps.filesystem.namespace),
        session,
        ...contract,
      });
    })])),
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
  // The store's own, as it keeps them.
  ...STORE_TABLES,
  SHELLS_TABLE,
] as const;

/**
 * A step of the base seed (baseSeed): a read whose answer it needs, or a
 * write. Paths are keys (no leading slash); `as` is whose call it is.
 */
type SeedStep =
  | { op: 'exists'; as: 'kernel' | 'user'; path: string }
  | { op: 'stat'; as: 'kernel'; path: string }
  | { op: 'lstat'; as: 'kernel'; path: string }
  | { op: 'readText'; as: 'kernel'; path: string }
  | {
    op: 'mkdir'; as: 'kernel' | 'user'; path: string; recursive?: boolean; mode?: number;
    /**
     * Who the made directory is handed to, in the same step: a lone mkdir,
     * then a chown of the name it made, not followed. On the session's
     * engine one synchronous turn, so nothing comes between them.
     */
    handTo?: { uid: number; gid: number };
    /**
     * Made below a directory its user may change: handed over only where
     * the step is one turn (the engine). On a mount, where another writer
     * could replace the name between the two calls, it is refused.
     */
    atomicOnly?: boolean;
  }
  | { op: 'chown'; as: 'kernel'; path: string; uid: number; gid: number }
  | { op: 'chmod'; as: 'kernel'; path: string; mode: number }
  | { op: 'writeFile'; as: 'kernel' | 'user'; path: string; content: string; mode?: number };

/** What a `stat` step answers. */
interface SeedStat { uid: number; gid: number; mode: number }

/** What an `lstat` step answers: the entry itself, not followed; null when there is none. */
type SeedEntry = (SeedStat & { type: string }) | null;

/** Whether the session's user may make a name in the directory `entry` is (its write bit for the user). */
function userMayWrite(entry: SeedEntry): boolean {
  if (entry === null) return false;
  const { uid, gid, groups } = CRED_SESSION_USER;
  if (entry.uid === uid) return (entry.mode & 0o200) !== 0;
  if (entry.gid === gid || groups.includes(entry.gid)) return (entry.mode & 0o020) !== 0;
  return (entry.mode & 0o002) !== 0;
}

/**
 * Root's own directories below `/usr`, as on Linux: made by root and kept
 * root's, parent before child (a directory is re-asserted only once its
 * parent is root's, so no user can replace it in between), the runtime
 * store among them. `/usr/local` is the session user's, below them: npm's
 * global prefix, needing no sudo.
 */
const USR_ROOT_DIRS = ['usr', 'usr/bin', 'usr/lib', 'usr/share', 'usr/lib/node_modules', RUNTIME_STORE, 'usr/share/pkg', 'usr/share/pkg/node_modules'];

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
  const lstat = function* (path: string): Generator<SeedStep, SeedEntry, unknown> {
    return (yield { op: 'lstat', as: 'kernel', path }) as SeedEntry;
  };

  // Top-level directories are the kernel's to make (`/` is 0755 root), and
  // handed to the session user, who owns their own tree: seeding them owned
  // by the kernel is what makes a workspace where `.fs` cannot write.
  // `/etc` and `/usr` are root's, below.
  for (const top of SEEDED_TOP_LEVEL_DIRS) {
    if (top === 'etc' || top === 'usr' || (yield* exists('kernel', top))) continue;
    yield { op: 'mkdir', as: 'kernel', path: top, mode: 0o777 & ~CRED_SESSION_USER.umask };
    yield { op: 'chown', as: 'kernel', path: top, uid: CRED_SESSION_USER.uid, gid: CRED_SESSION_USER.gid };
  }
  // /usr as on Linux: root's, re-asserted rather than only created, as /etc
  // is. A session an earlier release made had them the user's; each that is
  // a real directory becomes root's 0755, without what is in it (a package a
  // user put in a global folder stays theirs). A link or a file at one is
  // left, and nothing below it is looked at: every name below would be
  // reached through it (the runtime store refuses to be, runtime-store.ts).
  const rootsDirs = new Set(['']);
  for (const dir of USR_ROOT_DIRS) {
    if (!rootsDirs.has(dir.slice(0, Math.max(0, dir.lastIndexOf('/'))))) continue;
    const entry = yield* lstat(dir);
    if (entry === null) {
      yield { op: 'mkdir', as: 'kernel', path: dir, mode: 0o755 };
      rootsDirs.add(dir);
      continue;
    }
    if (entry.type !== 'directory') continue;
    if (entry.uid !== 0 || entry.gid !== 0) yield { op: 'chown', as: 'kernel', path: dir, uid: 0, gid: 0 };
    if ((entry.mode & 0o7777) !== 0o755) yield { op: 'chmod', as: 'kernel', path: dir, mode: 0o755 };
    rootsDirs.add(dir);
  }
  // /usr/local is made by root and handed to the user, as the home is.
  if (rootsDirs.has('usr') && !(yield* exists('kernel', 'usr/local'))) {
    yield { op: 'mkdir', as: 'kernel', path: 'usr/local', mode: 0o755 };
    yield { op: 'chown', as: 'kernel', path: 'usr/local', uid: CRED_SESSION_USER.uid, gid: CRED_SESSION_USER.gid };
  }
  // The home is made the way useradd -m makes it: by root, wherever it is,
  // then handed to the user. Its parents stay root's. A home already there
  // is left as it is. One to make is made through no link: each name from /
  // to it is looked at without following it, and a link or a file on the way
  // refuses the home, so root never makes, or hands the user, a directory a
  // link the user made leads to (the runtime store, the kernel's /.nimbus,
  // /etc). And it is handed over where no one else can redirect it: root
  // makes the home's directories only below directories only root may
  // change, where no name can be replaced between its mkdir and its chown;
  // below one the user may write, the user makes the rest itself, and owns
  // it from the start. Below one the user may change but has made
  // unwritable to itself, root makes it and hands it over in one step,
  // which only the session's own filesystem makes indivisible: on a mount,
  // such a home is refused.
  const homeDir = home.replace(/^\/+/, '').replace(/\/+$/, '');
  if (homeDir !== '' && !(yield* exists('kernel', homeDir))) {
    const names = homeDir.split('/');
    const user = { uid: CRED_SESSION_USER.uid, gid: CRED_SESSION_USER.gid };
    let rootsOnly = true;
    let parent: SeedEntry = { type: 'directory', uid: 0, gid: 0, mode: 0o755 };
    for (let i = 1; i <= names.length; i++) {
      const path = names.slice(0, i).join('/');
      const leaf = i === names.length;
      const entry = yield* lstat(path);
      if (entry === null) {
        if (rootsOnly) {
          // Its parents stay root's; the home itself is the user's.
          yield { op: 'mkdir', as: 'kernel', path, mode: 0o755, ...(leaf ? { handTo: user } : {}) };
          parent = { type: 'directory', ...(leaf ? user : { uid: 0, gid: 0 }), mode: 0o755 };
        } else if (userMayWrite(parent)) {
          yield { op: 'mkdir', as: 'user', path, mode: 0o755 };
          parent = { type: 'directory', ...user, mode: 0o755 };
        } else {
          yield { op: 'mkdir', as: 'kernel', path, mode: 0o755, handTo: user, atomicOnly: true };
          parent = { type: 'directory', ...user, mode: 0o755 };
        }
        continue;
      }
      if (entry.type !== 'directory') {
        throw new Error(`HOME ${home} passes through ${entry.type === 'symlink' ? 'a link' : `a ${entry.type}`} at /${path}: a home is made through directories only`);
      }
      rootsOnly &&= entry.uid === 0 && (entry.mode & 0o022) === 0;
      parent = entry;
    }
  }
  // HOME=/ is root's directory, not one Nimbus populates for the user.
  const homeChildren = homeDir === '' ? [] : [`${homeDir}/.config`, `${homeDir}/projects`];
  for (const dir of [
    ...homeChildren,
    'tmp', 'var/log',
    'usr/local/lib', 'usr/local/lib/node_modules', 'usr/local/bin',
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
  // The system's own, as on Linux: root's 0644, whatever an earlier release
  // handed the user (their content stays).
  yield* accountFile('etc/hostname', `${DEFAULT_HOSTNAME}\n`);
  yield* accountFile('etc/os-release', `NAME="Nimbus"\nVERSION="${NIMBUS_VERSION}"\nID=nimbus\n` + 'PRETTY_NAME="Nimbus — Cloud Dev Environment"\n');

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
  // Root's 0644, as on Linux: a user's own settings go in ~/.profile. One
  // an earlier release handed the user keeps what they wrote in it.
  yield* accountFile('etc/profile', defaultProfile);
  if (seededProfiles.includes((yield { op: 'readText', as: 'kernel', path: 'etc/profile' }) as string)) {
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
 * The base seed on a namespace: each step placed by the namespace's
 * dispatcher (WaveIngest.placesHere, as a wave's records are). One placed on
 * the session's filesystem is the engine's, as the session's own seed makes
 * it; any other is the call a program would make on the namespace.
 */
async function seedOnNamespace(steps: Generator<SeedStep, void, unknown>, filesystem: ProcessFiles): Promise<void> {
  const mounted = { kernel: filesystem.vfs.as(CRED_KERNEL), user: filesystem.vfs.as(CRED_SESSION_USER) };
  const engine = { kernel: filesystem.engine.as(CRED_KERNEL), user: filesystem.engine.as(CRED_SESSION_USER) };
  const text = new TextEncoder();
  for (let step = steps.next(); !step.done; ) {
    const call = step.value;
    let answer: unknown;
    const cred = call.as === 'kernel' ? CRED_KERNEL : CRED_SESSION_USER;
    // A directory above a mount point is the root's, as a wave's directory
    // record there is. A step is placed as its call looks its name up: every
    // one follows a link at it but an lstat and a lone mkdir (mkdir -p stats
    // it first).
    const follow = call.op === 'lstat' ? false : call.op !== 'mkdir' || call.recursive === true;
    if (filesystem.waves.placesHere(engine[call.as], [call.path], { aboveMounts: true, follow })) {
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
        case 'lstat': {
          const found = await view.stat(path, { follow: false });
          answer = found === null ? null : { type: found.type, uid: found.uid ?? 0, gid: found.gid ?? 0, mode: found.mode ?? 0 };
          break;
        }
        case 'readText': answer = new TextDecoder().decode(await view.readFile(path)); break;
        case 'mkdir':
          if (call.atomicOnly) {
            throw new Error(`seed: ${path} is below a directory its user may change, on a mount, where it cannot be made and handed over in one step`);
          }
          await view.mkdir(path, { ...(call.recursive ? { recursive: true } : {}), ...(call.mode === undefined ? {} : { mode: call.mode }) });
          // Below directories only root may change: no one can replace the name in between.
          if (call.handTo) await unlessUnsupported(view.chown(path, call.handTo.uid, call.handTo.gid));
          break;
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
    case 'lstat': {
      const found = view.statIfPresent(call.path, false);
      return found === null ? null : { type: found.type, uid: found.uid, gid: found.gid, mode: found.mode };
    }
    case 'readText': return view.readFileString(call.path);
    case 'mkdir':
      view.mkdir(call.path, { ...(call.recursive ? { recursive: true } : {}), ...(call.mode === undefined ? {} : { mode: call.mode }) });
      // In the same synchronous turn, and not through a link: the name it just made.
      if (call.handTo) view.chown(call.path, call.handTo.uid, call.handTo.gid, { followSymlinks: false });
      return undefined;
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
