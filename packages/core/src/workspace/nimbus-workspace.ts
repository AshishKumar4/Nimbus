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
import { createDefaultRegistry } from '../substrate/lifo/commands/registry.js';
import type { CommandRegistry } from '../substrate/lifo/commands/registry.js';
import { SandboxCommandsImpl } from '../substrate/lifo/sandbox/SandboxCommands.js';
import { SandboxFsImpl } from '../substrate/lifo/sandbox/SandboxFs.js';
import { HeadlessTerminal } from '../substrate/lifo/sandbox/HeadlessTerminal.js';
import type { CommandResult, RunOptions, SandboxFs } from '../substrate/lifo/sandbox/types.js';
import type { ITerminal } from '../substrate/lifo/terminal/ITerminal.js';
import { SqliteVFS, SqliteVFSProvider } from '../vfs/sqlite-vfs.js';
import {
  DEFAULT_HOME, DEFAULT_HOSTNAME, DEFAULT_MOUNT_POINTS, DEFAULT_PATH,
  DEFAULT_SHELL, DEFAULT_USER, NIMBUS_VERSION,
} from '../constants.js';
import { CRED_KERNEL, CRED_SESSION_USER } from '../runtime/os-contracts.js';
import type { SqlDatabase, TransactionHost } from '../runtime/os-contracts.js';
import { PID_GEN_STRIDE } from '../runtime/process-table.js';
import { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import type { FacetHost } from '../runtime/facet-host.js';
import {
  rehydrateInstalledRuntimesView,
  type RunnerFactory,
} from '../runtime/installed-runtimes.js';
import { seedRuntimePackage, type RuntimePackage } from '../runtime/runtime-package.js';
import type { EsbuildService } from '../runtime/esbuild-service.js';
import { registerUnixCommands } from '../shell/unix-commands.js';
import { installPathExecResolver } from '../shell/exec-dispatch.js';

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
  /** What the shell resolves a command name against. A host adds its own. */
  readonly registry: CommandRegistry;
  /**
   * The environment the shell was composed with. The shell's own copy drifts
   * from this one the moment the user exports anything; this is what a host
   * hands to a subordinate shell it starts itself.
   */
  readonly env: Record<string, string>;

  private readonly commands: SandboxCommandsImpl;

  private constructor(
    vfs: SqliteVFS,
    kernel: Kernel,
    shell: Shell,
    registry: CommandRegistry,
    env: Record<string, string>,
    private readonly sql: SqlDatabase,
  ) {
    this.vfs = vfs;
    this.kernel = kernel;
    this.shell = shell;
    this.registry = registry;
    this.env = env;
    this.commands = new SandboxCommandsImpl(shell, registry);
    // NOT the kernel VFS as it stands, which is kernel-credentialed because
    // the shell re-credentials per command; a host calling `.fs` has no
    // process behind it and must not inherit that.
    this.fs = new SandboxFsImpl(kernel.vfs.as(CRED_SESSION_USER), () => shell.getCwd());
  }

  static async create(options: NimbusWorkspaceOptions): Promise<NimbusWorkspace> {
    const vfs = options.vfs ?? openFilesystem(options);
    const mounts = options.mounts ?? DEFAULT_MOUNT_POINTS;
    seedBaseFilesystem(vfs, mounts);

    const kernel = new Kernel();
    // Seeds the in-memory tree. Mounting AFTER it is what keeps a durable
    // /etc from being overwritten by the defaults on every boot.
    kernel.initFilesystem();
    for (const mount of mounts) {
      kernel.vfs.mount(`/${mount}`, new SqliteVFSProvider(vfs, mount));
    }

    const registry = createDefaultRegistry();
    // The durable coreutils replace ~25 lifo builtins. They are the ones that
    // carry credentials and read this filesystem's uid/gid, so they must win.
    registerUnixCommands(registry, vfs);

    const env = { ...defaultEnv(), ...options.env };
    const shell = new Shell(
      options.terminal ?? new HeadlessTerminal(),
      kernel.vfs,
      registry,
      env,
      kernel.processRegistry,
      options.identity,
    );
    if (options.cwd) shell.setCwd(options.cwd);

    // Kernel-credentialed on purpose: this only INSPECTS a file to decide how
    // to run it, and re-checks the caller's own execute permission at
    // invocation time — the `authorize` wrapper in exec-dispatch.ts.
    installPathExecResolver(registry, vfs.as(CRED_KERNEL), () => shell.getCwd());

    const home = env.HOME ?? DEFAULT_HOME;

    // Before the runners are wired, because registration reads what the
    // filesystem holds — the same order `nimbus install` observes, and the
    // same order a Durable Object observes when it rehydrates after eviction.
    for (const runtimePackage of options.runtimes ?? []) {
      await seedRuntimePackage(vfs.as(CRED_KERNEL), home, runtimePackage);
    }

    if (options.facets) {
      await registerWasmRuntimes({
        facets: options.facets,
        vfs,
        registry,
        generation: options.generation ?? 1,
        home,
      });
    }

    return new NimbusWorkspace(vfs, kernel, shell, registry, env, options.sql);
  }

  exec(command: string, options?: RunOptions): Promise<CommandResult> {
    return this.commands.run(command, options);
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
    this.shell.start();
    // Nimbus's own rc file, which the shell's list predates.
    await this.shell.sourceFile(`${this.shell.getEnv().HOME ?? DEFAULT_HOME}/.nimbusrc`);
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
  const vfs = new SqliteVFS(options.sql, options.transactions);
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
 * template, `${PORT:-3000}` in a package.json script.
 */
function defaultEnv(): Record<string, string> {
  return {
    HOME: DEFAULT_HOME,
    USER: DEFAULT_USER,
    SHELL: DEFAULT_SHELL,
    HOSTNAME: DEFAULT_HOSTNAME,
    TERM: 'xterm-256color',
    PWD: DEFAULT_HOME,
    PATH: DEFAULT_PATH,
    PS1: `\x1b[1;32muser@${DEFAULT_HOSTNAME}\x1b[0m:\x1b[1;34m\\w\x1b[0m$ `,
    NODE_ENV: 'development',
    LANG: 'en_US.UTF-8',
    EDITOR: 'nano',
    NIMBUS_VERSION: NIMBUS_VERSION,
    TMPDIR: '/tmp',
    XDG_CONFIG_HOME: `${DEFAULT_HOME}/.config`,
    XDG_DATA_HOME: `${DEFAULT_HOME}/.local/share`,
    npm_config_prefix: '/usr/local',
    PORT: '3000',
    HOST: '0.0.0.0',
  };
}

/**
 * Turn a facet host into commands: the runtimes this filesystem already holds,
 * plus `wasm-runner` for everything else with a `\0asm` header.
 *
 * The runner factories are held here rather than in the process-global table
 * `nimbus install` writes to, because each one closes over THIS workspace's
 * filesystem and THIS workspace's facet host — a second workspace in the same
 * process would otherwise silently retarget the first one's bash.
 *
 * Imported on demand: the runners carry the WASI shim and the bash scheduler as
 * source strings, and a workspace with no facet host must not pay to parse
 * them.
 */
async function registerWasmRuntimes(deps: {
  facets: FacetHost;
  vfs: SqliteVFS;
  registry: CommandRegistry;
  generation: number;
  home: string;
}): Promise<void> {
  const [
    { makeBashRunnerFactory },
    { makeCPythonRunnerFactory },
    { makeRubyRunnerFactory },
    { makeClangRunnerFactory },
    { wasmRunnerSpec },
    { buildRuntimeHandler },
  ] = await Promise.all([
    import('../runtime/bash-runner.js'),
    import('../runtime/cpython-runner.js'),
    import('../runtime/ruby-runner.js'),
    import('../runtime/clang-runner.js'),
    import('../runtime/wasm-runner.js'),
    import('../runtime/runtime-registry.js'),
  ]);

  // wasm-runner allocates pids for what it runs, so it needs a process table
  // whose pid space is this generation's.
  const processes = new SessionProcessSupervisor();
  processes.setPidBase(deps.generation * PID_GEN_STRIDE);

  // Loaded on the first TypeScript or ESM script and not before. The module
  // statically imports `esbuild-wasm/esbuild.wasm`, which only wrangler
  // resolves — node instantiates it as a wasm module and fails on its Go
  // imports — so a host outside Cloudflare must be able to run a shell, bash
  // and python without that module ever entering its graph.
  let esbuild: Promise<EsbuildService> | null = null;
  deps.registry.register('wasm-runner', buildRuntimeHandler(
    wasmRunnerSpec({ vfs: deps.vfs, facets: deps.facets, processes }),
    {
      vfs: deps.vfs,
      getEsbuild: () => {
        if (!esbuild) {
          esbuild = import('../runtime/esbuild-service.js')
            .then((module) => new module.EsbuildService(deps.vfs));
        }
        return esbuild;
      },
      registry: deps.registry,
    },
  ));

  const runners: Record<string, RunnerFactory> = {
    'bash-runner': makeBashRunnerFactory({ facets: deps.facets, vfs: deps.vfs }),
    // No `startResident`: a workspace owns no actor that could outlive the
    // call, so a program that keeps serving is refused by name rather than
    // run as a one-shot that dies with it. Same for ruby, where a script is
    // the shape that may bind a port.
    'cpython-runner': makeCPythonRunnerFactory({ facets: deps.facets, vfs: deps.vfs }),
    'ruby-runner': makeRubyRunnerFactory({
      facets: deps.facets, vfs: deps.vfs, registry: deps.registry,
    }),
    'clang-runner': makeClangRunnerFactory({ facets: deps.facets, vfs: deps.vfs }),
  };
  rehydrateInstalledRuntimesView(
    deps.vfs.as(CRED_KERNEL),
    deps.registry,
    deps.home,
    (key) => runners[key],
  );
}

/**
 * Every table the filesystem creates.
 *
 * Listed rather than discovered because the namespace is the contract an
 * embedder is owed: these names, and nothing else in their database, belong
 * to the workspace. `inodes`, `file_chunks` and `content_lifecycle` are the
 * three that carry no `vfs_` prefix and so are the ones most likely to
 * collide with a host's own schema.
 */
const WORKSPACE_TABLES = [
  'inodes',
  'file_chunks',
  'content_lifecycle',
  'vfs_schema_migrations',
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
 */
export function seedBaseFilesystem(vfs: SqliteVFS, mounts: readonly string[]): void {
  const fs = vfs.as(CRED_SESSION_USER);
  const rootFs = vfs.as(CRED_KERNEL);

  // Created AS the session user, so the user owns their own tree. Seeding
  // these as the kernel is what makes a workspace where `.fs` cannot write.
  for (const mount of mounts) {
    if (mount !== 'etc' && !fs.exists(mount)) fs.mkdir(mount, { recursive: true });
  }
  for (const dir of [
    'home/user', 'home/user/.config', 'home/user/projects',
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
  accountFile('etc/passwd', 'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:Nimbus User:/home/user:/bin/sh\n');
  accountFile('etc/group', 'root:x:0:\nuser:x:1000:user\n');

  const defaultProfile = `export PATH=${DEFAULT_PATH}\nexport EDITOR=nano\n`;
  if (!rootFs.exists('etc/profile')) {
    rootFs.writeFile('etc/profile', defaultProfile);
    rootFs.chown('etc/profile', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  } else if (rootFs.readFileString('etc/profile') === 'export PATH=/usr/bin:/bin\nexport EDITOR=nano\n') {
    // The lifo default, from before Nimbus had a PATH of its own. Nobody ever
    // chose it, so replacing it is not overwriting a user's file.
    rootFs.writeFile('etc/profile', defaultProfile);
  }

  if (!fs.exists('home/user/.nimbusrc')) {
    fs.writeFile('home/user/.nimbusrc',
      '# Nimbus shell config\nalias ll="ls -la"\nalias la="ls -a"\nalias l="ls -1"\n',
    );
  }
}
