/**
 * session/agent.ts - Nimbus session chat agent and Cloudflare OAuth flow.
 *
 * The agent lives in the session Durable Object because that is where the
 * VFS, shell, process table, port registry, and runtime package manager
 * already live. AI calls go through Cloudflare's account REST API so a
 * connected user can spend their own Workers AI quota instead of the
 * Nimbus deployment owner quota.
 */
import { type SessionAiHost } from './ai.js';
import { type ProgrammaticHost } from './programmatic.js';
interface Host extends ProgrammaticHost, SessionAiHost {
    ctx: ProgrammaticHost['ctx'];
    env: ProgrammaticHost['env'] & Record<string, unknown>;
}
export interface OAuthStatePayload {
    v: 1;
    nonce: string;
    sessionId: string;
    tenantSegment: string;
    /** Expiry (ms since the epoch), signed with the rest. */
    exp: number;
}
export declare function handleAgentRequest(self: Host, request: Request, url: URL): Promise<Response>;
/**
 * The OAuth `state` a callback carries, if this deployment signed it. The
 * router routes a callback by the session and tenant segment in `state`, so an
 * unsigned one would let any client wake or create a Durable Object under any
 * tenant segment; the signature (HMAC-SHA256 under the agent cookie secret)
 * makes the router refuse it before routing. An expired one (its signed `exp`
 * at or before `now`) is refused the same way. Null for anything else.
 */
export declare function parseAgentOAuthStateParam(state: string | null, env: Record<string, unknown>, now?: number): Promise<OAuthStatePayload | null>;
/** The `state` an OAuth flow carries: `<payload>.<signature>`, both base64url. */
export declare function signAgentOAuthState(payload: OAuthStatePayload, env: Record<string, unknown>): Promise<string>;
export {};
//# sourceMappingURL=agent.d.ts.map