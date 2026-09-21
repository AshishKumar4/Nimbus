import type { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { CommandRegistry } from '@nimbus-sh/core/substrate/lifo/commands/registry.js';
import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import type { ProcessLogReadOptions } from '@nimbus-sh/core/runtime/process-logs.js';
import type { NimbusHostFilesystemLease, VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { requireVfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SandboxFsImpl } from '@nimbus-sh/core/substrate/lifo/sandbox/SandboxFs.js';
import { ExecutionFs } from '@nimbus-sh/core/shell/execution-fs.js';
import type { SandboxFs } from '@nimbus-sh/core/substrate/lifo/sandbox/types.js';
import { SUPERVISOR_OP_ROUTES, createSupervisorBridgeStore, type SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import type { FacetProcessManager } from '../facets/process.js';
import type { ComposedFacetManager, FacetManagerHostHooks } from '../facets/compose.js';
import type { EsbuildService } from '@nimbus-sh/core/runtime/esbuild-service.js';
import type { EsbuildBundlePool } from '../facets/esbuild-bundle-pool.js';
import type { NpmInstaller } from '../npm/installer.js';
import type { NimbusWrangler } from '../wrangler/nimbus-wrangler.js';
import type { CirrusReal } from '../facets/cirrus-real.js';
import type { ViteDevServer } from '../facets/vite-dev-server.js';
import type { ServiceStub } from '@nimbus-sh/fabric/vendor/types.js';
import type { WebSocketRelay } from '../session/ws-relay.js';
import { WebSocketTerminal } from '../facets/ws-terminal.js';
import { buildSessionSupervisorOps, type SessionSupervisorOps } from '../session/supervisor-op.js';
import { installLogPersistence } from '../session/hibernation.js';
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

const HostedTask = z.enum(['resident-launch', 'log-flush', 'log-janitor']);
export type HostedRuntimeTask = z.infer<typeof HostedTask>;

export interface HostedRuntimeLifecycle {
  waitUntil(task: Promise<void>): void;
  schedule(reason: HostedRuntimeTask, at: number): Promise<void>;
  cancel(reason: HostedRuntimeTask): Promise<void>;
}

export interface HostedRuntimeOptions {
  workspace: NimbusWorkspace;
  ctx: DurableObjectState;
  env: services.HostedRuntimeEnv;
  ports: PortRegistry;
  lifecycle: HostedRuntimeLifecycle;
  resolveWorkerLaunch?: FacetManagerHostHooks['resolveWorkerLaunch'];
  basePath?: string;
  origin?: string;
}

export interface RuntimeFiles extends SandboxFs {
  as(cred: VfsCred): RuntimeFiles;
}

const InputFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({ type: z.literal('resize'), cols: z.number().int().positive(), rows: z.number().int().positive() }),
]);

class RuntimeOwner {
  readonly terminal: WebSocketTerminal;
  readonly _cpRegistry: CommandRegistry;
  readonly _programmaticShellQueues = new Map<string, Promise<void>>();
  readonly _hostedProcesses = new Map<string, rpc.HostedProcessRecord>();
  readonly _hostedProcessWaiters = new Map<string, Set<(record: rpc.HostedProcessRecord) => void>>();
  readonly _cirrusHmrWsClients = new Map<WebSocket, string>();
  private closing: Promise<void> | null = null;
  _w9PersistWired = false;
  _w9SchemaInit = false;
  _viteShimPid: number | null = null;
  _viteShimPort: number | null = null;
  wranglerAliasBannerShown = false;
  facetManagerComposed: ComposedFacetManager | null = null;
  facetProcessManager: FacetProcessManager | null = null;
  esbuildService: EsbuildService | null = null;
  bundlePool: EsbuildBundlePool | null = null;
  npmInstaller: NpmInstaller | null = null;
  fetchProxyEntrypoint: ServiceStub | null = null;
  viteDevServer: ViteDevServer | null = null;
  cirrusReal: CirrusReal | null = null;
  nimbusWrangler: NimbusWrangler | null = null;
  webSocketRelay: WebSocketRelay | null = null;
  private readyPromise: Promise<void> | null = null;
  private supervisor: SessionSupervisorOps | null = null;
  private flushScheduled = false;
  private janitorScheduled = false;
  private recoveryNotice = false;
  private readonly scheduling = new Set<Promise<void>>();
  private readonly fileLeases = new Map<string, NimbusHostFilesystemLease>();
  private readonly services: ReturnType<typeof services.bindRuntimeServices>;

  constructor(readonly options: HostedRuntimeOptions) {
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

  assertOpen(): void {
    if (this._w1SessionDestroyed) throw new Error('Nimbus runtime is closed');
  }

  ensureRuntimeReady(): Promise<void> {
    this.assertOpen();
    this.readyPromise ??= (async () => {
      const saved = loadShellState(this.ctx);
      this.recoveryNotice = saved.hasPersistedState;
      if (saved.cwd) this.shell.setCwd(saved.cwd);
      if (saved.env) Object.assign(this.shell.getEnv(), saved.env);
      await registerHostedCommands(this, this.options.workspace);
      await this.options.workspace.start();
    })();
    return this.readyPromise;
  }

  ensureSqliteFs() { return this.sqliteFs; }
  routeLoopback(port: number, request: Request) { return routeRuntimeLoopback(this.portRegistry, port, request); }
  ensureBundlePool() { this.assertOpen(); return this.services.ensureBundlePool(); }
  ensureFacetManager() { this.assertOpen(); return this.services.ensureFacetManager(); }
  ensureFetchProxy(log?: (message: string) => void) { return this.services.ensureFetchProxy(log); }
  buildFetchFn(log?: (message: string) => void) { return this.services.buildFetchFn(log); }
  ensureNpmInstaller(onProgress?: (message: string) => void) { this.assertOpen(); return this.services.ensureNpmInstaller(onProgress); }
  ensureGlobalPrefixDirs(prefix: string) { return this.services.ensureGlobalPrefixDirs(prefix); }
  _envFlagDefaultOn(name: string) { return this.services._envFlagDefaultOn(name); }
  _ensureFacetProcessManager() { this.assertOpen(); return this.services._ensureFacetProcessManager(); }
  _ensureWebSocketRelay() { this.assertOpen(); return this.services._ensureWebSocketRelay(); }
  _setCpRegistry(registry: CommandRegistry) {
    if (registry !== this._cpRegistry) throw new Error('Nimbus runtime cannot replace the workspace registry');
  }
  _notifySession(line: string) { this.terminal.write(`${line}\r\n`); }
  _scheduleLaunchTurn(notBefore = Date.now()): Promise<void> {
    const pending = this.schedule('resident-launch', Math.max(Date.now(), notBefore));
    this.options.lifecycle.waitUntil(pending);
    return pending;
  }

  private schedule(reason: HostedRuntimeTask, at: number): Promise<void> {
    if (this._w1SessionDestroyed) return Promise.reject(new Error('Nimbus runtime is closed'));
    // Registered before the deferred call runs, so close() waits for a turn
    // issued in the same tick; the second closed check keeps that turn from
    // arming an alarm the shutdown has already decided against.
    const pending = Promise.resolve().then(() => {
      if (this._w1SessionDestroyed) return;
      return this.options.lifecycle.schedule(reason, at);
    });
    this.scheduling.add(pending);
    void pending.then(() => this.scheduling.delete(pending), () => this.scheduling.delete(pending));
    return pending;
  }
  _reportExternalExit(pid: number, code: number, reason: string) { return rpc._reportExternalExit(this, pid, code, reason); }
  _emitExitDump(pid: number, code: number) { return rpc._emitExitDump(this, pid, code); }
  _emitShellExecDone(pid: number, command: string, code: number, duration: number) { return rpc._emitShellExecDone(this, pid, command, code, duration); }
  _rpcStdout(pid: number, data: Uint8Array) { return rpc._rpcStdout(this, pid, data); }
  _rpcStderr(pid: number, data: Uint8Array) { return rpc._rpcStderr(this, pid, data); }

  private supervisorOps(): SessionSupervisorOps {
    this.supervisor ??= buildSessionSupervisorOps(this, createSupervisorBridgeStore({
      vfs: this.options.workspace.vfs,
      filesystem: this.options.workspace.filesystem,
      processes: this.processes,
    }), Object.fromEntries(
      Object.values(SUPERVISOR_OP_ROUTES).map(({ method }) => {
        const handler = Reflect.get(rpc, method);
        if (typeof handler !== 'function') throw new Error(`Missing Nimbus supervisor implementation: ${method}`);
        return [method, (...args: NonNullable<SupervisorOpEnvelope['args']>) => Reflect.apply(handler, undefined, [this, ...args])];
      }),
    ));
    return this.supervisor;
  }

  supervisorOp(envelope: SupervisorOpEnvelope) {
    this.assertOpen();
    return this.supervisorOps().dispatch(envelope);
  }
  supervisorBridge(pid?: number) { return this.supervisorOps().bridge(pid); }
  supervisorForgetBridge(pid: number) { this.supervisorOps().forget(pid); }

  private scheduleLogs(): void {
    if (this._w1SessionDestroyed) return;
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      this.options.lifecycle.waitUntil(this.schedule('log-flush', Date.now() + 250).catch((error: unknown) => {
        this.flushScheduled = false;
        throw error;
      }));
    }
    if (!this.janitorScheduled) {
      this.janitorScheduled = true;
      this.options.lifecycle.waitUntil(this.schedule('log-janitor', Date.now() + 60_000).catch((error: unknown) => {
        this.janitorScheduled = false;
        throw error;
      }));
    }
  }

  async onScheduled(task: HostedRuntimeTask): Promise<void> {
    if (this._w1SessionDestroyed) return;
    if (task === 'resident-launch') {
      await this.ensureFacetManager().pumpLaunches();
    } else if (task === 'log-flush') {
      this.flushScheduled = false;
      this.processes.flushLogs();
    } else {
      this.janitorScheduled = false;
      this.processes.dropLogsOlderThan(undefined, (pid) => !this.processes.get(pid));
      if (this.processes.stats.running > 0 || this.processes.logStats.totalPids > 0) this.scheduleLogs();
    }
  }

  async attachTerminal(ws: WebSocket, resume: 'reconnect' | 'wake' = 'reconnect'): Promise<void> {
    await this.ensureRuntimeReady();
    if (this.terminal.ws === ws) return;
    this.terminal.attach(ws);
    if (resume === 'reconnect') this.terminal.write(loadScrollback(this.ctx));
    if (this.recoveryNotice) {
      this.terminal.write('\r\n[Runtime resumed; files and shell settings restored. Previous interpreter state was not retained.]\r\n');
      this.recoveryNotice = false;
    }
    if (!this.shell.running) this.shell.printPrompt();
    this.terminal.flushNow();
    ws.send(JSON.stringify({ type: 'ready' }));
  }

  async terminalFrame(ws: WebSocket, frame: string | ArrayBuffer): Promise<void> {
    await this.attachTerminal(ws, 'wake');
    const text = typeof frame === 'string' ? frame : new TextDecoder().decode(frame);
    const input = InputFrame.parse(JSON.parse(text));
    this.terminal.handleMessage(input);
    persistShellState(this.ctx, { cwd: this.shell.getCwd(), env: this.shell.getEnv() });
  }

  terminalClose(ws: WebSocket): void {
    if (this.terminal.ws !== ws) return;
    this.terminal.flushNow();
    persistShellState(this.ctx, { cwd: this.shell.getCwd(), env: this.shell.getEnv() });
    this.terminal.detach();
    this.processes.flushLogs();
  }

  files(cred: VfsCred): RuntimeFiles {
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
    return Object.assign(view, { as: (next: VfsCred) => this.files(next) });
  }

  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      const failures: Error[] = [];
      const clean = async (action: () => void | Promise<void>) => {
        try { await action(); }
        catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
      };
      await clean(() => this.terminal.disposeRepl());
      await clean(() => this.terminal.sendData('\x03'));
      for (const process of this.processes.getAll()) {
        await clean(() => this.webSocketRelay?.closeForPid(process.pid));
        if (process.state !== 'running') continue;
        await clean(() => { if (!this.facetManager?.kill(process.pid)) this.processes.kill(process.pid); });
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
      for (const lease of this.fileLeases.values()) await clean(() => lease.dispose());
      this.fileLeases.clear();
      await clean(() => this.options.workspace.close());
      for (const task of HostedTask.options) await clean(() => this.options.lifecycle.cancel(task));
      if (failures.length > 0) throw new AggregateError(failures, 'Nimbus runtime cleanup failed');
    });
    return this.closing;
  }
}

