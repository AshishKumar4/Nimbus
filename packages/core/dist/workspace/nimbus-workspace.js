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
import { createDefaultRegistry } from '../substrate/lifo/commands/registry.js';
import { createNodeCommand } from '../substrate/lifo/commands/system/node.js';
import { createCurlCommand } from '../substrate/lifo/commands/net/curl.js';
import { createWgetCommand } from '../substrate/lifo/commands/net/wget.js';
import { SandboxCommandsImpl } from '../substrate/lifo/sandbox/SandboxCommands.js';
import { SandboxFsImpl } from '../substrate/lifo/sandbox/SandboxFs.js';
import { HeadlessTerminal } from '../substrate/lifo/sandbox/HeadlessTerminal.js';
import { SqliteVFS, SqliteVFSProvider } from '../vfs/sqlite-vfs.js';
import { textSink } from '../_shared/bytes.js';
import { DEFAULT_HOME, DEFAULT_HOSTNAME, DEFAULT_MOUNT_POINTS, DEFAULT_PATH, DEFAULT_SHELL, DEFAULT_USER, NIMBUS_VERSION, } from '../constants.js';
import { CRED_KERNEL, CRED_SESSION_USER } from '../runtime/os-contracts.js';
import { SqliteFilesystemAuthority } from '../runtime/filesystem-authority.js';
import { ExecutionFs } from '../shell/execution-fs.js';
import { PID_GEN_STRIDE } from '../runtime/process-table.js';
import { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import { runtimeEntrypoints } from '../runtime/installed-runtimes.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import { makeNimbusVerbHandler } from '../runtime/nimbus-command.js';
import { composeRuntimeSources, suppliedRuntimeSource, } from '../runtime/runtime-package.js';
import { registerUnixCommands } from '../shell/unix-commands.js';
import { installPathExecResolver } from '../shell/exec-dispatch.js';
import { adoptCtxExports, composeFabric } from '@nimbus-sh/platform/composition.js';
import { createSupervisorOpHandler } from './supervisor-op.js';
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
    sql;
    supervisorOps;
    filesystem;
    runtimeLease;
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
    /** What the shell resolves a command name against. A host adds its own. */
    registry;
    /**
     * The environment the shell was composed with. The shell's own copy drifts
     * from this one the moment the user exports anything; this is what a host
     * hands to a subordinate shell it starts itself.
     */
    env;
    /** The process table this workspace's shell and wasm-runner allocate from —
     *  the host's own when it supplied one. */
    processes;
    /** Runtime installs, runners and the `nimbus` verb's backing store. */
    runtimes;
    /** The pid the shell's commands run as — the host's identity pid when it
     *  supplied one, else the `sh` this workspace spawned. */
    shellProcessPid;
    commands;
    constructor(vfs, kernel, shell, registry, env, sql, processes, runtimes, shellProcessPid, supervisorOps, filesystem, runtimeLease) {
        this.sql = sql;
        this.supervisorOps = supervisorOps;
        this.filesystem = filesystem;
        this.runtimeLease = runtimeLease;
        this.vfs = vfs;
        this.kernel = kernel;
        this.shell = shell;
        this.registry = registry;
        this.env = env;
        this.processes = processes;
        this.runtimes = runtimes;
        this.shellProcessPid = shellProcessPid;
        this.commands = new SandboxCommandsImpl(shell, registry);
        // NOT the kernel VFS as it stands, which is kernel-credentialed because
        // the shell re-credentials per command; a host calling `.fs` has no
        // process behind it and must not inherit that.
        this.fs = new SandboxFsImpl(shell.getVfs(), () => shell.getCwd());
    }
    static async create(options) {
        if (options.fabric)
            composeFabric(options.fabric);
        const exports = options.ctxExports ?? options.transactions?.exports;
        if (exports)
            adoptCtxExports(exports);
        const vfs = options.vfs ?? openFilesystem(options);
        if (options.filesystemNamespace !== undefined && options.filesystemNamespace !== vfs.namespace) {
            throw new Error('filesystemNamespace differs from the supplied filesystem namespace');
        }
        const mounts = options.mounts ?? DEFAULT_MOUNT_POINTS;
        seedBaseFilesystem(vfs, mounts);
        const kernel = new Kernel();
        // Seeds the in-memory tree. Mounting AFTER it is what keeps a durable
        // /etc from being overwritten by the defaults on every boot.
        kernel.initFilesystem();
        for (const mount of mounts) {
            kernel.vfs.mount(`/${mount}`, new SqliteVFSProvider(vfs, mount));
        }
        const defaultAuthority = new SqliteFilesystemAuthority(vfs, kernel.vfs);
        const filesystem = options.filesystem?.(defaultAuthority) ?? defaultAuthority;
        if (filesystem instanceof SqliteFilesystemAuthority)
            filesystem.attachKernel(kernel.vfs);
        if (filesystem.namespace !== defaultAuthority.namespace)
            throw new Error('Selected authority must preserve the workspace namespace');
        const registry = createDefaultRegistry();
        // The durable coreutils replace ~25 lifo builtins. They are the ones that
        // carry credentials and read this filesystem's uid/gid, so they must win.
        registerUnixCommands(registry, vfs);
        const processes = options.processes ?? new SessionProcessSupervisor();
        // Only a supervisor this workspace created gets its pid base set here; a
        // host-supplied one keeps the base its owner configured.
        if (!options.processes)
            processes.setPidBase((options.generation ?? 1) * PID_GEN_STRIDE);
        const env = { ...defaultEnv(), ...options.env };
        // The identity every shell command runs as. A host that supplied one keeps
        // it verbatim — its pid is already alive in ITS process table. Otherwise
        // the workspace's own supervisor spawns the shell process, so `sudo`,
        // `chown` and the per-process umask have a live table entry behind them
        // rather than the Shell's pid-less uid-1000 default.
        let shell;
        let identity;
        let shellProcessPid;
        if (options.identity) {
            identity = options.identity;
            shellProcessPid = options.identity.pid;
        }
        else {
            const shellProcess = processes.spawn('sh', ['sh'], options.cwd ?? env.HOME ?? DEFAULT_HOME);
            shellProcessPid = shellProcess.pid;
            identity = workspaceShellIdentity(processes, shellProcess, () => shell);
        }
        shell = new Shell(options.terminal ?? new HeadlessTerminal(), filesystem, registry, env, kernel.processRegistry, identity);
        if (options.cwd)
            shell.setCwd(options.cwd);
        // Kernel-credentialed on purpose: this only INSPECTS a file to decide how
        // to run it, and re-checks the caller's own execute permission at
        // invocation time — the `authorize` wrapper in exec-dispatch.ts.
        installPathExecResolver(registry, vfs.as(CRED_KERNEL), () => shell.getCwd());
        // node/curl/wget are bound to THIS workspace's kernel: their localhost
        // traffic resolves through its port registry and loopback router, not the
        // process-wide defaults the lazily-loaded commands would share.
        registry.register('node', createNodeCommand(kernel));
        registry.register('curl', createCurlCommand(kernel));
        registry.register('wget', createWgetCommand(kernel));
        const getHome = () => shell.getEnv().HOME ?? DEFAULT_HOME;
        const kernelFs = vfs.as(CRED_KERNEL);
        const runtimeLease = filesystem.openHost(CRED_KERNEL);
        // Everything past the lease can throw — a runtime source that fails to
        // list, a package that will not install. The workspace it would have
        // belonged to is never constructed, so nobody is left to close() it.
        try {
            const runtimes = new RuntimeManager({
                vfs: new ExecutionFs(runtimeLease.fs),
                registry,
                getHome,
                source: options.runtimeSource
                    ? composeRuntimeSources([suppliedRuntimeSource(options.runtimes ?? []), options.runtimeSource])
                    : suppliedRuntimeSource(options.runtimes ?? []),
            });
            if (options.facets) {
                await registerWasmRuntimes({
                    facets: options.facets,
                    vfs,
                    filesystem,
                    registry,
                    processes,
                    runtimes,
                });
            }
            if (options.runtimeInstall === 'on-demand') {
                // Stubs only for bins nothing already answers: a coreutil never yields
                // its name, and a rehydrated runtime is rebound below anyway.
                const stubbed = new Set();
                for (const runtimePackage of options.runtimes ?? []) {
                    for (const ep of runtimeEntrypoints(runtimePackage.manifest)) {
                        if (stubbed.has(ep.binName) || registry.has(ep.binName))
                            continue;
                        runtimes.registerInstallStub(ep.binName);
                        stubbed.add(ep.binName);
                    }
                }
                // Beyond the supplied packages: a name the registry cannot answer is
                // offered to the source — catalog reads only, no payload — and gets a
                // stub when something could satisfy it. Registered last so every real
                // command and the PATH resolver still win.
                const baseResolve = registry.resolve.bind(registry);
                registry.resolve = async (name) => {
                    const found = await baseResolve(name);
                    if (found)
                        return found;
                    if (!name || name.includes('/'))
                        return undefined;
                    try {
                        if (!await runtimes.resolvable(name))
                            return undefined;
                    }
                    catch {
                        return undefined;
                    }
                    runtimes.registerInstallStub(name);
                    return baseResolve(name);
                };
            }
            else {
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
            return new NimbusWorkspace(vfs, kernel, shell, registry, env, options.sql, processes, runtimes, shellProcessPid, supervisorOps, filesystem, runtimeLease);
        }
        catch (error) {
            await runtimeLease.dispose();
            throw error;
        }
    }
    async close() {
        await this.runtimeLease.dispose();
    }
    exec(command, options) {
        return this.commands.run(command, options);
    }
    /** The hosting object forwards its supervisorOp RPC to this method. */
    supervisorOp(envelope) {
        return this.supervisorOps(envelope);
    }
    /**
     * Apply the login files, and begin reading the terminal when there is one.
     *
     * Separate from {@link create} because a host with commands of its own must
     * register them first: `/etc/profile` and `~/.nimbusrc` are the user's
     * files, and either may name a command the host has yet to supply.
     */
    async start() {
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
 * Open the durable filesystem for a host that has not opened one itself.
 *
 * The revocation is here rather than in `create` because it is the act of
 * OPENING that carries it: pids at or below this generation's floor belong to
 * an instance that is gone, and their append capabilities must stop being
 * honoured before the first read. A host that opened the filesystem itself has
 * already done this, at the same seam, for the same reason.
 */
function openFilesystem(options) {
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
 * template, `${PORT:-3000}` in a package.json script.
 */
function defaultEnv() {
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
 * The identity the workspace's own `sh` runs commands under.
 *
 * Every command is credentialed by a live entry in the process table, which is
 * what makes `sudo`, `chown` and the per-process umask mean anything. `runAs`
 * is the privilege-transition path: it spawns a child of the calling process
 * under the requested credential and re-runs the command line through the
 * shell, so the elevated or dropped execution is a real table entry rather
 * than a flag on the parent's.
 */
function workspaceShellIdentity(processes, shellProcess, getShell) {
    const runAsProcess = async (parent, cred, argv) => {
        if (argv.length === 0)
            return 0;
        const child = processes.spawn(argv.join(' '), argv, parent.cwd, {
            parentPid: parent.pid,
            cred,
        });
        const identity = commandIdentityFor(child.pid);
        let exitCode = 1;
        try {
            const stdin = parent.stdin && parent.stdin !== parent.terminalStdin
                ? await parent.stdin.readAll()
                : undefined;
            const result = await getShell().execute(argv.map(quoteShellArgument).join(' '), {
                cwd: parent.cwd,
                env: parent.env,
                stdin,
                terminalStdin: parent.terminalStdin,
                signal: parent.signal,
                isolateShellState: true,
                terminalFds: {
                    stdin: parent.isFdTerminal?.(0) ?? false,
                    stdout: parent.isFdTerminal?.(1) ?? false,
                    stderr: parent.isFdTerminal?.(2) ?? false,
                },
                onStdout: textSink((data) => parent.stdout.write(data)),
                onStderr: textSink((data) => parent.stderr.write(data)),
                commandContext: {
                    pid: identity.pid,
                    cred: identity.cred,
                    setUmask: identity.setUmask,
                },
                runAs: runAsProcess,
            });
            exitCode = result.exitCode;
            return exitCode;
        }
        finally {
            processes.exit(child.pid, exitCode);
        }
    };
    const commandIdentityFor = (pid) => ({
        pid,
        get cred() {
            return processes.cred(pid);
        },
        setUmask(mask) {
            processes.setUmask(pid, mask);
        },
        runAs: runAsProcess,
    });
    return commandIdentityFor(shellProcess.pid);
}
function quoteShellArgument(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
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
 * Imported on demand: the runners carry the WASI shim and the bash scheduler as
 * source strings, and a workspace with no facet host must not pay to parse
 * them.
 */
async function registerWasmRuntimes(deps) {
    const [{ makeBashRunnerFactory }, { makeCPythonRunnerFactory }, { makeRubyRunnerFactory }, { makeClangRunnerFactory }, { wasmRunnerSpec }, { buildRuntimeHandler },] = await Promise.all([
        import('../runtime/bash-runner.js'),
        import('../runtime/cpython-runner.js'),
        import('../runtime/ruby-runner.js'),
        import('../runtime/clang-runner.js'),
        import('../runtime/wasm-runner.js'),
        import('../runtime/runtime-registry.js'),
    ]);
    // wasm-runner allocates pids for what it runs, off the SAME supervisor the
    // shell identity uses — the host's own when it supplied one.
    const processes = deps.processes;
    // Loaded on the first TypeScript or ESM script and not before. The module
    // statically imports `esbuild-wasm/esbuild.wasm`, which only wrangler
    // resolves — node instantiates it as a wasm module and fails on its Go
    // imports — so a host outside Cloudflare must be able to run a shell, bash
    // and python without that module ever entering its graph.
    let esbuild = null;
    deps.registry.register('wasm-runner', buildRuntimeHandler(wasmRunnerSpec({ filesystem: deps.filesystem, facets: deps.facets, processes }), {
        getEsbuild: () => {
            if (!esbuild) {
                esbuild = import('../runtime/esbuild-service.js')
                    .then((module) => new module.EsbuildService(deps.vfs.as(CRED_KERNEL)));
            }
            return esbuild;
        },
        registry: deps.registry,
    }));
    const runners = {
        'bash-runner': makeBashRunnerFactory({ facets: deps.facets, filesystem: deps.filesystem }),
        // No `startResident`: a workspace owns no actor that could outlive the
        // call, so a program that keeps serving is refused by name rather than
        // run as a one-shot that dies with it. Same for ruby, where a script is
        // the shape that may bind a port.
        'cpython-runner': makeCPythonRunnerFactory({ facets: deps.facets }),
        'ruby-runner': makeRubyRunnerFactory({ facets: deps.facets, filesystem: deps.filesystem, registry: deps.registry }),
        'clang-runner': makeClangRunnerFactory({ facets: deps.facets, filesystem: deps.filesystem }),
    };
    for (const [key, factory] of Object.entries(runners)) {
        deps.runtimes.registerRunner(key, factory);
    }
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
    'vfs_append_receipts_v2',
    'vfs_append_writer_state_v2',
    'vfs_append_module_state_v2',
    'vfs_append_pid_revocations_v2',
    'vfs_append_acked_gaps_v2',
    'vfs_ino_allocator',
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
 *
 * What a PRODUCT puts in a fresh filesystem — a banner, a welcome file, a
 * starter app — is not here. This is the base an OS needs in order to boot,
 * and it is exported because a host may need the filesystem before it needs a
 * shell: the Nimbus session seeds its starter project for a browser that hits
 * `/preview` without ever opening a terminal.
 */
export function seedBaseFilesystem(vfs, mounts) {
    const fs = vfs.as(CRED_SESSION_USER);
    const rootFs = vfs.as(CRED_KERNEL);
    // Created AS the session user, so the user owns their own tree. Seeding
    // these as the kernel is what makes a workspace where `.fs` cannot write.
    for (const mount of mounts) {
        if (mount !== 'etc' && !fs.exists(mount))
            fs.mkdir(mount, { recursive: true });
    }
    for (const dir of [
        'home/user', 'home/user/.config', 'home/user/projects',
        'tmp', 'var/log',
        'usr/bin', 'usr/lib', 'usr/lib/node_modules',
        'usr/share', 'usr/share/pkg', 'usr/share/pkg/node_modules',
        'usr/local', 'usr/local/lib', 'usr/local/lib/node_modules', 'usr/local/bin',
    ]) {
        if (!fs.exists(dir))
            fs.mkdir(dir, { recursive: true });
    }
    // /etc belongs to root, and is re-asserted rather than only created: a
    // user-writable /etc is an authority bug, not an untidy directory.
    if (!rootFs.exists('etc')) {
        rootFs.mkdir('etc', { mode: 0o755 });
    }
    else {
        const etc = rootFs.stat('etc');
        if (etc.uid !== 0 || etc.gid !== 0)
            rootFs.chown('etc', 0, 0);
        if ((etc.mode & 0o7777) !== 0o755)
            rootFs.chmod('etc', 0o755);
    }
    if (!rootFs.exists('etc/hostname')) {
        rootFs.writeFile('etc/hostname', `${DEFAULT_HOSTNAME}\n`);
        rootFs.chown('etc/hostname', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
    }
    if (!rootFs.exists('etc/os-release')) {
        rootFs.writeFile('etc/os-release', `NAME="Nimbus"\nVERSION="${NIMBUS_VERSION}"\nID=nimbus\n`
            + 'PRETTY_NAME="Nimbus — Cloud Dev Environment"\n');
        rootFs.chown('etc/os-release', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
    }
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
    const defaultProfile = `export PATH=${DEFAULT_PATH}\nexport EDITOR=nano\n`;
    if (!rootFs.exists('etc/profile')) {
        rootFs.writeFile('etc/profile', defaultProfile);
        rootFs.chown('etc/profile', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
    }
    else if (rootFs.readFileString('etc/profile') === 'export PATH=/usr/bin:/bin\nexport EDITOR=nano\n') {
        // The lifo default, from before Nimbus had a PATH of its own. Nobody ever
        // chose it, so replacing it is not overwriting a user's file.
        rootFs.writeFile('etc/profile', defaultProfile);
    }
    if (!fs.exists('home/user/.nimbusrc')) {
        fs.writeFile('home/user/.nimbusrc', '# Nimbus shell config\nalias ll="ls -la"\nalias la="ls -a"\nalias l="ls -1"\n');
    }
}
