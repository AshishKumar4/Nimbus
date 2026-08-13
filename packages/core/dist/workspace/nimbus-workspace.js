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
import { SqliteVFS, SqliteVFSProvider } from '../vfs/sqlite-vfs.js';
import { DEFAULT_MOUNT_POINTS, DEFAULT_PATH } from '../constants.js';
import { CRED_KERNEL, CRED_SESSION_USER } from '../runtime/os-contracts.js';
import { PID_GEN_STRIDE } from '../runtime/process-table.js';
import { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import { rehydrateInstalledRuntimesView, } from '../runtime/installed-runtimes.js';
import { registerUnixCommands } from '../shell/unix-commands.js';
import { installPathExecResolver } from '../shell/exec-dispatch.js';
/**
 * A durable filesystem and a shell over it.
 *
 * Created with {@link NimbusWorkspace.create} rather than `new` because the
 * boot it delegates to sources `/etc/profile`, which is genuinely async. A
 * Durable Object constructor cannot await, so a host constructs the workspace
 * in its first request rather than in its constructor.
 */
export class NimbusWorkspace {
    sandbox;
    sql;
    /**
     * Credentialed and mount-aware. Acts as the session user, never as the
     * kernel: a pid-less caller must not gain more authority than the shell it
     * writes files for (see CRED_SESSION_USER in os-contracts.ts).
     */
    fs;
    /** The raw durable filesystem, for hosts that need uid-aware operations. */
    vfs;
    kernel;
    shell;
    constructor(sandbox, vfs, sql) {
        this.sandbox = sandbox;
        this.sql = sql;
        this.vfs = vfs;
        this.kernel = sandbox.kernel;
        this.shell = sandbox.shell;
        // NOT `sandbox.fs`, which wraps the raw kernel VFS. The mount is
        // kernel-credentialed because the shell re-credentials per command; a host
        // calling `.fs` has no process behind it and must not inherit that.
        this.fs = new SandboxFsImpl(sandbox.kernel.vfs.as(CRED_SESSION_USER), () => sandbox.shell.getCwd());
    }
    static async create(options) {
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
        if (options.facets) {
            await registerWasmRuntimes({
                facets: options.facets,
                vfs,
                registry: sandbox.commands.registry,
                generation: options.generation ?? 1,
                home: options.env?.HOME ?? '/home/user',
            });
        }
        return new NimbusWorkspace(sandbox, vfs, options.sql);
    }
    exec(command, options) {
        return this.sandbox.commands.run(command, options);
    }
    /**
     * Files, directories and bytes this workspace occupies.
     *
     * A host sharing its Durable Object needs this because the filesystem's own
     * `df` reports the workspace's usage against the whole 10 GB limit, and the
     * host's rows draw on that same limit without appearing here.
     */
    stats() {
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
    destroy() {
        for (const table of WORKSPACE_TABLES) {
            this.sql.exec(`DROP TABLE IF EXISTS ${table}`);
        }
    }
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
async function registerWasmRuntimes(deps) {
    const [{ makeBashRunnerFactory }, { makeCPythonRunnerFactory }, { wasmRunnerSpec }, { buildRuntimeHandler }, esbuildModule,] = await Promise.all([
        import('../runtime/bash-runner.js'),
        import('../runtime/cpython-runner.js'),
        import('../runtime/wasm-runner.js'),
        import('../runtime/runtime-registry.js'),
        import('../runtime/esbuild-service.js'),
    ]);
    // wasm-runner allocates pids for what it runs, so it needs a process table
    // whose pid space is this generation's — the same rule the append writers
    // above are revoked by.
    const processes = new SessionProcessSupervisor();
    processes.setPidBase(deps.generation * PID_GEN_STRIDE);
    let esbuild = null;
    deps.registry.register('wasm-runner', buildRuntimeHandler(wasmRunnerSpec({ vfs: deps.vfs, facets: deps.facets, processes }), {
        vfs: deps.vfs,
        getEsbuild: () => {
            if (!esbuild)
                esbuild = new esbuildModule.EsbuildService(deps.vfs);
            return esbuild;
        },
        registry: deps.registry,
    }));
    const runners = {
        'bash-runner': makeBashRunnerFactory({ facets: deps.facets, vfs: deps.vfs }),
        // No `startResident`: a workspace owns no actor that could outlive the
        // call, so a program that keeps serving is refused by name rather than
        // run as a one-shot that dies with it.
        'cpython-runner': makeCPythonRunnerFactory({ facets: deps.facets, vfs: deps.vfs }),
    };
    rehydrateInstalledRuntimesView(deps.vfs.as(CRED_KERNEL), deps.registry, deps.home, (key) => runners[key]);
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
];
/**
 * The directories and account files the shell cannot start without.
 *
 * Idempotent by construction: every write is guarded by an existence check, so
 * a workspace reopened over a populated database keeps whatever the user did
 * to these files. `/etc/passwd` and `/etc/group` are load-bearing rather than
 * decorative — `id`, `chown` and `su` resolve names through them.
 */
function seedBaseFilesystem(vfs, mounts) {
    const fs = vfs.as(CRED_SESSION_USER);
    const rootFs = vfs.as(CRED_KERNEL);
    // Created AS the session user, so the user owns their own tree. Seeding
    // these as the kernel is what makes a workspace where `.fs` cannot write.
    for (const mount of mounts) {
        if (mount !== 'etc' && !fs.exists(mount))
            fs.mkdir(mount, { recursive: true });
    }
    for (const dir of ['home/user', 'usr/bin', 'usr/local/bin', 'var/log', 'tmp']) {
        if (!fs.exists(dir))
            fs.mkdir(dir, { recursive: true });
    }
    if (!rootFs.exists('etc'))
        rootFs.mkdir('etc', { mode: 0o755 });
    // Root-owned 0644, and re-asserted rather than only created: these decide
    // what `id`, `chown` and `su` believe, so a user-writable /etc/passwd would
    // be an authority bug rather than an untidy file.
    const accountFile = (path, content) => {
        if (!rootFs.exists(path))
            rootFs.writeFile(path, content, { mode: 0o644 });
        const stat = rootFs.stat(path);
        if (stat.uid !== 0 || stat.gid !== 0)
            rootFs.chown(path, 0, 0);
        if ((stat.mode & 0o7777) !== 0o644)
            rootFs.chmod(path, 0o644);
    };
    accountFile('etc/passwd', 'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:Nimbus User:/home/user:/bin/sh\n');
    accountFile('etc/group', 'root:x:0:\nuser:x:1000:user\n');
    if (!rootFs.exists('etc/profile')) {
        rootFs.writeFile('etc/profile', `export PATH=${DEFAULT_PATH}\nexport EDITOR=nano\n`);
        rootFs.chown('etc/profile', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
    }
}
