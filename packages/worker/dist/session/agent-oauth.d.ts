import { z } from 'zod/v4';
export interface NimbusCloudflareAccount {
    id: string;
    name: string;
}
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
export declare const NIMBUS_CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
export declare const NIMBUS_CF_OAUTH_AUTH_URL = "https://dash.cloudflare.com/oauth2/auth";
export declare const NIMBUS_CF_OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
export declare const NIMBUS_CF_OAUTH_USERINFO_URL = "https://dash.cloudflare.com/oauth2/userinfo";
declare const CloudflareOAuthTokenResponseSchema: z.ZodObject<{
    access_token: z.ZodString;
    token_type: z.ZodOptional<z.ZodString>;
    expires_in: z.ZodOptional<z.ZodNumber>;
    refresh_token: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export type NimbusCloudflareOAuthTokenResponse = z.infer<typeof CloudflareOAuthTokenResponseSchema>;
export declare function requestNimbusCloudflareOAuthToken(config: {
    oauthClientId: string;
    oauthClientSecret?: string;
}, fields: Record<string, string>): Promise<NimbusCloudflareOAuthTokenResponse>;
export declare function fetchNimbusCloudflareUserInfo(accessToken: string): Promise<unknown>;
export declare function fetchNimbusCloudflareAccounts(accessToken: string): Promise<NimbusCloudflareAccount[]>;
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
export declare function serializeNimbusCookie(name: string, value: string, opts: {
    path: string;
    maxAge: number;
}): string;
export declare function readNimbusCookie(request: Request, name: string): string | null;
export declare function isNimbusCloudflareAccountId(value: string): boolean;
export declare function isNimbusTenantSegment(value: string): boolean;
export {};
//# sourceMappingURL=agent-oauth.d.ts.map