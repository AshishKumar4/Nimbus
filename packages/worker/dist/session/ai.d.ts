/**
 * session/ai.ts — the one path by which anything in Nimbus reaches a model.
 *
 * Two consumers, one implementation:
 *
 *   • Tools running inside the session (pi, opencode, a user script, curl)
 *     reach an OpenAI-compatible endpoint on session loopback,
 *     `http://127.0.0.1:<NIMBUS_AI_GATEWAY_PORT>/v1`, seeded into the session
 *     environment as OPENAI_BASE_URL / OPENAI_API_BASE / OPENAI_API_KEY.
 *   • The Nimbus agent (session/agent.ts) builds its AI-SDK provider with a
 *     `fetch` that calls straight into `handleSessionAiRequest`. Same code,
 *     no network hop.
 *
 * So this module is the single place that knows the Cloudflare AI base URL,
 * attaches `cf-aig-gateway-id`, resolves and refreshes the account credential,
 * and decides the default model. Nothing else may learn those things.
 *
 * Credential handling — the security contract
 * ───────────────────────────────────────────
 * The user's Cloudflare OAuth access token NEVER enters the sandbox. It lives
 * in Durable Object storage (`nimbus:ai:credential`), is attached to the
 * upstream request here in the supervisor, and the endpoint the session sees
 * needs no credential at all: loopback is already session-private, so
 * OPENAI_API_KEY is a fixed placeholder the gateway ignores.
 *
 * Why DO storage rather than the browser cookie the agent used to read: a
 * request originating inside the sandbox carries no cookie. The supervisor
 * must therefore hold a session-scoped credential of record for in-session
 * inference to be possible at all. The `nimbus_agent_oauth` cookie keeps its
 * job as the transport that carries the credential from the browser to the
 * session; `captureSessionAiCredential` is the one place it is read.
 */
import type { LanguageModel } from 'ai';
import { z } from 'zod/v4';
import { type NimbusCloudflareAccount } from './agent-oauth.js';
export interface SessionAiHost {
    env: Record<string, unknown>;
    ctx: {
        storage: {
            get(key: string): Promise<unknown>;
            put(key: string, value: unknown): Promise<void>;
            delete(key: string): Promise<void>;
        };
    };
}
/** DO storage key holding this session's Cloudflare credential of record. */
export declare const SESSION_AI_CREDENTIAL_KEY = "nimbus:ai:credential";
/**
 * The value seeded as OPENAI_API_KEY. Not a secret and not checked: the
 * endpoint is loopback-only, so possession of it proves nothing. It exists
 * because OpenAI clients refuse to start with an empty key.
 */
export declare const SESSION_AI_PLACEHOLDER_KEY = "nimbus-session";
export declare const DEFAULT_SESSION_AI_MODEL = "@cf/zai-org/glm-5.2";
export declare const DEFAULT_SESSION_AI_GATEWAY_ID = "default";
export interface SessionAiConfig {
    model: string;
    gatewayId: string;
    ownerAccountId: string;
    ownerToken: string;
    requireUserOAuth: boolean;
}
export interface ResolvedAiCredential {
    accessToken: string;
    accountId: string;
    source: 'session' | 'owner-token';
}
export interface SessionAiUnavailable {
    code: 'E_AI_NOT_CONNECTED' | 'E_AI_NO_ACCOUNT';
    message: string;
}
export type SessionAiResolution = {
    ok: true;
    credential: ResolvedAiCredential;
} | {
    ok: false;
    reason: SessionAiUnavailable;
};
declare const StoredCredentialSchema: z.ZodObject<{
    accessToken: z.ZodString;
    refreshToken: z.ZodOptional<z.ZodString>;
    accountId: z.ZodNullable<z.ZodString>;
    expiresAt: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
type StoredCredential = z.infer<typeof StoredCredentialSchema>;
/** Base URL of the in-session endpoint. The one true address of this gateway. */
export declare function sessionAiBaseUrl(): string;
/**
 * The environment every session is seeded with, so any OpenAI-compatible tool
 * discovers the gateway without being told about it.
 */
export declare function sessionAiEnv(): Record<string, string>;
export declare function readSessionAiConfig(env: Record<string, unknown>): SessionAiConfig;
/**
 * Adopt the credential the browser is carrying, if any. Called once at the top
 * of the session fetch handler: the `nimbus_agent_oauth` cookie is scoped to
 * `/s/<sid>`, so every page load, /ws upgrade and /api call delivers it, and
 * the gateway is live from the session's first request rather than only after
 * someone opens the agent panel.
 *
 * Cheap by construction — a header read, and an unseal only when the cookie
 * material differs from the last one this isolate saw.
 */
export declare function captureSessionAiCredential(self: SessionAiHost, request: Request): Promise<void>;
/**
 * The session's credential, refreshed if it is about to expire. Falls back to
 * the deployment owner's API token when the embedder configured one and has
 * not required per-user OAuth.
 */
export declare function resolveSessionAiCredential(self: SessionAiHost): Promise<SessionAiResolution>;
/**
 * Adopt a credential minted by this deployment's own OAuth callback. The
 * browser is not handed a copy: the session holds it, which is what makes
 * in-session inference possible.
 */
export declare function storeSessionAiCredential(self: SessionAiHost, credential: {
    accessToken: string;
    refreshToken?: string;
    accountId: string | null;
    expiresAt: number | null;
}): Promise<void>;
/**
 * What Cloudflare identity this session has, for the agent panel. Returns no
 * token — the credential stays inside this module, and callers that need to
 * reach Cloudflare do it through the functions here.
 */
export declare function describeSessionAiConnection(self: SessionAiHost): Promise<{
    connected: boolean;
    accountId: string | null;
    expiresAt: number | null;
    accounts: NimbusCloudflareAccount[];
    user: unknown;
}>;
/**
 * True when `accountId` is one the session's credential may actually use.
 * Checked before recording a pick so the panel cannot select into a 404.
 */
export declare function sessionAiAccountIsAvailable(self: SessionAiHost, accountId: string): Promise<boolean>;
/**
 * The model the Nimbus agent talks to. Built on the same gateway the session's
 * tools use: `fetch` goes straight into `handleSessionAiRequest` rather than
 * over the network, so credential minting, the gateway header, the base URL and
 * the default model have exactly one implementation between them.
 */
export declare function createSessionAiModel(self: SessionAiHost): LanguageModel;
/** Record the account the user picked. Storage is the only copy that decides. */
export declare function setSessionAiAccount(self: SessionAiHost, accountId: string): Promise<boolean>;
/** Forget this session's credential (agent logout). */
export declare function clearSessionAiCredential(self: SessionAiHost): Promise<void>;
/** The stored credential, for surfaces that report connection state. */
export declare function readSessionAiCredential(self: SessionAiHost): Promise<StoredCredential | null>;
/**
 * Serve one OpenAI-compatible request. This is the whole gateway: the loopback
 * router calls it for the session's tools, and agent.ts calls it directly for
 * the Nimbus agent.
 */
export declare function handleSessionAiRequest(self: SessionAiHost, request: Request): Promise<Response>;
export {};
//# sourceMappingURL=ai.d.ts.map