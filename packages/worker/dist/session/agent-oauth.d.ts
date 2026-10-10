export interface NimbusAgentOAuthCookie {
    mode: 'oauth';
    accessToken: string;
    refreshToken?: string;
    tokenType: string;
    expiresAt: number | null;
    connectedAt: number;
    accountId: string | null;
    sessionId: string;
    tenantSegment: string;
}
export declare const NIMBUS_AGENT_AUTH_COOKIE = "nimbus_agent_oauth";
export declare const NIMBUS_AGENT_AUTH_COOKIE_TTL_SECONDS: number;
export declare const NIMBUS_AGENT_AUTH_COOKIE_PURPOSE = "nimbus-agent-oauth-auth";
export declare function createNimbusAgentOAuthCookie(auth: NimbusAgentOAuthCookie, secret: string, basePathOrRequest: string | Request): Promise<string>;
export declare function loadNimbusAgentOAuthFromRequest(request: Request, secret: string): Promise<NimbusAgentOAuthCookie | null>;
export declare function clearNimbusAgentOAuthCookie(basePathOrRequest: string | Request): string;
export interface NimbusAgentOAuthConfig {
    oauthClientId: string;
    oauthClientSecret: string;
    oauthScopes: string[];
    redirectUri: string;
}
/**
 * The Cloudflare OAuth client configuration for this deployment. Read here
 * rather than at each call site so the login dance and the credential-refresh
 * path can never disagree about which client they are talking to.
 */
export declare function readNimbusAgentOAuthConfig(env: Record<string, unknown>, origin: string): NimbusAgentOAuthConfig;
export declare function readNimbusAgentCookieSecret(env: Record<string, unknown>): string;
export declare function nimbusAgentAuthCookiePath(basePathOrRequest: string | Request): string;
export declare function nimbusAgentRouteContext(request: Request): {
    sessionId: string;
    tenantSegment: string;
};
export declare function isNimbusTenantSegment(value: string): boolean;
/** A var of the Worker's env, trimmed; '' when it is unset or not a string. */
export declare function envString(env: Record<string, unknown>, key: string): string;
//# sourceMappingURL=agent-oauth.d.ts.map