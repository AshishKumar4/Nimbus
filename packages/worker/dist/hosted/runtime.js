import { requireVfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { ProcessView } from '@nimbus-sh/core/runtime/process-files.js';
import { SUPERVISOR_OP_ROUTES, createSupervisorBridgeStore } from '@nimbus-sh/core/workspace/supervisor-op.js';
import { openSupervisorDeliveries } from '@nimbus-sh/core/workspace/supervisor-delivery.js';
import { isHostedWatch, isHostedWebSocket, isHostedResidency } from '@nimbus-sh/fabric/peer-host.js';
import { hostActivity } from '@nimbus-sh/fabric/host-activity.js';
import { WebSocketTerminal } from '../facets/ws-terminal.js';
import { NamedTerminals } from '../session/named-terminals.js';
import { exitCodeForSignal, signalAbortReason } from '@nimbus-sh/core/substrate/lifo/shell/signals.js';
import { nimbusDebugEnabled } from '../_shared/nimbus-debug.js';
import { answerSupervisorOp, buildSessionSupervisorOps } from '../session/supervisor-op.js';
import { armLogJanitor, armResidentKeepalive, endResidentKeepalive, installLogPersistence, logJanitorFired, noteResidentClient, residentKeepaliveFired } from '../session/hibernation.js';
import { takeLegacyResetNotice } from '../session/legacy-reset.js';
import { appendScrollback, ensureSessionStateSchema, loadScrollback, loadShellState, persistShellState } from '../session/state-store.js';
import { wireProcessLogSocketBroadcast } from '../runtime/process-logs-api.js';
import { routeRuntimeLoopback } from '../session/loopback.js';
import * as rpc from '../session/rpc.js';
import * as operations from '../session/programmatic.js';
import * as services from './services.js';
import { registerHostedCommands } from './commands.js';
import { HostedSession } from './session.js';
import { z } from 'zod/v4';
import { adoptCtxExports, supervisorEntrypoint } from '@nimbus-sh/fabric/composition.js';
import { hostNamespaceBinding } from '@nimbus-sh/fabric/host-dispatch.js';
import { restoreDevServers } from '../session/dev-servers.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
const HostedTask = z.enum(['resident-launch', 'resident-keepalive', 'log-flush', 'log-janitor', 'hosting-watch']);
const InputFrame = z.discriminatedUnion('type', [
    z.object({ type: z.literal('input'), data: z.string() }),
    z.object({ type: z.literal('resize'), cols: z.number().int().positive(), rows: z.number().int().positive() }),
]);
class RuntimeOwner {
    options;
    terminal;
    terminals;
    _cpRegistry;
    _storedShellsAdopted;
    _cirrusHmrWsClients = new Map();
    closing = null;
    _w9PersistWired = false;
    _w9SchemaInit = false;
    _w1Keepalive = null;
    _w1JanitorAt = null;
    _w1LastClientActivityAt = 0;
    _viteShimPid = null;
    _viteShimPort = null;
    wranglerAliasBannerShown = false;
    facetManagerComposed = null;
    childProcessManager = null;
    esbuildService = null;
    bundlePool = null;
    npmInstaller = null;
    viteDevServer = null;
    cirrusReal = null;
    nimbusWrangler = null;
    webSocketRelay = null;
    readyPromise = null;
    /** Usable once its commands are registered, before the login files run: what they may wait on waits on this, not on them. */
    usablePromise = null;
    supervisor = null;
    flushScheduled = false;
    recoveryNotice = false;
    legacyNotice = null;
    scheduling = new Set();
    fileLeases = new Map();
    services;
    _peerHost = null;
    /** The workspace's namespace and process bindings. */
    getFilesystemAuthority() { return this.options.workspace.filesystem; }
    /** This instance's receipts for its processes' mutations delivered exactly once (see NimbusSession). */
    supervisorDeliveries;
    constructor(options) {
        this.options = options;
        hostNamespaceBinding(options.env, 'HostedRuntime');
        this.supervisorDeliveries = openSupervisorDeliveries(options.ctx);
        const exports = Reflect.get(options.ctx, 'exports');
        if (!supervisorEntrypoint(exports)) {
            throw new Error('Export the configured supervisor entrypoint and call composeFabric before composing a hosted runtime');
        }
        adoptCtxExports(exports);
        ensureSessionStateSchema(options.ctx);
        // A process's answers leave as the rest of its output does: once what it wrote is published.
        options.ports.setOutput(options.workspace.processes);
        options.ports.setClientSocketActivity(() => noteResidentClient(this, this.keepaliveCycle));
        this.terminal = new WebSocketTerminal(null, (data) => {
            appendScrollback(options.ctx, data, Date.now());
            persistShellState(options.ctx, { cwd: this.shell.getCwd(), env: this.shell.getEnv(), vars: this.shell.getVariableAttributes() });
        }, (send) => void this.processes.releaseOutput(this.shellProcessPid, send));
        this._cpRegistry = options.workspace.registry;
        this.services = services.bindRuntimeServices(this, {
            ctx: options.ctx,
            env: options.env,
            notify: (line) => this._notifySession(line),
            requestLaunchTurn: (at) => this._scheduleLaunchTurn(at),
            resolveWorkerLaunch: options.resolveWorkerLaunch,
            filesystem: () => options.workspace.filesystem,
            network: () => options.workspace.network,
            armResidentKeepalive: () => armResidentKeepalive(this, this.keepaliveCycle),
            supervisorOp: (envelope) => this.supervisorOp(envelope),
        });
        options.workspace.shell.bindTerminal(this.terminal);
        // The session's own shell, and everything it starts, are its terminal's.
        options.workspace.processes.setControllingTerminal(options.workspace.shellProcessPid, '');
        this.terminals = new NamedTerminals({ ctx: options.ctx, workspace: () => options.workspace, hangUp: (pid) => this.hangUp(pid) });
        installLogPersistence(this, options.ctx, () => this.scheduleLogs(), () => armLogJanitor(this, (at) => this.scheduleJanitor(at)));
        wireProcessLogSocketBroadcast(this.processes, options.ctx);
    }
    get ctx() { return this.options.ctx; }
    get _w1SessionDestroyed() { return this.closing !== null; }
    get env() { return this.options.env; }
    get runtimeWorkspace() { return this.options.workspace; }
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
    get nimbusDebug() { return nimbusDebugEnabled(this.env); }
    assertOpen() {
        if (this._w1SessionDestroyed)
            throw new Error('Nimbus runtime is closed');
    }
    ensureRuntimeReady() {
        this.assertOpen();
        if (this.readyPromise === null) {
            const usable = (async () => {
                // Files a pre-v2 Nimbus wrote are not read: say so, and start cold.
                this.legacyNotice = takeLegacyResetNotice(this.sqliteFs, this.ctx);
                const saved = loadShellState(this.ctx);
                this.recoveryNotice = saved.hasPersistedState;
                if (saved.cwd)
                    this.shell.setCwd(saved.cwd);
                if (saved.env) {
                    Object.assign(this.shell.getEnv(), saved.env);
                    // Its variables' marks and arrays; a terminal saved before them is restored as a shell
                    // starts over its variables, each exported, as each reached its programs then.
                    this.shell.restoreVariableAttributes(saved.vars ?? undefined, Object.keys(saved.env));
                }
                await registerHostedCommands(this, this.options.workspace);
                await this.ensureFacetManager().pumpLaunches();
            })();
            this.usablePromise = usable;
            this.readyPromise = usable.then(async () => {
                await this.options.workspace.start();
                // The dev servers the previous incarnation ran start again, once it is ready.
                this.restoreDevServers().catch((error) => console.warn(`[runtime] restoring the dev servers failed: ${errorText(error)}`));
            });
        }
        return this.readyPromise;
    }
    /** Its commands registered: the login files' commands run from here on. */
    ensureUsable() {
        const ready = this.ensureRuntimeReady();
        return this.usablePromise ?? ready;
    }
    ensureSqliteFs() { return this.sqliteFs; }
    /** What restoring the dev servers reads of this runtime: its readiness short of the login files, which may wait on the restore. */
    devServerHost = null;
    /** The dev servers the previous incarnation ran, started again once (dev-servers.ts). */
    restoreDevServers() {
        const owner = this;
        this.devServerHost ??= {
            ctx: this.ctx,
            get processes() { return owner.processes; },
            get portRegistry() { return owner.portRegistry; },
            get runtimeWorkspace() { return owner.runtimeWorkspace; },
            ensureRuntimeReady: () => this.ensureUsable(),
        };
        return restoreDevServers(this.devServerHost);
    }
    routeLoopback(port, request) {
        return routeRuntimeLoopback(this.portRegistry, port, request, (dark) => this.ensureFacetManager().manager.ensureDurableAppOnPort(dark));
    }
    ensureBundlePool() { this.assertOpen(); return this.services.ensureBundlePool(); }
    ensureFacetManager() { this.assertOpen(); return this.services.ensureFacetManager(); }
    ensureNpmInstaller() { this.assertOpen(); return this.services.ensureNpmInstaller(); }
    ensureGlobalPrefixDirs(prefix, cred) { return this.services.ensureGlobalPrefixDirs(prefix, cred); }
    _ensureChildProcessManager() { this.assertOpen(); return this.services._ensureChildProcessManager(); }
    _ensureWebSocketRelay() { this.assertOpen(); return this.services._ensureWebSocketRelay(); }
    _setCpRegistry(registry) {
        if (registry !== this._cpRegistry)
            throw new Error('Nimbus runtime cannot replace the workspace registry');
    }
    _notifySession(line) { this.terminal.write(`${line}\r\n`); }
    /**
     * What this object serves a sibling coordinator; work owns observation,
     * never an alarm on the embedder's lifecycle.
     */
    get peerHost() {
        return this._peerHost ??= rpc.peerHostFor(this.ctx, this.env);
    }
    _scheduleLaunchTurn(notBefore = Date.now()) {
        const pending = this.schedule('resident-launch', Math.max(Date.now(), notBefore));
        this.options.lifecycle.waitUntil(pending);
        return pending;
    }
    noteClientActivity() {
        noteResidentClient(this, this.keepaliveCycle);
    }
    /** The embedder's lifecycle schedules the cycle; the runtime's own host activity is what it owns. */
    get keepaliveCycle() {
        return {
            schedule: (at) => {
                const pending = this.schedule('resident-keepalive', at);
                this.options.lifecycle.waitUntil(pending);
                return pending.then(() => true, () => false);
            },
            observe: () => hostActivity(this.ctx).acquire(),
        };
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
    /** What host stubs call: an answer leaving the runtime, counted (answerSupervisorOp). */
    supervisorOp(envelope) {
        return answerSupervisorOp((served) => this.serveSupervisorOp(served), envelope);
    }
    serveSupervisorOp(envelope) {
        this.assertOpen();
        // A process that can stop is answered through its journal by the
        // canonical handler's logical-answer seam (supervisor-op.ts observe).
        return this.supervisorOps().dispatch(envelope);
    }
    supervisorBridge(pid) { return this.supervisorOps().bridge(pid); }
    supervisorRewindBridge(pid) { return this.supervisorOps().rewind(pid); }
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
    }
    scheduleJanitor(at) {
        const pending = this.schedule('log-janitor', at);
        this.options.lifecycle.waitUntil(pending);
        return pending.then(() => true, () => false);
    }
    async onScheduled(task) {
        if (this._w1SessionDestroyed)
            return;
        if (task === 'resident-launch') {
            await this.ensureFacetManager().pumpLaunches();
        }
        else if (task === 'resident-keepalive') {
            const next = residentKeepaliveFired(this, Date.now());
            if (next !== null && !(await this.keepaliveCycle.schedule(next)))
                endResidentKeepalive(this);
        }
        else if (task === 'log-flush') {
            this.flushScheduled = false;
            this.processes.flushLogs();
        }
        else if (task === 'hosting-watch') {
            // Consume a scheduler entry left by the old polling watch, without rearming it.
            return;
        }
        else {
            const next = logJanitorFired(this);
            if (next !== null && !(await this.scheduleJanitor(next)) && this._w1JanitorAt === next)
                this._w1JanitorAt = null;
        }
    }
    async attachTerminal(ws, resume = 'reconnect', selection = {}) {
        await this.ensureRuntimeReady();
        if (selection.terminal)
            return this.terminals.attach(selection.terminal, ws, resume);
        if (this.terminal.ws === ws)
            return;
        this.terminal.attach(ws);
        if (resume === 'reconnect')
            this.terminal.replay(loadScrollback(this.ctx));
        // Said once, above the prompt, which is painted again below them.
        if (this.recoveryNotice) {
            this.shell.writeNotice('[Runtime resumed; files and shell settings restored. Previous interpreter state was not retained.]\r\n');
            this.recoveryNotice = false;
        }
        if (this.legacyNotice) {
            this.shell.writeNotice(`[${this.legacyNotice}]\r\n`);
            this.legacyNotice = null;
        }
        this.shell.resumePrompt();
        this.terminal.flushNow();
        ws.send(JSON.stringify({ type: 'ready' }));
    }
    async terminalFrame(ws, frame, selection = {}) {
        const text = typeof frame === 'string' ? frame : new TextDecoder().decode(frame);
        const input = InputFrame.parse(JSON.parse(text));
        if (selection.terminal) {
            await this.ensureRuntimeReady();
            const { running } = await this.terminals.input(selection.terminal, ws, input);
            if (running)
                this.options.lifecycle.waitUntil(running.catch((error) => console.error('[nimbus] terminal input failed:', errorText(error))));
            return;
        }
        await this.attachTerminal(ws, 'wake');
        const completion = this.terminal.handleMessage(input);
        if (completion) {
            this.options.lifecycle.waitUntil(completion.catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                console.error('[nimbus] terminal input failed:', message);
                this.terminal.writeln(`terminal input failed: ${message}`);
            }).finally(() => {
                persistShellState(this.ctx, { cwd: this.shell.getCwd(), env: this.shell.getEnv(), vars: this.shell.getVariableAttributes() });
            }));
        }
        persistShellState(this.ctx, { cwd: this.shell.getCwd(), env: this.shell.getEnv(), vars: this.shell.getVariableAttributes() });
    }
    terminalClose(ws, selection = {}) {
        if (selection.terminal)
            return this.terminals.detach(selection.terminal, ws);
        if (this.terminal.ws !== ws)
            return;
        this.terminal.flushNow();
        persistShellState(this.ctx, { cwd: this.shell.getCwd(), env: this.shell.getEnv(), vars: this.shell.getVariableAttributes() });
        this.terminal.detach();
        this.processes.flushLogs();
    }
    /** `pid` ended as a hang-up ends it: by its runtime when it has one, else here. */
    hangUp(pid) {
        if (!this.facetManager?.kill(pid, 'HUP', signalAbortReason('HUP')))
            this.processes.kill(pid, exitCodeForSignal('HUP'), signalAbortReason('HUP'));
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
        return Object.assign(new ProcessView(lease.fs), { as: (next) => this.files(next) });
    }
    close() {
        this.closing ??= Promise.resolve().then(async () => {
            // The cycle is over with the runtime; the alarm that would end it is cancelled below.
            endResidentKeepalive(this);
            const failures = [];
            const clean = async (action) => {
                try {
                    await action();
                }
                catch (error) {
                    failures.push(error instanceof Error ? error : new Error(String(error)));
                }
            };
            await clean(() => this.terminals.dispose());
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
        attachTerminal: (ws, selection) => owner.attachTerminal(ws, 'reconnect', selection),
        terminalFrame: (ws, message, selection) => owner.terminalFrame(ws, message, selection),
        listTerminals: operations.rpcListTerminals.bind(null, owner),
        closeTerminal: operations.rpcCloseTerminal.bind(null, owner),
    });
    return {
        workspace: options.workspace,
        terminal: owner.terminal,
        files: owner.files(owner.processes.cred(owner.shellProcessPid)),
        runtimes: owner.runtimeManager,
        ...client,
        supervisorOp: (envelope) => owner.supervisorOp(envelope),
        /** Private native-fetch legs for an embedder's service-binding fetch entrypoint. */
        hostedFetch: (request) => {
            if (isHostedResidency(request))
                return owner.peerHost.reside(request);
            if (isHostedWatch(request))
                return owner.peerHost.watch(request);
            if (isHostedWebSocket(request))
                return owner.peerHost.routeWebSocket(request);
            return Promise.resolve(null);
        },
        /** The SDK's session surface for `Nimbus.fromSession`, optionally bound to one shell and identity. */
        session: (scope = {}) => {
            owner.assertOpen();
            return new HostedSession(owner, scope);
        },
        onScheduled: (task) => owner.onScheduled(task),
        terminalClose: (ws, selection) => owner.terminalClose(ws, selection),
        close: () => owner.close(),
    };
}
