/**
 * session/ai.ts — the one path by which anything in Nimbus reaches a model.
 *
 * Two consumers, one implementation:
 *
 *   • Tools running inside the session (pi, opencode, a user script, curl)
 *     reach an OpenAI-compatible endpoint on session loopback,
 *     `http://127.0.0.1:<NIMBUS_AI_GATEWAY_PORT>/v1`, seeded into the session
 *     environment as OPENAI_BASE_URL / OPENAI_API_BASE. A tool that ignores
 *     the base URL and calls Cloudflare's own host still lands here: the
 *     seeded CLOUDFLARE_API_KEY is a session capability token, and egress
 *     carrying it is mediated back to this endpoint (_shared/ai-egress.ts).
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
 * upstream request here in the supervisor, and never travels the other way:
 * `proxyUpstream` builds its headers from scratch, so nothing the caller sent
 * — including the session token — reaches Cloudflare, and nothing Cloudflare
 * was sent reaches the caller.
 *
 * What the sandbox holds instead is the session token: it names this session's
 * gateway and nothing else, and every path that honours it (loopback, mediated
 * egress) ends up in this module, where the real credential is substituted.
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
declare const StoredCredentialSchema: any;
type StoredCredential = z.infer<typeof StoredCredentialSchema>;
/** Base URL of the in-session endpoint. The one true address of this gateway. */
export declare function sessionAiBaseUrl(): string;
/**
 * The account id the sandbox is given. The real one never crosses the boundary:
 * every mediated request is re-addressed in the supervisor
 * (`proxyUpstream`), which substitutes the account of record. A tool only ever
 * needs the id to *build a URL*, and the OS owns where that URL goes — so a
 * placeholder is both sufficient and the only value that keeps the session's
 * Cloudflare identity out of user code.
 */
export declare const SESSION_AI_ACCOUNT_PLACEHOLDER = "nimbus-session";
/**
 * The environment every session is seeded with, so a coding agent or an SDK
 * reaches this session's models without being told about them.
 *
 * What the session actually holds is a Cloudflare Workers AI account, and every
 * model it can run is a `@cf/…` id. `CLOUDFLARE_API_KEY` / `CLOUDFLARE_ACCOUNT_ID`
 * is the documented interface for exactly that, so a tool reading it picks a
 * model the account can serve and addresses
 * `api.cloudflare.com/client/v4/accounts/<id>/ai/v1/…`, which mediation brings
 * back here (_shared/ai-egress.ts) with the real credential substituted.
 *
 * The same endpoint is OpenAI-compatible, published as OPENAI_BASE_URL /
 * OPENAI_API_BASE. It is loopback-only and needs no credential, so a client
 * that reads the base URL works with any key or none.
 *
 * OPENAI_API_KEY is deliberately NOT seeded. Setting it asserts an OpenAI
 * account, and this session can never serve an OpenAI model id — a tool that
 * believes the assertion selects one of OpenAI's models and gets a 404 it
 * cannot act on. The variable stays the user's: exporting a real key reaches
 * OpenAI untouched, because that key is not this session's token.
 *
 * The token is minted per session rather than fixed, and is published under
 * NIMBUS_AI_TOKEN as well, so mediation has something to compare against that
 * is not a variable the user may overwrite.
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