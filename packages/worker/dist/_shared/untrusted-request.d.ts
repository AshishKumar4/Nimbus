/**
 * The trust boundary between Nimbus and code running inside a session.
 *
 * Everything a session serves — port previews (both the `<port>--<sid>` host
 * form and the `/s/<sid>/port/<n>/` path form), the Vite preview, the wrangler
 * worker preview — is UNTRUSTED: it is whatever the user (or an agent acting
 * for them) installed and ran. Nimbus's own credentials must never cross into
 * it, so requests are sanitized here, once, by every caller that hands a
 * Request to user code.
 *
 * Platform cookies are matched by NAMESPACE, not by an enumerated list. An
 * explicit list is drift-prone in the way that matters most: it silently fails
 * open. It also cannot work across layers — `NIMBUS_TOKEN_COOKIE` lives in
 * this package, `nimbus_agent_oauth` in the session layer, and embedder
 * cookies like `__Host-nimbus_demo_auth` in the app, which this package must
 * not import. A namespace rule covers all three and any cookie added later.
 */
/** True if `name` is a Nimbus/embedder platform cookie (never for user code). */
export declare function isPlatformCookie(name: string): boolean;
/**
 * Strip Nimbus credentials and internal routing headers from `headers`,
 * in place. Cookies the user's own app set are preserved — only the platform
 * namespace is removed.
 */
export declare function sanitizeUntrustedHeaders(headers: Headers): void;
/**
 * Clone `request` with credentials stripped, for callers that hand a whole
 * Request to user code. Returns the original when there is nothing to remove,
 * so the common case allocates nothing. WebSocket upgrades are passed through
 * untouched: reconstructing them drops the `webSocket` handshake, and the
 * upgrade itself is already authenticated upstream.
 */
export declare function sanitizeUntrustedRequest(request: Request): Request;
//# sourceMappingURL=untrusted-request.d.ts.map