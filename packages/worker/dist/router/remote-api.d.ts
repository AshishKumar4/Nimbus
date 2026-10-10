import { type SessionRouterRpc } from '@nimbus-sh/core/runtime/session-protocol.js';
import { type NimbusAuthEnv } from '../auth/index.js';
import { type NimbusConfig } from '@nimbus-sh/config/sandbox';
export type { NimbusConfig, NimbusSandboxProfile, NimbusRuntimePolicy, NimbusRuntimeName } from '@nimbus-sh/config/sandbox';
export interface NimbusRemoteApiConfig {
    /** Enable the remote programmatic sandbox API. */
    enabled?: boolean;
    /** Route prefix. Defaults to `/api/nimbus/v1`. */
    basePath?: string;
    /**
     * Permit unauthenticated remote calls when JWT_SECRET is absent. This is
     * intended only for private development deployments.
     */
    allowLegacy?: boolean;
    /**
     * Required token scopes. Tokens without an explicit `scopes` claim keep the
     * existing full-trust semantics.
     */
    requiredScopes?: string[];
}
export interface NimbusSdkRouterConfig {
    remote?: boolean | NimbusRemoteApiConfig;
    config?: NimbusConfig;
}
interface NimbusSessionNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): SessionRouterRpc;
}
interface NimbusRemoteEnv extends Partial<NimbusAuthEnv> {
    NIMBUS_SESSION?: NimbusSessionNamespace;
}
export declare function handleNimbusRemoteApi(request: Request, env: NimbusRemoteEnv, sdk: NimbusSdkRouterConfig | undefined): Promise<Response | null>;
/** Whether the remote API (and with it `DELETE /s/<id>/`) is served. */
export declare function remoteApiEnabled(sdk: NimbusSdkRouterConfig | undefined): boolean;
//# sourceMappingURL=remote-api.d.ts.map