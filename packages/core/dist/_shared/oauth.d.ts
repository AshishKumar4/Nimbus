import { z } from 'zod/v4';
export declare const NIMBUS_OAUTH_STATE_TTL_MS: number;
export declare const NIMBUS_CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
export declare const NIMBUS_CF_OAUTH_AUTH_URL = "https://dash.cloudflare.com/oauth2/auth";
export declare const NIMBUS_CF_OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
export declare const NIMBUS_CF_OAUTH_USERINFO_URL = "https://dash.cloudflare.com/oauth2/userinfo";
export interface NimbusCloudflareAccount {
    id: string;
    name: string;
}
export interface NimbusOAuthClient {
    clientId: string;
    clientSecret?: string;
}
export interface NimbusOAuthTransaction {
    v: 1;
    nonce: string;
    codeVerifier: string;
    redirectUri: string;
    createdAt: number;
    expiresAt: number;
}
export interface NimbusOAuthCredential {
    accessToken: string;
    refreshToken?: string;
    tokenType: string;
    expiresAt: number | null;
}
export interface NimbusOAuthStateCookie {
    name: string;
    purpose: string;
    secret: string;
}
export declare function beginNimbusCloudflareOAuth(config: NimbusOAuthClient & {
    redirectUri: string;
    scopes: readonly string[];
}, ttlMs?: number): Promise<{
    transaction: NimbusOAuthTransaction;
    authUrl: URL;
}>;
export declare function exchangeNimbusCloudflareOAuthCode(config: NimbusOAuthClient, transaction: Pick<NimbusOAuthTransaction, 'codeVerifier' | 'redirectUri'>, code: string): Promise<NimbusOAuthCredential>;
export declare function normalizeNimbusOAuthToken(token: NimbusCloudflareOAuthTokenResponse, now?: number): NimbusOAuthCredential;
export declare function createNimbusOAuthStateCookie(value: unknown, cookie: NimbusOAuthStateCookie, ttlMs?: number): Promise<string>;
export declare function loadNimbusOAuthStateCookie<T>(request: Request, cookie: NimbusOAuthStateCookie): Promise<T | null>;
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
export declare function serializeNimbusCookie(name: string, value: string, opts: {
    path: string;
    maxAge: number;
}): string;
export declare function readNimbusCookie(request: Request, name: string): string | null;
export declare function isNimbusCloudflareAccountId(value: string): boolean;
export {};
//# sourceMappingURL=oauth.d.ts.map