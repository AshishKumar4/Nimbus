/**
 * session-id.ts — Friendly human-readable session identifiers.
 *
 * Generated format: `adjective-noun-NNNN` (e.g. `nimble-otter-4271`).
 * Programmatic callers may also use explicit IDs like `job-123`.
 *
 * Why friendly IDs rather than opaque crypto strings?
 *   - Shareable over voice/chat without character-by-character dictation.
 *   - Memorable enough to bookmark a sandbox and return to it.
 *   - Same UX convention as Vercel preview URLs / StackBlitz sandboxes.
 *
 * DO mapping: `env.NIMBUS_SESSION.idFromName(sessionId)` — deterministic.
 * No backing store required; the session ID IS the key.
 *
 * Entropy budget: ~200 adjectives × ~200 nouns × 10,000 numeric suffixes
 * ≈ 4 × 10⁸ combinations. Birthday-collision probability at 1M live
 * sessions ≈ 0.12%. Acceptable for v1. If we ever push past that scale,
 * widen the suffix to 6 digits (≈ 4 × 10¹⁰).
 *
 * Validation rejects empty, overly long, slash-bearing, or colon-bearing
 * values before touching a DO. Colon remains reserved for tenant/sub/session
 * DO-name composition.
 */
/**
 * Validate a session ID before touching a DO.
 *
 * Browser-created sessions use the friendly generated shape. SDK-created
 * sandboxes can choose stable job IDs, so this also accepts the same compact
 * identifier class used by Nimbus JWT `sid`.
 */
export declare function isValidSessionId(id: string | null | undefined): boolean;
/**
 * Generate a fresh session ID. Uses crypto.getRandomValues for uniform
 * sampling — NOT Math.random (which on Workers is seeded at isolate start
 * and can repeat across concurrent requests that share an isolate).
 *
 * Suffix is a 4-digit zero-padded decimal (0000–9999), so parseInt can
 * round-trip it cleanly if anyone ever needs to sort/compare.
 */
export declare function generateSessionId(): string;
//# sourceMappingURL=session-id.d.ts.map