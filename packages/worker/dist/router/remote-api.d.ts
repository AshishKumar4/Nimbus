export type NimbusRuntimeName = 'node' | 'bun' | 'npm' | 'git' | 'python' | 'ruby' | 'clang' | 'shell' | (string & {});
export interface NimbusRuntimePolicy {
    preinstall?: string[];
    onDemand?: boolean;
    allow?: NimbusRuntimeName[];
}
export interface NimbusSandboxProfile {
    root?: string;
    runtimes?: NimbusRuntimePolicy;
    tools?: {
        namespace?: string;
        kind?: string;
    };
    preview?: {
        baseUrl?: string;
        pathStyle?: boolean;
    };
}
export interface NimbusConfig {
    endpoint?: string;
    sandboxes?: Record<string, NimbusSandboxProfile>;
}
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
export declare function handleNimbusRemoteApi(request: Request, env: any, sdk: NimbusSdkRouterConfig | undefined): Promise<Response | null>;
//# sourceMappingURL=remote-api.d.ts.map