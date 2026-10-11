import type { WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import { type ComposedFacetManager, type FacetManagerHostHooks } from "../facets/compose.js";
import { type NimbusFilesystemAuthority } from "@nimbus-sh/core/runtime/os-contracts.js";
import { PrebundlePool } from "../facets/prebundle-pool.js";
import type { NpmInstaller } from "../npm/installer.js";
import { WebSocketRelay } from "../session/ws-relay.js";
import type { SupervisorOpEnvelope } from "@nimbus-sh/core/workspace/supervisor-op.js";
import type { SessionInternal } from '../session/internal.js';
import type { RuntimeCatalogEnv } from '../runtime/runtime-catalog.js';
import type { IsolatePoolEnv } from '@nimbus-sh/fabric/isolate-pool.js';
export interface HostedRuntimeEnv extends RuntimeCatalogEnv, IsolatePoolEnv {
    ASSETS?: Fetcher;
}
export type RuntimeServiceHost = Pick<SessionInternal, '_cpRegistry' | '_reportExternalExit' | '_rpcStderr' | '_rpcStdout' | 'supervisorRewindBridge' | 'bundlePool' | 'ensureBundlePool' | 'ensureFacetManager' | 'ensureSqliteFs' | 'esbuildService' | 'facetManagerComposed' | 'getFilesystemAuthority' | 'facetProcessManager' | 'npmInstaller' | 'portRegistry' | 'processes' | 'runtimeWorkspace' | 'shell' | 'sqliteFs' | 'terminal'> & {
    webSocketRelay: WebSocketRelay | null;
};
export interface RuntimeServiceContext {
    readonly ctx: DurableObjectState;
    readonly env: HostedRuntimeEnv;
    notify(line: string): void;
    requestLaunchTurn(notBefore?: number): Promise<void>;
    resolveWorkerLaunch?: FacetManagerHostHooks['resolveWorkerLaunch'];
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
export declare function ensureBundlePool(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext): PrebundlePool;
export declare function ensureFacetManager(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext): ComposedFacetManager;
export declare function _ensureWebSocketRelay(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext): WebSocketRelay;
export declare function _ensureFacetProcessManager(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext): any;
export declare function ensureNpmInstaller(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext, onProgress?: (msg: string) => void): Promise<NpmInstaller>;
export declare function ensureGlobalPrefixDirs(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext, prefix: string): void;
export declare function bindRuntimeServices(host: RuntimeServiceHost, context: RuntimeServiceContext): {
    ensureBundlePool: () => PrebundlePool;
    ensureFacetManager: () => ComposedFacetManager;
    _ensureWebSocketRelay: () => WebSocketRelay;
    _ensureFacetProcessManager: () => any;
    ensureNpmInstaller: (onProgress?: ((msg: string) => void) | undefined) => Promise<NpmInstaller>;
    ensureGlobalPrefixDirs: (prefix: string) => void;
};
//# sourceMappingURL=services.d.ts.map