export async function composeHostedRuntime(options: HostedRuntimeOptions) {
  const owner = new RuntimeOwner(options);
  await owner.ensureRuntimeReady();
  return {
    workspace: options.workspace,
    terminal: owner.terminal,
    files: owner.files(owner.processes.cred(owner.shellProcessPid)),
    runtimes: owner.runtimeManager,
    facets: () => owner.ensureFacetManager(),
    ready: operations.ensureProgrammaticReady.bind(null, owner),
    exec: operations.rpcExec.bind(null, owner),
    runCode: operations.rpcRunCode.bind(null, owner),
    startProcess: operations.rpcStartProcess.bind(null, owner),
    listProcesses: operations.rpcListProcesses.bind(null, owner),
    killProcess: operations.rpcKillProcess.bind(null, owner),
    writeProcessInput: operations.rpcWriteProcessInput.bind(null, owner),
    endProcessInput: operations.rpcEndProcessInput.bind(null, owner),
    resizeProcess: operations.rpcResizeProcess.bind(null, owner),
    signalProcess: operations.rpcSignalProcess.bind(null, owner),
    processLogs: (pid: number, options?: ProcessLogReadOptions) => operations.rpcProcessLogs(owner, pid, options),
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
    routeCapabilityPort: async (...args: Parameters<ComposedFacetManager['apps']['routeCapabilityPort']>) => {
      await operations.ensureProgrammaticReady(owner);
      return owner.ensureFacetManager().apps.routeCapabilityPort(...args);
    },
    supervisorOp: (envelope: SupervisorOpEnvelope) => owner.supervisorOp(envelope),
    onScheduled: (task: HostedRuntimeTask) => owner.onScheduled(task),
    attachTerminal: (ws: WebSocket) => owner.attachTerminal(ws),
    terminalFrame: (ws: WebSocket, message: string | ArrayBuffer) => owner.terminalFrame(ws, message),
    terminalClose: (ws: WebSocket) => owner.terminalClose(ws),
    close: () => owner.close(),
  };
}

export type HostedRuntime = Awaited<ReturnType<typeof composeHostedRuntime>>;
