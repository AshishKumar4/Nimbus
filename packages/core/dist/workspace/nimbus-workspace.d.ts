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
import { Kernel } from '../substrate/lifo/kernel/index.js';
import { Shell } from '../substrate/lifo/shell/Shell.js';
import type { ShellCommandIdentity } from '../substrate/lifo/shell/Shell.js';
import type { CommandRegistry } from '../substrate/lifo/commands/registry.js';
import { type WorkspaceEgress, type WorkspaceNetwork } from '../_shared/workspace-network.js';
import type { CommandResult, RunOptions } from '../substrate/lifo/sandbox/types.js';
import type { ITerminal } from '../substrate/lifo/terminal/ITerminal.js';
import { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { SqlDatabase, TransactionHost } from '../runtime/os-contracts.js';
import { ProcessFiles } from '../runtime/process-files.js';
import { WorkspaceFs } from './workspace-fs.js';
import { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import type { FacetHost } from '../runtime/facet-host.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import { type RuntimePackage, type RuntimeSource } from '../runtime/runtime-package.js';
import { type CtxExports, type FabricComposition } from '@nimbus-sh/platform/composition.js';
import { type SupervisorOpEnvelope, type SupervisorOpHandler } from './supervisor-op.js';
import { type NamedShell, type NamedShellOptions } from './named-shells.js';
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
    readonly transactions?: TransactionHost & {
        readonly exports?: CtxExports;
    };
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
     * workspaceNetwork(egress))`), TLS CPython makes itself included; an inline
     * `node` program's fetch and http/https, streamed and redirected as Node's
     * fetch does; a worker or dev server a command starts.
     *
     * Refused: a process's TLS socket (`tls.connect`), because a Fetcher's
     * `connect()` carries plain TCP only and the TLS session could only be
     * made off the egress (HTTPS by fetch or `https` is not affected); an
     * inline `node` program's WebSocket, which cannot cross its realm.
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
export declare class NimbusWorkspace {
    private readonly sql;
    private readonly supervisorOps;
    readonly filesystem: ProcessFiles;
    private readonly runtimeLease;
    /** Who the workspace shell acts as, and so every call's process. */
    private readonly identity;
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
    get network(): WorkspaceNetwork;
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
    private readonly namedShells;
    private constructor();
    static create(options: NimbusWorkspaceOptions): Promise<NimbusWorkspace>;
    close(): Promise<void>;
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
    exec(command: string, options?: WorkspaceExecOptions): Promise<CommandResult>;
    private runProcess;
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
    shellFor(pid: number, state: {
        readonly cwd: string;
        readonly env?: Readonly<Record<string, string>>;
    }): Shell;
    /**
     * Run `body` in the named shell `id` (see named-shells.ts): in the cwd and
     * environment the last call on that name left it with, else
     * `options.start`, one call on the name at a time.
     *
     * {@link exec} with a `shellId` is this around one command. A host that
     * runs its own process around the shell (a session's exec and background
     * jobs) calls it directly, and builds the shell with `open(pid)`.
     */
    withNamedShell<T>(id: string, options: NamedShellOptions, body: (shell: NamedShell) => Promise<T>): Promise<T>;
    /** The hosting object forwards its supervisorOp RPC to this method. */
    supervisorOp(envelope: SupervisorOpEnvelope): Promise<unknown>;
    /**
     * Apply the login files, and begin reading the terminal when there is one.
     *
     * Separate from {@link create} because a host with commands of its own must
     * register them first: `/etc/profile` and `~/.nimbusrc` are the user's
     * files, and either may name a command the host has yet to supply.
     */
    start(): Promise<void>;
    /**
     * Files, directories and bytes this workspace occupies.
     *
     * A host sharing its Durable Object needs this because the filesystem's own
     * `df` reports the workspace's usage against the whole 10 GB limit, and the
     * host's rows draw on that same limit without appearing here.
     */
    stats(): {
        files: number;
        dirs: number;
        usedBytes: number;
    };
    /**
     * Drop this workspace's tables. The host's own rows are untouched.
     *
     * Deliberately not `ctx.storage.deleteAll()`, which is what the session's
     * own destroy uses: a session owns its Durable Object, and a workspace does
     * not. Calling deleteAll here would erase the data of whatever else the host
     * keeps in that object.
     */
    destroy(): void;
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
export declare function seedBaseFilesystem(vfs: SqliteVFS, home?: string): void;
//# sourceMappingURL=nimbus-workspace.d.ts.map