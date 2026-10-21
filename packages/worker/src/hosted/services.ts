import { signalAbortReason } from '@nimbus-sh/core/substrate/lifo/shell/signals.js';
import type { WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import { composeFacetManager, type ComposedFacetManager, type FacetManagerHostHooks } from "../facets/compose.js";
import type { ProcessEnvHooks } from '../session/process-env.js';
import { normalizeChildCommand, shellChildRunner, textBytes, type ChildProcessHost } from "@nimbus-sh/core/runtime/child-process-manager.js";
import { delegatedChildRunner, runChildCommand, runChildShell } from '@nimbus-sh/core/workspace/child-process-runner.js';
import {
  bindProcessTable,
  isDynamicWorkerDeadlock,
  issueProcessNews,
  withLaunchAdmission,
} from "@nimbus-sh/fabric/budgets.js";
import { CRED_KERNEL, CRED_SESSION_USER, type NimbusFilesystemAuthority, type VfsCred } from "@nimbus-sh/core/runtime/os-contracts.js";
import { ProcessFiles, ProcessView, X_OK } from "@nimbus-sh/core/runtime/process-files.js";
import { isRuntimeInstallHint, resolveChildCommand } from '@nimbus-sh/core/shell/exec-dispatch.js';

import { resolveContext } from "@nimbus-sh/core/substrate/lifo/commands/registry.js";
import { errorText } from "@nimbus-sh/core/_shared/error-text.js";
import { PrebundlePool } from "../facets/prebundle-pool.js";
import { supervisorEsbuildService } from "../facets/esbuild-transform.js";
import type { NpmInstaller } from "../npm/installer.js";
import { notifyTerminalEvent } from "../runtime/process-logs-api.js";
// The supervisor terminates a facet's outbound sockets so inbound frames
// arrive as supervisor replies (VFS coherence witness 3).
import { WebSocketRelay } from "../session/ws-relay.js";
import { ProcessSupervisor } from "../session/process-supervisor.js";
import type { SupervisorOpEnvelope } from "@nimbus-sh/core/workspace/supervisor-op.js";
// ── Pure helpers in ../session/helpers.ts ────────
//
// renderNoDevServerHtml, BUNDLER_BIN_PREFIXES, NIMBUS_UNSUPPORTED_BINS,
// WRANGLER_IGNORED_FLAGS{,_WITH_VALUE}, WRANGLER_UNSUPPORTED_CONFIG_FIELDS,
// filterWranglerFlags, detectUnsupportedWranglerConfig, _CP_FACET_DIRECT,
// _CP_PURE_BUILTIN, _classifyCommand, detectBundlerBin, checkNodeModulesGuard
// all live in the helpers module now.
//
// They are imported here (so call sites in this file work unchanged) and
// re-exported (so external callers importing them from
// `./nimbus-session.js` keep working — back-compat).
// Helpers needed by this class file's own logic (not just re-export).
import { _classifyCommand } from "../session/helpers.js";

import type { SessionInternal } from '../session/internal.js';
import type { RuntimeCatalogEnv } from '../runtime/runtime-catalog.js';
import type { IsolatePoolEnv } from '@nimbus-sh/fabric/isolate-pool.js';


export interface HostedRuntimeEnv extends RuntimeCatalogEnv, IsolatePoolEnv {
  ASSETS?: Fetcher;
}

export type RuntimeServiceHost = Pick<SessionInternal,
  '_cpRegistry' | '_reportExternalExit' | '_rpcStderr' | '_rpcStdout' | 'supervisorRewindBridge' | 'bundlePool' | 'ensureBundlePool' | 'ensureFacetManager' | 'ensureSqliteFs' | 'esbuildService' | 'facetManagerComposed' | 'getFilesystemAuthority' | 'childProcessManager' | 'npmInstaller' | 'portRegistry' | 'processes' | 'restoreDevServers' | 'runtimeWorkspace' | 'shell' | 'sqliteFs' | 'terminal'
> & { webSocketRelay: WebSocketRelay | null };

export interface RuntimeServiceContext {
  readonly ctx: DurableObjectState;
  readonly env: HostedRuntimeEnv;
  notify(line: string): void;
  requestLaunchTurn(notBefore?: number): Promise<void>;
  resolveWorkerLaunch?: FacetManagerHostHooks['resolveWorkerLaunch'];
  /** Who gives a relaunched process its environment back, and where this host keeps it if it does (session/process-env.ts). */
  readonly processEnv: ProcessEnvHooks;
  /**
   * Hold the host actor in memory while a resident process runs:
   * `armResidentKeepalive` (session/hibernation.ts) bound to the host's own
   * scheduler — the fabric timer mux for the session DO, the embedder's
   * lifecycle for a hosted runtime.
   */
  armResidentKeepalive: () => void;
  /** The host's own authority: a session has exactly one, and this is it. */
  filesystem: () => NimbusFilesystemAuthority;
  /** The workspace's network (`workspace.network`): its egress, when the host supplied one. */
  network: () => WorkspaceNetwork;
  /** The host's own answer to an envelope: what its one-shots' supervisors call (ProcessSupervisor). */
  supervisorOp: (envelope: SupervisorOpEnvelope) => Promise<unknown>;
}

export function ensureBundlePool(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext): PrebundlePool {
    if (!self.bundlePool) self.bundlePool = new PrebundlePool(runtimeContext.env, runtimeContext.ctx);
    return self.bundlePool;
  }

export function ensureFacetManager(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext): ComposedFacetManager {
    if (!self.facetManagerComposed) {
      // The manager is composed over the filesystem, so the filesystem comes
      // first. Cheap and idempotent; every caller already stood it up or is
      // about to.
      self.ensureSqliteFs();
      const filesystem = runtimeContext.filesystem();
      // The manager reaches the disk behind the authority (boot images, the
      // launch journal), so a host that credentials something other than this
      // session's SQLite filesystem cannot compose one.
      if (!(filesystem instanceof ProcessFiles)) {
        throw new Error('Nimbus: the facet manager needs the session ProcessFiles, not a foreign filesystem authority');
      }
      self.facetManagerComposed = composeFacetManager({
        ctx: runtimeContext.ctx,
        env: runtimeContext.env,
        processes: self.processes,
        portRegistry: self.portRegistry,
        vfs: filesystem.engine,
        filesystem,
        network: runtimeContext.network,
        restoreDevServers: () => self.restoreDevServers(),
        supervise: (props) => new ProcessSupervisor(props, runtimeContext.env, runtimeContext.supervisorOp),
        ...(self.esbuildService ? { esbuild: self.esbuildService } : {}),
        hooks: {
          onExternalExit: (pid, code, reason) => self._reportExternalExit(pid, code, reason),
          deliverOutput: (pid, stream, bytes) => (stream === 'stdout' ? self._rpcStdout(pid, bytes) : self._rpcStderr(pid, bytes)),
          rewindProcessFiles: (pid) => self.supervisorRewindBridge(pid),

          requestLaunchTurn: (notBefore) => runtimeContext.requestLaunchTurn(notBefore),
          resolveWorkerLaunch: runtimeContext.resolveWorkerLaunch,
          ...runtimeContext.processEnv,
          notify: (line) => runtimeContext.notify(line),
          onSpawn: (pid, command, longRunning) => {
            const attachedTty = self.processes.get(pid)?.attachedTty === true;
            if (longRunning) {
              try { self.processes.openInput(pid); } catch {}
              // The one arming site: the journal's re-drive path comes back
              // through this same hook. See ensureResidentKeepalive.
              runtimeContext.armResidentKeepalive();
            }
            // Only surface long-running / user-visible spawns to keep
            // the terminal uncluttered. Short `node <file>` evals also
            // get a line because users want the pid for `logs`/`kill`.
            if (!self.terminal) return;
            const label = longRunning ? 'started (long-running)' : 'started';
            self.terminal.write(
              `\x1b[2m[facet ${label}: pid=${pid} cmd="${command}"]\x1b[0m\r\n`,
            );
            // Structured event so the tabs UI can auto-open a log tab
            // for long-running processes (vite, wrangler dev, etc.).
            notifyTerminalEvent(self.terminal, {
              type: 'spawn', pid, command, longRunning, attachedTty,
            });
          },
        },
      });
    }
    const composed = self.facetManagerComposed;
    // The session may create its esbuild after the manager exists, so it is
    // offered on every call. Either one transforms in the session's transform facet.
    if (self.esbuildService) {
      composed.manager.setEsbuildService(self.esbuildService);
    }
    return composed;
  }

export function _ensureWebSocketRelay(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext): WebSocketRelay {
    if (!self.webSocketRelay) self.webSocketRelay = new WebSocketRelay(runtimeContext.network);
    return self.webSocketRelay;
  }

export function createChildProcessHost(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext): ChildProcessHost {
  return {
    async resolve(request, origin) {
      const workspace = self.runtimeWorkspace;
      if (!workspace) return null;
      bindProcessTable(runtimeContext.ctx, self.processes);
      const delegating = delegatedChildRunner(workspace, request, origin);
      const delegated = delegating instanceof Promise ? await delegating : delegating;
      if (delegated) return delegated;
      const view = new ProcessView(workspace.filesystem.bind({ pid: origin.pid, cred: self.processes.cred(origin.pid) }));
      const shell = shellChildRunner(request, view, (child, line) => runChildShell(workspace, child, line));
      if (shell) return shell;
      const registry = self._cpRegistry;
      if (!registry) return null;
      const name = normalizeChildCommand(request.command);
      if (name.includes('/')) await view.access(name.startsWith('/') ? name : `${origin.cwd}/${name}`, X_OK);
      const from = resolveContext(origin.cwd, origin.env, view);
      const registered = await registry.resolve(name, { ...from, search: false });
      const direct = registered !== undefined && !isRuntimeInstallHint(registered);
      const program = direct ? registered : await resolveChildCommand(registry, name, from, view);
      if (!program) return null;
      const facet = !direct || _classifyCommand(name)?.kind === 'facet-direct';
      return {
        async run(child) {
          if (!workspace.children.isRunning(child.pid)) return 1;
          const env = facet ? { ...child.env, NIMBUS_CP_CHILD_PID: String(child.pid) } : child.env;
          const vfs = new ProcessView(workspace.filesystem.bind({ pid: child.pid, cred: self.processes.cred(child.pid) }));
          const command = await registry.resolve(name, resolveContext(child.cwd, env, vfs));
          if (!command) {
            child.output.onStderr(textBytes(`${child.command}: command not found\n`));
            return 127;
          }
          if (!facet) return runChildCommand(workspace, child, command);
          return runChildCommand(workspace, { ...child, env }, command, async context => {
            let started = false;
            try {
              const code = await withLaunchAdmission(runtimeContext.ctx, { pid: child.pid }, context.signal,
                () => { started = true; child.onStarted(); return command(context); });
              const entry = self.processes.get(child.pid);
              return entry?.longRunning === true && entry.state === 'running'
                ? await self.processes.whenEnded(child.pid) : typeof code === 'number' ? code : 0;
            } catch (error) {
              if (isDynamicWorkerDeadlock(error)) {
                if (!started) return { code: error.code, errno: error.errno };
                child.output.onStderr(textBytes(`facet error: ${error.code}: ${errorText(error)}\n`));
                return 1;
              }
              if (context.signal.aborted) return 130;
              throw error;
            }
          });
        },
      };
    },
    terminate: (pid, signal) => self.ensureFacetManager().manager.kill(pid, signal, signalAbortReason(signal.replace(/^SIG/, ''))),
    issueNews: parent => issueProcessNews(runtimeContext.ctx, parent),
  };
}

export function _ensureChildProcessManager(self: RuntimeServiceHost) {
  const workspace = self.runtimeWorkspace;
  if (!workspace) throw new Error('Nimbus runtime is not initialized');
  if (self.childProcessManager !== workspace.children) {
    self.ensureSqliteFs();
    self.ensureFacetManager();
    self.childProcessManager = workspace.children;
  }
  return workspace.children;
}

/**
 * The session's one NpmInstaller: every install in the session goes through
 * it, so what each is staging (its staging directories in /tmp, its copies
 * beside a mounted package) is known to every other's sweep. Each install
 * passes its own progress and npm log sinks.
 */
export async function ensureNpmInstaller(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext): Promise<NpmInstaller> {
    if (self.npmInstaller) return self.npmInstaller;
    self.ensureSqliteFs();
    if (!self.esbuildService) {
      if (!self.sqliteFs) throw new Error('Session VFS is not initialized');
      self.esbuildService = supervisorEsbuildService(runtimeContext.ctx, runtimeContext.env, self.getFilesystemAuthority().namespaceFs(CRED_SESSION_USER));
    }
    // Lazy-load the installer (+ its ~216 KB resolver/facet/loader-pool
    // subgraph) on first npm use so it stays out of the cold script-eval
    // graph. The install command paths that call this are already async.
    const { NpmInstaller } = await import('../npm/installer.js');
    // An install that asked while this one loaded it may have made it.
    if (self.npmInstaller) return self.npmInstaller;
    self.npmInstaller = new NpmInstaller(
      self.getFilesystemAuthority(),
      runtimeContext.ctx.storage.sql,
      {
        esbuild: self.esbuildService,
        bundlePool: self.ensureBundlePool(),
        ctx: runtimeContext.ctx,
        env: runtimeContext.env,
        network: runtimeContext.network(),
      },
    );
    return self.npmInstaller;
  }

export function ensureGlobalPrefixDirs(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext, prefix: string, cred: Readonly<VfsCred>): void {
    // Made as the installing process, which then installs into them.
    const fs = self.sqliteFs!.as(cred);
    const dirs = [
      prefix,
      `${prefix}/lib`,
      `${prefix}/lib/node_modules`,
      `${prefix}/bin`,
    ];
    for (const dir of dirs) {
      if (!fs.exists(dir)) fs.mkdir(dir, { recursive: true });
    }
  }

export function bindRuntimeServices(host: RuntimeServiceHost, context: RuntimeServiceContext) {
  const childProcessHost = createChildProcessHost(host, context);
  if (host.runtimeWorkspace) {
    host.runtimeWorkspace.children.bindHost(childProcessHost);
    host.childProcessManager = host.runtimeWorkspace.children;
  }
  return {
    childProcessHost,
    ensureBundlePool: ensureBundlePool.bind(null, host, context),
    ensureFacetManager: ensureFacetManager.bind(null, host, context),
    _ensureWebSocketRelay: _ensureWebSocketRelay.bind(null, host, context),
    _ensureChildProcessManager: _ensureChildProcessManager.bind(null, host),
    ensureNpmInstaller: ensureNpmInstaller.bind(null, host, context),
    ensureGlobalPrefixDirs: ensureGlobalPrefixDirs.bind(null, host, context),
  };
}
