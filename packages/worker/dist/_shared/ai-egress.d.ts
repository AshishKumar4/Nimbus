/**
 * _shared/ai-egress.ts — how the OS recognises a request as the session's own
 * inference, wherever in the sandbox it was made.
 *
 * The problem this solves
 * ──────────────────────
 * Nimbus serves an OpenAI-compatible endpoint on session loopback
 * (session/ai.ts) and advertises it as OPENAI_BASE_URL. Tools that follow that
 * convention find it with no configuration. Plenty of tools do not: they hold a
 * baked-in vendor base URL and only read the *key* from the environment, so the
 * gateway is invisible to them and the seeded key is worse than useless — it
 * tells them a provider is configured when the endpoint they will call is not
 * reachable.
 *
 * The mediation
 * ─────────────
 * The seeded key is a session capability token, and any request leaving the
 * sandbox that presents it is inference this session owns. Those requests are
 * served by the session's own gateway rather than sent to the network; the
 * supervisor substitutes the real Cloudflare credential at the boundary, so the
 * token is all the sandbox ever holds. The tool is not configured, adapted or
 * special-cased anywhere — it makes the request it always makes, and the OS
 * answers it. Same shape as a transparent proxy or /etc/resolv.conf.
 *
 * Why match on the credential and not on the destination
 * ─────────────────────────────────────────────────────
 * A list of AI vendor hostnames would need maintaining forever and would still
 * hijack traffic that is not ours — a user's own OpenAI key, sent to OpenAI,
 * would be captured by a host match. Matching the token instead makes the
 * fallback correct by construction: a request carrying anything other than this
 * session's token is not ours, is not touched, and reaches the real provider.
 *
 * The mediators live where egress happens — the facet's patched global fetch
 * (runtime/node-shims.ts) and the shell's curl (substrate/lifo/commands/net) —
 * and both decide with `requestCarriesSessionAiToken` over these constants, so
 * the policy has one definition.
 */
/**
 * Env var holding the session's AI capability token.
 *
 * Carried under its own name as well as OPENAI_API_KEY because OPENAI_API_KEY
 * is the user's to overwrite: someone who exports a real provider key must
 * still reach that provider. Mediation compares against THIS variable, never
 * against whatever OPENAI_API_KEY happens to hold.
 */
export declare const NIMBUS_AI_TOKEN_ENV = "NIMBUS_AI_TOKEN";
/**
 * Headers an API credential is carried in, lowercased: `Authorization: Bearer`
 * for OpenAI-shaped clients, `x-api-key` for Anthropic-shaped ones.
 */
export declare const NIMBUS_AI_CREDENTIAL_HEADERS: readonly ["authorization", "x-api-key"];
/**
 * Mint a session's token. Shaped like an OpenAI secret key because tools
 * validate that shape before they will even attempt a request, and unguessable
 * so that a string which merely *mentions* Nimbus can never be mistaken for it.
 */
export declare function mintSessionAiToken(): string;
/**
 * True when `headers` present `token`. False for an empty token, so a session
 * that never seeded one mediates nothing.
 */
export declare function requestCarriesSessionAiToken(headers: Headers, token: string): boolean;
//# sourceMappingURL=ai-egress.d.ts.map