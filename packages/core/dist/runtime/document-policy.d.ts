/**
 * document-policy.ts — what a guest document's response headers say about
 * cross-origin isolation.
 *
 * The port registry sees every response a guest server sends, so it reads
 * the policy off each navigation response and reports it with the port
 * (`PortRegistry.stats`). The session shell decides from that what the
 * preview pane can offer (worker `_shared/preview-isolation.ts`), without
 * asking the guest again and without parsing headers in the browser.
 *
 * Each header is parsed the way the browser obtains it, so the report says
 * what the browser will do with the same bytes:
 *   - COEP and COOP are Structured Field items (RFC 8941); a value that does
 *     not parse, or whose item is not one of the policy tokens, is the
 *     default. https://html.spec.whatwg.org/multipage/browsers.html#obtain-an-embedder-policy
 *     https://html.spec.whatwg.org/multipage/browsers.html#obtain-coop
 *   - CORP is compared byte for byte.
 *     https://fetch.spec.whatwg.org/#cross-origin-resource-policy-internal-check
 */
/** An embedder policy value, as the HTML standard obtains it. */
export type EmbedderPolicy = 'unsafe-none' | 'require-corp' | 'credentialless';
/** An opener policy value, as the HTML standard obtains it. */
export type OpenerPolicy = 'unsafe-none' | 'same-origin-allow-popups' | 'same-origin' | 'noopener-allow-popups';
/** A Cross-Origin-Resource-Policy value, or null when absent or invalid. */
export type ResourcePolicy = 'same-origin' | 'same-site' | 'cross-origin' | null;
/** The isolation headers of one document response. */
export interface DocumentPolicy {
    embedderPolicy: EmbedderPolicy;
    openerPolicy: OpenerPolicy;
    resourcePolicy: ResourcePolicy;
}
export declare function documentPolicyOf(headers: Headers): DocumentPolicy;
//# sourceMappingURL=document-policy.d.ts.map