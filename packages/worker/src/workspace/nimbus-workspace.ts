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

import { Sandbox } from '../substrate/lifo/sandbox/Sandbox.js';
import { SandboxFsImpl } from '../substrate/lifo/sandbox/SandboxFs.js';
import type { CommandResult, RunOptions, SandboxFs } from '../substrate/lifo/sandbox/types.js';
import type { Kernel } from '../substrate/lifo/kernel/index.js';
import type { Shell } from '../substrate/lifo/shell/Shell.js';
import type { ITerminal } from '../substrate/lifo/terminal/ITerminal.js';
import { SqliteVFS, SqliteVFSProvider } from '../vfs/sqlite-vfs.js';
import { DEFAULT_MOUNT_POINTS, DEFAULT_PATH } from '../constants.js';
import { CRED_KERNEL, CRED_SESSION_USER } from '../runtime/os-contracts.js';
import type { SqlDatabase, TransactionHost } from '../runtime/os-contracts.js';
import { registerUnixCommands } from '../shell/unix-commands.js';
import { installPathExecResolver } from '../shell/exec-dispatch.js';

/** Pids are `generation * PID_GEN_STRIDE + seq`; mirrors process-table.ts. */
const PID_GEN_STRIDE = 1_000_000;

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
}

/**
 * A durable filesystem and a shell over it.
 *
 * Created with {@link NimbusWorkspace.create} rather than `new` because the
 * boot it delegates to sources `/etc/profile`, which is genuinely async. A
 * Durable Object constructor cannot await, so a host constructs the workspace
 * in its first request rather than in its constructor.
 */
export class NimbusWorkspace {
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

  private constructor(private readonly sandbox: Sandbox, vfs: SqliteVFS) {
    this.vfs = vfs;
    this.kernel = sandbox.kernel;
    this.shell = sandbox.shell;
    // NOT `sandbox.fs`, which wraps the raw kernel VFS. The mount is
    // kernel-credentialed because the shell re-credentials per command; a host
    // calling `.fs` has no process behind it and must not inherit that.
    this.fs = new SandboxFsImpl(
      sandbox.kernel.vfs.as(CRED_SESSION_USER),
      () => sandbox.shell.getCwd(),
    );
  }

  static async create(options: NimbusWorkspaceOptions): Promise<NimbusWorkspace> {
    const vfs = new SqliteVFS(options.sql, options.transactions);
    vfs.revokeAppendWritersThrough((options.generation ?? 1) * PID_GEN_STRIDE);

    const mounts = options.mounts ?? DEFAULT_MOUNT_POINTS;
    seedBaseFilesystem(vfs, mounts);

    const sandbox = await Sandbox.create({
      env: options.env,
      cwd: options.cwd,
      terminal: options.terminal,
      providerMounts: mounts.map((mount) => ({
        virtualPath: '/' + mount,
        provider: new SqliteVFSProvider(vfs, mount),
      })),
    });

    // The durable coreutils replace ~25 lifo builtins. They are the ones that
    // carry credentials and read this filesystem's uid/gid, so they must win.
    registerUnixCommands(sandbox.commands.registry, vfs);
    installPathExecResolver(sandbox.commands.registry, vfs.as(CRED_SESSION_USER), () => sandbox.shell.getCwd());

    return new NimbusWorkspace(sandbox, vfs);
  }

  exec(command: string, options?: RunOptions): Promise<CommandResult> {
    return this.sandbox.commands.run(command, options);
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
}

/**
 * The directories and account files the shell cannot start without.
 *
 * Idempotent by construction: every write is guarded by an existence check, so
 * a workspace reopened over a populated database keeps whatever the user did
 * to these files. `/etc/passwd` and `/etc/group` are load-bearing rather than
 * decorative — `id`, `chown` and `su` resolve names through them.
 */
function seedBaseFilesystem(vfs: SqliteVFS, mounts: readonly string[]): void {
  const fs = vfs.as(CRED_SESSION_USER);
  const rootFs = vfs.as(CRED_KERNEL);

  // Created AS the session user, so the user owns their own tree. Seeding
  // these as the kernel is what makes a workspace where `.fs` cannot write.
  for (const mount of mounts) {
    if (mount !== 'etc' && !fs.exists(mount)) fs.mkdir(mount, { recursive: true });
  }
  for (const dir of ['home/user', 'usr/bin', 'usr/local/bin', 'var/log', 'tmp']) {
    if (!fs.exists(dir)) fs.mkdir(dir, { recursive: true });
  }

  if (!rootFs.exists('etc')) rootFs.mkdir('etc', { mode: 0o755 });

  // Root-owned 0644, and re-asserted rather than only created: these decide
  // what `id`, `chown` and `su` believe, so a user-writable /etc/passwd would
  // be an authority bug rather than an untidy file.
  const accountFile = (path: string, content: string): void => {
    if (!rootFs.exists(path)) rootFs.writeFile(path, content, { mode: 0o644 });
    const stat = rootFs.stat(path);
    if (stat.uid !== 0 || stat.gid !== 0) rootFs.chown(path, 0, 0);
    if ((stat.mode & 0o7777) !== 0o644) rootFs.chmod(path, 0o644);
  };
  accountFile('etc/passwd', 'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:Nimbus User:/home/user:/bin/sh\n');
  accountFile('etc/group', 'root:x:0:\nuser:x:1000:user\n');

  if (!rootFs.exists('etc/profile')) {
    rootFs.writeFile('etc/profile', `export PATH=${DEFAULT_PATH}\nexport EDITOR=nano\n`);
    rootFs.chown('etc/profile', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  }
}
