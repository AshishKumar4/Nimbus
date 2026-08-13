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
import type { CommandResult, RunOptions, SandboxFs } from '../substrate/lifo/sandbox/types.js';
import type { ITerminal } from '../substrate/lifo/terminal/ITerminal.js';
import { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { SqlDatabase, TransactionHost } from '../runtime/os-contracts.js';
import type { FacetHost } from '../runtime/facet-host.js';
import { type RuntimePackage } from '../runtime/runtime-package.js';
export interface NimbusWorkspaceOptions {
    /** The host's SQLite. In a Durable Object: `ctx.storage.sql`. */
    readonly sql: SqlDatabase;
    /**
     * Carries `transactionSync`. In a Durable Object: `ctx`.
     *
     * Every atomic write in the filesystem rests on this being a real
     * transaction. An implementation that merely calls the callback converts
     * each one into a torn write that reports success.
     */
    readonly transactions?: TransactionHost;
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
    /** Top-level directories backed by `sql`. Defaults to DEFAULT_MOUNT_POINTS. */
    readonly mounts?: readonly string[];
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
    /**
     * Credentialed and mount-aware. Acts as the session user, never as the
     * kernel: a pid-less caller must not gain more authority than the shell it
     * writes files for (see CRED_SESSION_USER in os-contracts.ts).
     */
    readonly fs: SandboxFs;
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
    private readonly commands;
    private constructor();
    static create(options: NimbusWorkspaceOptions): Promise<NimbusWorkspace>;
    exec(command: string, options?: RunOptions): Promise<CommandResult>;
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
 */
export declare function seedBaseFilesystem(vfs: SqliteVFS, mounts: readonly string[]): void;
//# sourceMappingURL=nimbus-workspace.d.ts.map