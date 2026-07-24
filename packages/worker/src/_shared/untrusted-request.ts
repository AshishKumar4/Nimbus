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

/** Cookie-name prefixes reserved for Nimbus and its embedders. */
const PLATFORM_COOKIE_PREFIXES = ['nimbus_', '__Host-nimbus', '__Secure-nimbus'];

/** True if `name` is a Nimbus/embedder platform cookie (never for user code). */
export function isPlatformCookie(name: string): boolean {
  return PLATFORM_COOKIE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Strip Nimbus credentials and internal routing headers from `headers`,
 * in place. Cookies the user's own app set are preserved — only the platform
 * namespace is removed.
 */
export function sanitizeUntrustedHeaders(headers: Headers): void {
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith('x-nimbus-')) headers.delete(name);
  }
  // Both carry credentials and neither is meaningful to a sandboxed server.
  headers.delete('Authorization');
  headers.delete('Proxy-Authorization');

  const cookie = headers.get('Cookie');
  if (!cookie) return;
  const remaining = cookie
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (!entry) return false;
      const separator = entry.indexOf('=');
      const name = separator === -1 ? entry : entry.slice(0, separator).trim();
      return !isPlatformCookie(name);
    });
  if (remaining.length > 0) headers.set('Cookie', remaining.join('; '));
  else headers.delete('Cookie');
}

/**
 * Clone `request` with credentials stripped, for callers that hand a whole
 * Request to user code. Returns the original when there is nothing to remove,
 * so the common case allocates nothing. WebSocket upgrades are passed through
 * untouched: reconstructing them drops the `webSocket` handshake, and the
 * upgrade itself is already authenticated upstream.
 */
export function sanitizeUntrustedRequest(request: Request): Request {
  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') return request;

  const headers = new Headers(request.headers);
  sanitizeUntrustedHeaders(headers);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(request.url, {
    method: request.method,
    headers,
    ...(hasBody ? { body: request.body, duplex: 'half' } as RequestInit : {}),
    redirect: request.redirect,
  });
}
