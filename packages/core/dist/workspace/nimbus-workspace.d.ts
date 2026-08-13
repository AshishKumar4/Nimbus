/**
 * nimbus-workspace.ts — Nimbus as a component someone else can hold.
 *
 * A workspace is a durable filesystem plus a shell over it. It owns no
 * transport, no session, no socket and no Durable Object: the host supplies
 * SQLite and gets back `.fs` and `.exec`. That is what makes it embeddable in
 * a Durable Object that is already busy powering something else, and what
 * makes it runnable in a plain bun process over `bun:sqlite`.
 *
 * The composition here is not new. It is the one `session/init.ts` performs,
 * lifted out of the session so there is one recipe rather than one per caller
 * — five unit tests were already hand-rolling it, one of them reaching a
 * private field to do so. The boot itself still belongs to `Sandbox.create`;
 * this adds only what a durable, credentialed filesystem needs on top and
 * nothing the sandbox already knows how to do.
 */
import type { CommandResult, RunOptions, SandboxFs } from '../substrate/lifo/sandbox/types.js';
import type { Kernel } from '../substrate/lifo/kernel/index.js';
import type { Shell } from '../substrate/lifo/shell/Shell.js';
import type { ITerminal } from '../substrate/lifo/terminal/ITerminal.js';
import { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { SqlDatabase, TransactionHost } from '../runtime/os-contracts.js';
import type { FacetHost } from '../runtime/facet-host.js';
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
     * Process-id generation. The workspace revokes every append capability at
     * or below `generation * 1_000_000` before serving anything, so a value
     * that repeats across restarts hands a dead process live write authority.
     * Hosts that persist must supply a counter that never repeats.
     */
    readonly generation?: number;
    /** Top-level directories backed by `sql`. Defaults to DEFAULT_MOUNT_POINTS. */
    readonly mounts?: readonly string[];
    readonly env?: Record<string, string>;
    readonly cwd?: string;
    /** Absent means headless: `.exec` captures output and nothing is drawn. */
    readonly terminal?: ITerminal;
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
     * A Durable Object passes the workerd host (`@nimbus-sh/worker`'s
     * `loaderFacetHost`); a plain process passes `localFacetHost()`.
     */
    readonly facets?: FacetHost;
}
/**
 * A durable filesystem and a shell over it.
 *
 * Created with {@link NimbusWorkspace.create} rather than `new` because the
 * boot it delegates to sources `/etc/profile`, which is genuinely async. A
 * Durable Object constructor cannot await, so a host constructs the workspace
 * in its first request rather than in its constructor.
 */
export declare class NimbusWorkspace {
    private readonly sandbox;
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
    private constructor();
    static create(options: NimbusWorkspaceOptions): Promise<NimbusWorkspace>;
    exec(command: string, options?: RunOptions): Promise<CommandResult>;
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
//# sourceMappingURL=nimbus-workspace.d.ts.map