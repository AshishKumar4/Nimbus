import { requireVfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SandboxFsImpl } from '@nimbus-sh/core/substrate/lifo/sandbox/SandboxFs.js';
import { ExecutionFs } from '@nimbus-sh/core/shell/execution-fs.js';
import { SUPERVISOR_OP_ROUTES, createSupervisorBridgeStore } from '@nimbus-sh/core/workspace/supervisor-op.js';
import { WebSocketTerminal } from '../facets/ws-terminal.js';
import { buildSessionSupervisorOps } from '../session/supervisor-op.js';
import { armResidentKeepalive, installLogPersistence, noteResidentClient, residentKeepaliveFired } from '../session/hibernation.js';
import { appendScrollback, ensureSessionStateSchema, loadScrollback, loadShellState, persistShellState } from '../session/state-store.js';
import { wireProcessLogSocketBroadcast } from '../runtime/process-logs-api.js';
import { routeRuntimeLoopback } from '../session/loopback.js';
import * as rpc from '../session/rpc.js';
import * as operations from '../session/programmatic.js';
import * as services from './services.js';
import { registerHostedCommands } from './commands.js';
import { z } from 'zod/v4';
import { adoptCtxExports, supervisorEntrypoint } from '@nimbus-sh/fabric/composition.js';
import { hostNamespaceBinding } from '@nimbus-sh/fabric/host-dispatch.js';
const HostedTask = z.enum(['resident-launch', 'resident-keepalive', 'log-flush', 'log-janitor']);
const InputFrame = z.discriminatedUnion('type', [
    z.object({ type: z.literal('input'), data: z.string() }),
    z.object({ type: z.literal('resize'), cols: z.number().int().positive(), rows: z.number().int().positive() }),
]);
class RuntimeOwner {
    options;
    terminal;
    _cpRegistry;
    _programmaticShellQueues = new Map();
    _hostedProcesses = new Map();
    _hostedProcessWaiters = new Map();
    _cirrusHmrWsClients = new Map();
    closing = null;
    _w9PersistWired = false;
    _w9SchemaInit = false;
    _w1KeepaliveArmed = false;
    _w1LastClientActivityAt = 0;
    _viteShimPid = null;
    _viteShimPort = null;
    wranglerAliasBannerShown = false;
    facetManagerComposed = null;
    facetProcessManager = null;
    esbuildService = null;
    bundlePool = null;
    npmInstaller = null;
    fetchProxyEntrypoint = null;
    viteDevServer = null;
    cirrusReal = null;
    nimbusWrangler = null;
    webSocketRelay = null;
    readyPromise = null;
    supervisor = null;
    flushScheduled = false;
    janitorScheduled = false;
    recoveryNotice = false;
    scheduling = new Set();
    fileLeases = new Map();
    services;
    constructor(options) {
        this.options = options;
        hostNamespaceBinding(options.env, 'HostedRuntime');
        const exports = Reflect.get(options.ctx, 'exports');
        if (!supervisorEntrypoint(exports)) {
            throw new Error('Export the configured supervisor entrypoint and call composeFabric before composing a hosted runtime');
        }
        adoptCtxExports(exports);
        ensureSessionStateSchema(options.ctx);
        this.terminal = new WebSocketTerminal(null, (data) => {
            appendScrollback(options.ctx, data, Date.now());
            persistShellState(options.ctx, { cwd: this.shell.getCwd(), env: this.shell.getEnv() });
        });
        this._cpRegistry = options.workspace.registry;
        this.services = services.bindRuntimeServices(this, {
            ctx: options.ctx,
            env: options.env,
            notify: (line) => this._notifySession(line),
            requestLaunchTurn: (at) => this._scheduleLaunchTurn(at),
            resolveWorkerLaunch: options.resolveWorkerLaunch,
            filesystem: () => options.workspace.filesystem,
            armResidentKeepalive: () => armResidentKeepalive(this, (at) => this.scheduleKeepalive(at)),
        });
        options.workspace.shell.bindTerminal(this.terminal);
        installLogPersistence(this, options.ctx, () => this.scheduleLogs());
        wireProcessLogSocketBroadcast(this.processes, options.ctx);
    }
    get ctx() { return this.options.ctx; }
    get _w1SessionDestroyed() { return this.closing !== null; }
    get env() { return this.options.env; }
    get sqliteFs() { return this.options.workspace.vfs; }
    get kernel() { return this.options.workspace.kernel; }
    get shell() { return this.options.workspace.shell; }
    get shellProcessPid() { return this.options.workspace.shellProcessPid; }
    get runtimeManager() { return this.options.workspace.runtimes; }
    get processes() { return this.options.workspace.processes; }
    get portRegistry() { return this.options.ports; }
    get facetManager() { return this.facetManagerComposed?.manager ?? null; }
    get sessionBasePath() { return this.options.basePath ?? ''; }
    get sessionOrigin() { return this.options.origin ?? ''; }
    get viteBasePath() { return `${this.sessionBasePath}/preview`; }
    get nimbusDebug() { return Reflect.get(this.env, 'NIMBUS_DEBUG') === '1'; }
    assertOpen() {
        if (this._w1SessionDestroyed)
            throw new Error('Nimbus runtime is closed');
    }
    ensureRuntimeReady() {
        this.assertOpen();
        this.readyPromise ??= (async () => {
            const saved = loadShellState(this.ctx);
            this.recoveryNotice = saved.hasPersistedState;
            if (saved.cwd)
                this.shell.setCwd(saved.cwd);
            if (saved.env)
                Object.assign(this.shell.getEnv(), saved.env);
            await registerHostedCommands(this, this.options.workspace);
            await this.options.workspace.start();
        })();
        return this.readyPromise;
    }
    ensureSqliteFs() { return this.sqliteFs; }
    routeLoopback(port, request) { return routeRuntimeLoopback(this.portRegistry, port, request); }
    ensureBundlePool() { this.assertOpen(); return this.services.ensureBundlePool(); }
    ensureFacetManager() { this.assertOpen(); return this.services.ensureFacetManager(); }
    ensureFetchProxy(log) { return this.services.ensureFetchProxy(log); }
    buildFetchFn(log) { return this.services.buildFetchFn(log); }
    ensureNpmInstaller(onProgress) { this.assertOpen(); return this.services.ensureNpmInstaller(onProgress); }
    ensureGlobalPrefixDirs(prefix) { return this.services.ensureGlobalPrefixDirs(prefix); }
    _envFlagDefaultOn(name) { return this.services._envFlagDefaultOn(name); }
    _ensureFacetProcessManager() { this.assertOpen(); return this.services._ensureFacetProcessManager(); }
    _ensureWebSocketRelay() { this.assertOpen(); return this.services._ensureWebSocketRelay(); }
    _setCpRegistry(registry) {
        if (registry !== this._cpRegistry)
            throw new Error('Nimbus runtime cannot replace the workspace registry');
    }
    _notifySession(line) { this.terminal.write(`${line}\r\n`); }
    _scheduleLaunchTurn(notBefore = Date.now()) {
        const pending = this.schedule('resident-launch', Math.max(Date.now(), notBefore));
        this.options.lifecycle.waitUntil(pending);
        return pending;
    }
    noteClientActivity() {
        noteResidentClient(this, (at) => this.scheduleKeepalive(at));
    }
    scheduleKeepalive(at) {
        const pending = this.schedule('resident-keepalive', at);
        this.options.lifecycle.waitUntil(pending);
        return pending.then(() => true, () => false);
    }
    schedule(reason, at) {
        if (this._w1SessionDestroyed)
            return Promise.reject(new Error('Nimbus runtime is closed'));
        // Registered before the deferred call runs, so close() waits for a turn
        // issued in the same tick; the second closed check keeps that turn from
        // arming an alarm the shutdown has already decided against.
        const pending = Promise.resolve().then(() => {
            if (this._w1SessionDestroyed)
                return;
            return this.options.lifecycle.schedule(reason, at);
        });
        this.scheduling.add(pending);
        void pending.then(() => this.scheduling.delete(pending), () => this.scheduling.delete(pending));
        return pending;
    }
    _reportExternalExit(pid, code, reason) { return rpc._reportExternalExit(this, pid, code, reason); }
    _emitExitDump(pid, code) { return rpc._emitExitDump(this, pid, code); }
    _emitShellExecDone(pid, command, code, duration) { return rpc._emitShellExecDone(this, pid, command, code, duration); }
    _rpcStdout(pid, data) { return rpc._rpcStdout(this, pid, data); }
    _rpcStderr(pid, data) { return rpc._rpcStderr(this, pid, data); }
    supervisorOps() {
        this.supervisor ??= buildSessionSupervisorOps(this, createSupervisorBridgeStore({
            vfs: this.options.workspace.vfs,
            filesystem: this.options.workspace.filesystem,
            processes: this.processes,
        }), Object.fromEntries(Object.values(SUPERVISOR_OP_ROUTES).map(({ method }) => {
            const handler = Reflect.get(rpc, method);
            if (typeof handler !== 'function')
                throw new Error(`Missing Nimbus supervisor implementation: ${method}`);
            return [method, (...args) => Reflect.apply(handler, undefined, [this, ...args])];
        })));
        return this.supervisor;
    }
    supervisorOp(envelope) {
        this.assertOpen();
        return this.supervisorOps().dispatch(envelope);
    }
    supervisorBridge(pid) { return this.supervisorOps().bridge(pid); }
    supervisorForgetBridge(pid) { this.supervisorOps().forget(pid); }
    scheduleLogs() {
        if (this._w1SessionDestroyed)
            return;
        if (!this.flushScheduled) {
            this.flushScheduled = true;
            this.options.lifecycle.waitUntil(this.schedule('log-flush', Date.now() + 250).catch((error) => {
                this.flushScheduled = false;
                throw error;
            }));
        }
        if (!this.janitorScheduled) {
            this.janitorScheduled = true;
            this.options.lifecycle.waitUntil(this.schedule('log-janitor', Date.now() + 60_000).catch((error) => {
                this.janitorScheduled = false;
                throw error;
            }));
        }
    }
    async onScheduled(task) {
        if (this._w1SessionDestroyed)
            return;
        if (task === 'resident-launch') {
            await this.ensureFacetManager().pumpLaunches();
        }
        else if (task === 'resident-keepalive') {
            const next = residentKeepaliveFired(this, this.ctx, Date.now());
            if (next !== null && !(await this.scheduleKeepalive(next)))
                this._w1KeepaliveArmed = false;
        }
        else if (task === 'log-flush') {
            this.flushScheduled = false;
            this.processes.flushLogs();
        }
        else {
            this.janitorScheduled = false;
            this.processes.dropLogsOlderThan(undefined, (pid) => !this.processes.get(pid));
            if (this.processes.stats.running > 0 || this.processes.logStats.totalPids > 0)
                this.scheduleLogs();
        }
    }
    async attachTerminal(ws, resume = 'reconnect') {
        await this.ensureRuntimeReady();
        if (this.terminal.ws === ws)
            return;
        this.terminal.attach(ws);
        if (resume === 'reconnect')
            this.terminal.write(loadScrollback(this.ctx));
        if (this.recoveryNotice) {
            this.terminal.write('\r\n[Runtime resumed; files and shell settings restored. Previous interpreter state was not retained.]\r\n');
            this.recoveryNotice = false;
        }
        if (!this.shell.running)
            this.shell.printPrompt();
        this.terminal.flushNow();
        ws.send(JSON.stringify({ type: 'ready' }));
    }
    async terminalFrame(ws, frame) {
        await this.attachTerminal(ws, 'wake');
        const text = typeof frame === 'string' ? frame : new TextDecoder().decode(frame);
        const input = InputFrame.parse(JSON.parse(text));
        this.terminal.handleMessage(input);
        persistShellState(this.ctx, { cwd: this.shell.getCwd(), env: this.shell.getEnv() });
    }
    terminalClose(ws) {
        if (this.terminal.ws !== ws)
            return;
        this.terminal.flushNow();
        persistShellState(this.ctx, { cwd: this.shell.getCwd(), env: this.shell.getEnv() });
        this.terminal.detach();
        this.processes.flushLogs();
    }
    files(cred) {
        this.assertOpen();
        const workspace = this.options.workspace;
        const identity = requireVfsCred(cred, 'runtime files');
        // One host lease per credential, not per `.as()` call: the descriptor
        // scope behind a lease lives until close(), so re-deriving a view for an
        // identity the runtime already opened must reuse that scope.
        const key = `${identity.uid}:${identity.gid}:${identity.groups.join(',')}:${identity.umask}`;
        let lease = this.fileLeases.get(key);
        if (!lease) {
            lease = workspace.filesystem.openHost(identity);
            this.fileLeases.set(key, lease);
        }
        const view = new SandboxFsImpl(new ExecutionFs(lease.fs), () => workspace.shell.getCwd());
        return Object.assign(view, { as: (next) => this.files(next) });
    }
    close() {
        this.closing ??= Promise.resolve().then(async () => {
            const failures = [];
            const clean = async (action) => {
                try {
                    await action();
                }
                catch (error) {
                    failures.push(error instanceof Error ? error : new Error(String(error)));
                }
            };
            await clean(() => this.terminal.disposeRepl());
            await clean(() => this.terminal.sendData('\x03'));
            for (const process of this.processes.getAll()) {
                await clean(() => this.webSocketRelay?.closeForPid(process.pid));
                if (process.state !== 'running')
                    continue;
                await clean(() => { if (!this.facetManager?.kill(process.pid))
                    this.processes.kill(process.pid); });
                await clean(() => { this.portRegistry.unregisterByPid(process.pid); });
            }
            await clean(() => this.viteDevServer?.stop());
            await clean(() => this.cirrusReal?.stop(this.ctx));
            await clean(() => this.nimbusWrangler?.stop());
            await clean(() => this.bundlePool?.dispose());
            await clean(() => this.processes.flushLogs());
            this.terminal.flushNow();
            this.terminal.close();
            for (const ws of this.ctx.getWebSockets('process-logs')) {
                await clean(() => ws.close(1000, 'runtime closed'));
            }
            await clean(() => this.facetManager?.closeLaunches());
            await Promise.allSettled(this.scheduling);
            await clean(() => this.supervisor?.dispose());
            for (const lease of this.fileLeases.values())
                await clean(() => lease.dispose());
            this.fileLeases.clear();
            await clean(() => this.options.workspace.close());
            for (const task of HostedTask.options)
                await clean(() => this.options.lifecycle.cancel(task));
            if (failures.length > 0)
                throw new AggregateError(failures, 'Nimbus runtime cleanup failed');
        });
        return this.closing;
    }
}
/** Every call an embedder makes is a client's: it notes activity for the resident keep-alive. */
function clientCalls(owner, calls) {
    const wrapped = Object.fromEntries(Object.entries(calls).map(([name, call]) => [name, (...args) => {
            owner.noteClientActivity();
            return Reflect.apply(call, undefined, args);
        }]));
    // Same keys, same signatures: each entry forwards its arguments unchanged.
    return wrapped;
}
export async function composeHostedRuntime(options) {
    const owner = new RuntimeOwner(options);
    await owner.ensureRuntimeReady();
    // Facet RPCs (supervisorOp), alarms and teardown are not clients.
    const client = clientCalls(owner, {
        facets: () => owner.ensureFacetManager(),
        ready: operations.ensureProgrammaticReady.bind(null, owner),
        exec: operations.rpcExec.bind(null, owner),
        execStream: operations.rpcExecStream.bind(null, owner),
        runCode: operations.rpcRunCode.bind(null, owner),
        startProcess: operations.rpcStartProcess.bind(null, owner),
        listProcesses: operations.rpcListProcesses.bind(null, owner),
        killProcess: operations.rpcKillProcess.bind(null, owner),
        writeProcessInput: operations.rpcWriteProcessInput.bind(null, owner),
        endProcessInput: operations.rpcEndProcessInput.bind(null, owner),
        resizeProcess: operations.rpcResizeProcess.bind(null, owner),
        signalProcess: operations.rpcSignalProcess.bind(null, owner),
        processLogs: (pid, options) => operations.rpcProcessLogs(owner, pid, options),
        listPorts: operations.rpcListPorts.bind(null, owner),
        listApps: operations.rpcListApps.bind(null, owner),
        ensureDurableApp: operations.rpcEnsureDurableApp.bind(null, owner),
        unexposePort: operations.rpcUnexposePort.bind(null, owner),
        removeDurableApp: operations.rpcRemoveDurableApp.bind(null, owner),
        exposeApp: operations.rpcExposeApp.bind(null, owner),
        removeApp: operations.rpcRemoveApp.bind(null, owner),
        rotateLink: operations.rpcRotateLink.bind(null, owner),
        installRuntime: operations.rpcInstallRuntime.bind(null, owner),
        ensureRuntimes: operations.rpcEnsureRuntimes.bind(null, owner),
        listRuntimes: operations.rpcListRuntimes.bind(null, owner),
        spawnWorker: operations.rpcSpawnWorker.bind(null, owner),
        routeCapabilityPort: async (...args) => {
            await operations.ensureProgrammaticReady(owner);
            return owner.ensureFacetManager().apps.routeCapabilityPort(...args);
        },
        attachTerminal: (ws) => owner.attachTerminal(ws),
        terminalFrame: (ws, message) => owner.terminalFrame(ws, message),
    });
    return {
        workspace: options.workspace,
        terminal: owner.terminal,
        files: owner.files(owner.processes.cred(owner.shellProcessPid)),
        runtimes: owner.runtimeManager,
        ...client,
        supervisorOp: (envelope) => owner.supervisorOp(envelope),
        onScheduled: (task) => owner.onScheduled(task),
        terminalClose: (ws) => owner.terminalClose(ws),
        close: () => owner.close(),
    };
}
