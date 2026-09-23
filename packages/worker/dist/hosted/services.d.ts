import { type ComposedFacetManager, type FacetManagerHostHooks } from "../facets/compose.js";
import { type NimbusFilesystemAuthority } from "@nimbus-sh/core/runtime/os-contracts.js";
import { EsbuildBundlePool } from "../facets/esbuild-bundle-pool.js";
import type { NpmInstaller } from "../npm/installer.js";
import { WebSocketRelay } from "../session/ws-relay.js";
import type { SessionInternal } from '../session/internal.js';
import type { RuntimeCatalogEnv } from '../runtime/runtime-catalog.js';
import type { IsolatePoolEnv } from '@nimbus-sh/fabric/isolate-pool.js';
export interface HostedRuntimeEnv extends RuntimeCatalogEnv, IsolatePoolEnv {
    ASSETS?: Fetcher;
}
export type RuntimeServiceHost = Pick<SessionInternal, '_cpRegistry' | '_envFlagDefaultOn' | '_reportExternalExit' | 'buildFetchFn' | 'bundlePool' | 'ensureBundlePool' | 'ensureFacetManager' | 'ensureFetchProxy' | 'ensureSqliteFs' | 'esbuildService' | 'facetManagerComposed' | 'facetProcessManager' | 'fetchProxyEntrypoint' | 'npmInstaller' | 'portRegistry' | 'processes' | 'shell' | 'sqliteFs' | 'terminal'> & {
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
}
export declare function ensureBundlePool(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext): EsbuildBundlePool;
export declare function ensureFacetManager(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext): ComposedFacetManager;
export declare function _ensureWebSocketRelay(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext): WebSocketRelay;
export declare function _ensureFacetProcessManager(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext): any;
export declare function ensureFetchProxy(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext, log?: (msg: string) => void): any | null;
export declare function buildFetchFn(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext, log?: (msg: string) => void): ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
export declare function ensureNpmInstaller(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext, onProgress?: (msg: string) => void): Promise<NpmInstaller>;
export declare function _envFlagDefaultOn(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext, name: string): boolean;
export declare function ensureGlobalPrefixDirs(self: RuntimeServiceHost, runtimeContext: RuntimeServiceContext, prefix: string): void;
export declare function bindRuntimeServices(host: RuntimeServiceHost, context: RuntimeServiceContext): {
    ensureBundlePool: () => EsbuildBundlePool;
    ensureFacetManager: () => ComposedFacetManager;
    _ensureWebSocketRelay: () => WebSocketRelay;
    _ensureFacetProcessManager: () => any;
    ensureFetchProxy: (log?: ((msg: string) => void) | undefined) => any;
    buildFetchFn: (log?: ((msg: string) => void) | undefined) => ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
    ensureNpmInstaller: (onProgress?: ((msg: string) => void) | undefined) => Promise<NpmInstaller>;
    _envFlagDefaultOn: (name: string) => boolean;
    ensureGlobalPrefixDirs: (prefix: string) => void;
};
//# sourceMappingURL=services.d.ts.map