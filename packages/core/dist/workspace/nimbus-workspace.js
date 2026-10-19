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
import { createDefaultRegistry } from '../substrate/lifo/commands/registry.js';
import { createNodeCommand } from '../substrate/lifo/commands/system/node.js';
import { createCurlCommand } from '../substrate/lifo/commands/net/curl.js';
import { createWgetCommand } from '../substrate/lifo/commands/net/wget.js';
import { createDigCommand } from '../substrate/lifo/commands/net/dig.js';
import { createPingCommand } from '../substrate/lifo/commands/net/ping.js';
import { selectProcessEgress, workspaceNetwork } from '../_shared/workspace-network.js';
import { runCommand } from '../substrate/lifo/sandbox/run-command.js';
import { HeadlessTerminal } from '../substrate/lifo/sandbox/HeadlessTerminal.js';
import { SqliteVFS, STORE_TABLES } from '../vfs/sqlite-vfs.js';
import { DEFAULT_HOME, DEFAULT_HOSTNAME, defaultPath, SEEDED_TOP_LEVEL_DIRS, DEFAULT_SHELL, DEFAULT_USER, NIMBUS_VERSION, } from '../constants.js';
import { BASH_RUNNER_CONTRACTS, CPYTHON_RUNNER_CONTRACTS, GIT_RUNNER_CONTRACTS, CRED_KERNEL, CRED_SESSION_USER } from '../runtime/os-contracts.js';
import { ProcessFiles } from '../runtime/process-files.js';
import { ProcessView } from '../runtime/process-files.js';
import { WorkspaceFs } from './workspace-fs.js';
import { PID_GEN_STRIDE } from '../runtime/process-table.js';
import { isKillRefusal, SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import { ChildProcessManager } from '../runtime/child-process-manager.js';
import { resolveWorkspaceChild } from './child-process-runner.js';
import { exitCodeForSignal, signalAbortReason, signalAbortReasonOf, signalDisposition, signalOfStatus } from '../substrate/lifo/shell/signals.js';
import { runtimeEntrypoints } from '../runtime/installed-runtimes.js';
import { RuntimeManager } from '../runtime/runtime-manager.js';
import { moveHomeRuntimes, RUNTIME_STORE } from '../runtime/runtime-store.js';
import { normalizeVfsPath } from '../vfs/path.js';
import { makeNimbusVerbHandler } from '../runtime/nimbus-command.js';
import { composeRuntimeSources, suppliedRuntimeSource, } from '../runtime/runtime-package.js';
import { registerUnixCommands } from '../shell/unix-commands.js';
import { registerMountCommands } from '../shell/mount-commands.js';
import { installPathExecResolver } from '../shell/exec-dispatch.js';
import { adoptCtxExports, composeFabric } from '@nimbus-sh/platform/composition.js';
import { createSupervisorOpHandler } from './supervisor-op.js';
import { NamedShells, SHELLS_TABLE } from './named-shells.js';
export { parseShellState } from './named-shells.js';
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
    children;
    supervisorOps;
    filesystem;
    hostLeases;
    identity;
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
    fs;
    /** The raw durable filesystem, for hosts that need uid-aware operations. */
    vfs;
    kernel;
    /**
     * The network the workspace's commands and programs use: its egress when
     * the host supplied one ({@link NimbusWorkspaceOptions.egress}), else the
     * isolate's. Everything that loads a Dynamic Worker for the workspace
     * gives it `loaderOutbound(workspace.network)`.
     */
    get network() { return this.kernel.network; }
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
    namedShells;
    constructor(vfs, kernel, shell, registry, env, sql, processes, children, runtimes, shellProcessPid, supervisorOps, filesystem, hostLeases, 
    /** Who the workspace shell acts as, and so every call's process. */
    identity) {
        this.sql = sql;
        this.children = children;
        this.supervisorOps = supervisorOps;
        this.filesystem = filesystem;
        this.hostLeases = hostLeases;
        this.identity = identity;
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
        // Everything the OS keeps per user follows the configured home: the
        // seeded home directory, its /etc/passwd entry, PATH and the XDG dirs.
        const home = options.env?.HOME ?? DEFAULT_HOME;
        if (!home.startsWith('/'))
            throw new Error(`HOME must be an absolute path, got ${JSON.stringify(home)}`);
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
        if (filesystem.engine !== vfs)
            throw new Error('The workspace filesystem must be over the workspace SqliteVFS');
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
        if (!options.processes)
            processes.setPidBase((options.generation ?? 1) * PID_GEN_STRIDE);
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
        let workspace = null;
        const children = new ChildProcessManager({
            processes,
            resolve: (request, origin) => {
                if (!workspace)
                    throw new Error('Nimbus: workspace is not initialized');
                return resolveWorkspaceChild(workspace, request, origin);
            },
            terminate: (pid, signal) => processes.kill(pid, exitCodeForSignal(signal)),
        });
        if (options.childProcesses)
            children.bindHost(options.childProcesses);
        const host = options.facets;
        const facets = host ? {
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
        let shell;
        let identity;
        let shellProcessPid;
        if (options.identity) {
            identity = options.identity;
            shellProcessPid = options.identity.pid;
        }
        else {
            const shellProcess = processes.spawn('sh', ['sh'], options.cwd ?? home);
            shellProcessPid = shellProcess.pid;
            identity = workspaceShellIdentity(processes, shellProcess, () => shell);
        }
        shell = new Shell(options.terminal ?? new HeadlessTerminal(), filesystem, registry, env, processes, identity);
        if (options.cwd)
            shell.setCwd(options.cwd);
        // Past a shell's own jobs, `kill` reaches by pid every process this
        // workspace runs work for (another shell's job, an exec, a child
        // process), and ends it by stopping that work; never the workspace's
        // own shell, which outlives every line it runs. A host that runs
        // processes of its own replaces this (Shell.setHostProcessSignals).
        const processSignals = {
            isLive: (pid) => pid === shellProcessPid || processes.runsWork(pid),
            async signal(pid, signal, _stderr, caller) {
                const disposition = signal === '0' ? null : signalDisposition(signal);
                if (disposition === 'terminate' && pid !== shellProcessPid) {
                    // The kill makes kill(2)'s check itself.
                    try {
                        return processes.killAs(caller, pid, exitCodeForSignal(signal), signalAbortReason(signal)) ? 'delivered' : 'no-such-process';
                    }
                    catch (error) {
                        if (isKillRefusal(error))
                            return 'not-permitted';
                        throw error;
                    }
                }
                // A signal that ends nothing asks the same rule alone.
                if (!processes.maySignal(caller, pid))
                    return 'not-permitted';
                if (disposition === null)
                    return 'delivered';
                if (pid === shellProcessPid)
                    return 'not-permitted';
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
        const hostLeases = [];
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
            }
            catch (error) {
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
                    if (missing.length === 0)
                        continue;
                    const { name, version } = runtimePackage.manifest;
                    throw new Error(`runtime package ${name}@${version} needs runner '${missing.join("', '")}', `
                        + `which this @nimbus-sh/core does not provide (it provides '${runtimes.runnerKeys().join("', '")}'). `
                        + 'Install the runtime package release built for this core.');
                }
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
                registry.resolve = async (name, from) => {
                    const found = await baseResolve(name, from);
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
                    return baseResolve(name, from);
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
            workspace = new NimbusWorkspace(vfs, kernel, shell, registry, env, options.sql, processes, children, runtimes, shellProcessPid, supervisorOps, filesystem, hostLeases, identity);
            return workspace;
        }
        catch (error) {
            // What ended create() is what it throws, though a release fails too.
            await releaseHostLeases(hostLeases).catch(() => { });
            throw error;
        }
    }
    async close() {
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
    exec(command, options = {}) {
        const { shellId, detach, ...call } = options;
        if (shellId === undefined)
            return this.runProcess(command, call, null);
        return this.withNamedShell(shellId, { detach }, (named) => this.runProcess(command, call, named));
    }
    async runProcess(command, options, named) {
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
        }
        finally {
            this.processes.exit(pid, exitCode);
            // Its descriptors close as it exits; its entry, and what it bound in
            // the filesystem, go even if one fails to.
            try {
                await shell.closeDescriptors();
            }
            finally {
                stopped();
                await this.processes.reapTree(pid);
            }
        }
    }
    /**
     * A shell of its own for process `pid`, a second cwd and environment over
     * the workspace shell's filesystem, commands and kernel. It starts in
     * `state.cwd` with the workspace shell's environment and `state.env` on
     * top; with `inheritEnv: false`, with `state.env` alone (a command run again
     * as it was once run). Its commands act as `pid` (`$$`, and the credential and umask
     * {@link processes} holds for it); `sudo` and `su` go through the workspace
     * shell's identity, and `kill` reaches what the workspace shell's does.
     *
     * For a host that runs a command under a process of its own. When that
     * process ends, {@link Shell.closeDescriptors} closes what an `exec` in it
     * left open.
     */
    shellFor(pid, state) {
        const processes = this.processes;
        const shell = new Shell(new HeadlessTerminal(), this.filesystem, this.registry, { ...(state.inheritEnv === false ? {} : this.shell.getEnv()), ...state.env }, processes, {
            pid,
            get cred() { return processes.cred(pid); },
            setUmask: (mask) => processes.setUmask(pid, mask),
            runAs: this.shell.getRunAsHost(),
        });
        const hostSignals = this.shell.getHostProcessSignals();
        if (hostSignals)
            shell.setHostProcessSignals(hostSignals);
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
    withNamedShell(id, options, body) {
        return this.namedShells.hold(id, options, body);
    }
    /** Read a named shell's saved cwd and exact UTF-16 environment, or null if it has no saved state. */
    shellState(id) {
        return this.namedShells.read(id);
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
/** Open the durable filesystem for a host that has not opened one itself. */
function openFilesystem(options) {
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
function defaultEnv(home) {
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
async function releaseHostLeases(leases) {
    // Each asked in its own promise, so one that throws at once stops no other.
    const failed = (await Promise.allSettled(leases.map(async (lease) => lease.dispose()))).find((outcome) => outcome.status === 'rejected');
    if (failed)
        throw failed.reason;
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
function workspaceShellIdentity(processes, shellProcess, getShell) {
    const runAsProcess = async (parent, cred, argv) => {
        if (argv.length === 0)
            return { status: 0, signal: null };
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
            if (child.state === 'killed' && child.exitCode !== null)
                return { status: child.exitCode, signal: signalOfStatus(child.exitCode) };
            const stoppedBy = ran.signal === null ? signalAbortReasonOf(stopped.signal) : null;
            if (stoppedBy === null)
                return ran;
            exitCode = stoppedBy.exitCode;
            return { status: stoppedBy.exitCode, signal: stoppedBy.signal };
        }
        finally {
            endWork();
            endAwait();
            // Its program has returned, its cleanup done: what it bound is released at its end.
            stopped();
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
function registerWasmRuntimes(deps) {
    // wasm-runner allocates pids for what it runs, off the SAME supervisor the
    // shell identity uses — the host's own when it supplied one.
    const processes = deps.processes;
    // This workspace is the session its runtimes' warm facets belong to (warm-facets.ts).
    const session = crypto.randomUUID();
    const wasmRunner = once(async () => {
        const [{ wasmRunnerSpec }, { buildRuntimeHandler }] = await Promise.all([
            import('../runtime/wasm-runner.js'),
            import('../runtime/runtime-registry.js'),
        ]);
        return buildRuntimeHandler(wasmRunnerSpec({ filesystem: deps.filesystem, facets: deps.facets, processes }), {
            // wasm-runner reads its .wasm itself (bypassesScriptRead), so the
            // registry never asks a workspace for a transformer: none is loaded.
            getEsbuild: () => {
                throw new Error('Nimbus: a workspace runs no JavaScript source, so it has no transformer');
            },
            registry: deps.registry,
        });
    });
    deps.registry.register('wasm-runner', async (ctx) => (await wasmRunner())(ctx));
    // Each factory is made once, on the first install or rehydrate that binds
    // its runner, and every later bin reuses it.
    const lazy = (make) => {
        const factory = once(make);
        return async (...args) => (await factory())(...args);
    };
    // No `startResident`: a workspace owns no actor that could outlive the
    // call, so a program that keeps serving is refused by name rather than run
    // as a one-shot that dies with it. Same for ruby, where a script is the
    // shape that may bind a port.
    const cpython = (restartsWaits) => lazy(async () => (await import('../runtime/cpython-runner.js'))
        .makeCPythonRunnerFactory({ facets: deps.facets, filesystem: deps.filesystem, processes, network: deps.network, restartsWaits, session }));
    const bash = lazy(async () => (await import('../runtime/bash-runner.js'))
        .makeBashRunnerFactory({ facets: deps.facets, filesystem: deps.filesystem, processes }));
    const runners = {
        ...Object.fromEntries(Object.keys(BASH_RUNNER_CONTRACTS).map((key) => [key, bash])),
        ...Object.fromEntries(Object.entries(CPYTHON_RUNNER_CONTRACTS).map(([key, { restartsWaits }]) => [key, cpython(restartsWaits)])),
        'ruby-runner': lazy(async () => (await import('../runtime/ruby-runner.js'))
            .makeRubyRunnerFactory({ facets: deps.facets, filesystem: deps.filesystem, processes, registry: deps.registry, getHome: deps.getHome, network: deps.network })),
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
function once(make) {
    let pending = null;
    return () => {
        pending ??= make().catch((error) => {
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
];
/** Whether the session's user may make a name in the directory `entry` is (its write bit for the user). */
function userMayWrite(entry) {
    if (entry === null)
        return false;
    const { uid, gid, groups } = CRED_SESSION_USER;
    if (entry.uid === uid)
        return (entry.mode & 0o200) !== 0;
    if (entry.gid === gid || groups.includes(entry.gid))
        return (entry.mode & 0o020) !== 0;
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
function* baseSeed(home) {
    const exists = function* (as, path) {
        return (yield { op: 'exists', as, path });
    };
    const stat = function* (path) {
        return (yield { op: 'stat', as: 'kernel', path });
    };
    const lstat = function* (path) {
        return (yield { op: 'lstat', as: 'kernel', path });
    };
    // Top-level directories are the kernel's to make (`/` is 0755 root), and
    // handed to the session user, who owns their own tree: seeding them owned
    // by the kernel is what makes a workspace where `.fs` cannot write.
    // `/etc` and `/usr` are root's, below.
    for (const top of SEEDED_TOP_LEVEL_DIRS) {
        if (top === 'etc' || top === 'usr' || (yield* exists('kernel', top)))
            continue;
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
        if (!rootsDirs.has(dir.slice(0, Math.max(0, dir.lastIndexOf('/')))))
            continue;
        const entry = yield* lstat(dir);
        if (entry === null) {
            yield { op: 'mkdir', as: 'kernel', path: dir, mode: 0o755 };
            rootsDirs.add(dir);
            continue;
        }
        if (entry.type !== 'directory')
            continue;
        if (entry.uid !== 0 || entry.gid !== 0)
            yield { op: 'chown', as: 'kernel', path: dir, uid: 0, gid: 0 };
        if ((entry.mode & 0o7777) !== 0o755)
            yield { op: 'chmod', as: 'kernel', path: dir, mode: 0o755 };
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
        let parent = { type: 'directory', uid: 0, gid: 0, mode: 0o755 };
        for (let i = 1; i <= names.length; i++) {
            const path = names.slice(0, i).join('/');
            const leaf = i === names.length;
            const entry = yield* lstat(path);
            if (entry === null) {
                if (rootsOnly) {
                    // Its parents stay root's; the home itself is the user's.
                    yield { op: 'mkdir', as: 'kernel', path, mode: 0o755, ...(leaf ? { handTo: user } : {}) };
                    parent = { type: 'directory', ...(leaf ? user : { uid: 0, gid: 0 }), mode: 0o755 };
                }
                else if (userMayWrite(parent)) {
                    yield { op: 'mkdir', as: 'user', path, mode: 0o755 };
                    parent = { type: 'directory', ...user, mode: 0o755 };
                }
                else {
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
        if (!(yield* exists('user', dir)))
            yield { op: 'mkdir', as: 'user', path: dir, recursive: true };
    }
    // /etc belongs to root, and is re-asserted rather than only created: a
    // user-writable /etc is an authority bug, not an untidy directory.
    if (!(yield* exists('kernel', 'etc'))) {
        yield { op: 'mkdir', as: 'kernel', path: 'etc', mode: 0o755 };
    }
    else {
        const etc = yield* stat('etc');
        if (etc.uid !== 0 || etc.gid !== 0)
            yield { op: 'chown', as: 'kernel', path: 'etc', uid: 0, gid: 0 };
        if ((etc.mode & 0o7777) !== 0o755)
            yield { op: 'chmod', as: 'kernel', path: 'etc', mode: 0o755 };
    }
    // Root-owned 0644, and re-asserted rather than only created: these decide
    // what `id`, `chown` and `su` believe, so a user-writable /etc/passwd would
    // be an authority bug rather than an untidy file.
    const accountFile = function* (path, content) {
        if (!(yield* exists('kernel', path)))
            yield { op: 'writeFile', as: 'kernel', path, content, mode: 0o644 };
        const current = yield* stat(path);
        if (current.uid !== 0 || current.gid !== 0)
            yield { op: 'chown', as: 'kernel', path, uid: 0, gid: 0 };
        if ((current.mode & 0o7777) !== 0o644)
            yield { op: 'chmod', as: 'kernel', path, mode: 0o644 };
    };
    const passwdFor = (dir) => `root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:Nimbus User:${dir}:/bin/sh\n`;
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
    if (seededProfiles.includes((yield { op: 'readText', as: 'kernel', path: 'etc/profile' }))) {
        yield { op: 'writeFile', as: 'kernel', path: 'etc/profile', content: defaultProfile };
    }
    if (homeDir !== '' && !(yield* exists('user', `${homeDir}/.nimbusrc`))) {
        yield {
            op: 'writeFile', as: 'user', path: `${homeDir}/.nimbusrc`,
            content: '# Nimbus shell config\nalias ll="ls -la"\nalias la="ls -a"\nalias l="ls -1"\n',
        };
    }
}
export function seedBaseFilesystem(target, home = DEFAULT_HOME) {
    const steps = baseSeed(home);
    if (target instanceof ProcessFiles)
        return seedOnNamespace(steps, target);
    const views = { kernel: target.as(CRED_KERNEL), user: target.as(CRED_SESSION_USER) };
    for (let step = steps.next(); !step.done;)
        step = steps.next(engineStep(views[step.value.as], step.value));
}
/**
 * The base seed on a namespace: each step placed by the namespace's
 * dispatcher (WaveIngest.placesHere, as a wave's records are). One placed on
 * the session's filesystem is the engine's, as the session's own seed makes
 * it; any other is the call a program would make on the namespace.
 */
async function seedOnNamespace(steps, filesystem) {
    const mounted = { kernel: filesystem.vfs.as(CRED_KERNEL), user: filesystem.vfs.as(CRED_SESSION_USER) };
    const engine = { kernel: filesystem.engine.as(CRED_KERNEL), user: filesystem.engine.as(CRED_SESSION_USER) };
    const text = new TextEncoder();
    for (let step = steps.next(); !step.done;) {
        const call = step.value;
        let answer;
        const cred = call.as === 'kernel' ? CRED_KERNEL : CRED_SESSION_USER;
        // A directory above a mount point is the root's, as a wave's directory
        // record there is. A step is placed as its call looks its name up: every
        // one follows a link at it but an lstat and a lone mkdir (mkdir -p stats
        // it first).
        const follow = call.op === 'lstat' ? false : call.op !== 'mkdir' || call.recursive === true;
        if (filesystem.waves.placesHere(engine[call.as], [call.path], { aboveMounts: true, follow })) {
            answer = engineStep(engine[call.as], call);
        }
        else {
            const view = mounted[call.as];
            const path = '/' + call.path;
            switch (call.op) {
                case 'exists':
                    answer = (await view.stat(path)) !== null;
                    break;
                case 'stat': {
                    const found = await view.stat(path);
                    if (found === null)
                        throw new Error(`seed: ${path} vanished`);
                    answer = { uid: found.uid ?? 0, gid: found.gid ?? 0, mode: found.mode ?? 0 };
                    break;
                }
                case 'lstat': {
                    const found = await view.stat(path, { follow: false });
                    answer = found === null ? null : { type: found.type, uid: found.uid ?? 0, gid: found.gid ?? 0, mode: found.mode ?? 0 };
                    break;
                }
                case 'readText':
                    answer = new TextDecoder().decode(await view.readFile(path));
                    break;
                case 'mkdir':
                    if (call.atomicOnly) {
                        throw new Error(`seed: ${path} is below a directory its user may change, on a mount, where it cannot be made and handed over in one step`);
                    }
                    await view.mkdir(path, { ...(call.recursive ? { recursive: true } : {}), ...(call.mode === undefined ? {} : { mode: call.mode }) });
                    // Below directories only root may change: no one can replace the name in between.
                    if (call.handTo)
                        await unlessUnsupported(view.chown(path, call.handTo.uid, call.handTo.gid));
                    break;
                // A mount that keeps no owners or modes (ENOTSUP) has none to hand over.
                case 'chown':
                    await unlessUnsupported(view.chown(path, call.uid, call.gid));
                    break;
                case 'chmod':
                    await unlessUnsupported(view.chmod(path, call.mode));
                    break;
                case 'writeFile':
                    await view.writeFile(path, text.encode(call.content), call.mode === undefined ? undefined : { mode: call.mode });
                    break;
            }
        }
        step = steps.next(answer);
    }
}
/** A seed step on an engine view: its answer. */
function engineStep(view, call) {
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
            if (call.handTo)
                view.chown(call.path, call.handTo.uid, call.handTo.gid, { followSymlinks: false });
            return undefined;
        case 'chown':
            view.chown(call.path, call.uid, call.gid);
            return undefined;
        case 'chmod':
            view.chmod(call.path, call.mode);
            return undefined;
        case 'writeFile':
            view.writeFile(call.path, call.content, call.mode === undefined ? undefined : { mode: call.mode });
            return undefined;
    }
}
async function unlessUnsupported(call) {
    try {
        await call;
    }
    catch (error) {
        if (error.code !== 'ENOTSUP')
            throw error;
    }
}
