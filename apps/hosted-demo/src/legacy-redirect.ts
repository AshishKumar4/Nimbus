// The pre-nimbus-os.dev apex, kept as a permanent-redirect source so existing
// links and bookmarks survive the domain move. Delete this module (and the
// legacy production route in wrangler.jsonc) when the old domain is retired.
const LEGACY_HOST = 'nimbus.ashishkumarsingh.com';
const CANONICAL_ORIGIN = 'https://nimbus-os.dev';

export function legacyHostRedirect(url: URL, method: string): Response | null {
  if (url.hostname !== LEGACY_HOST) return null;
  // Preserve path + query so deep links survive; the fragment never reaches
  // the server and is re-applied to the target by the browser.
  const location = `${CANONICAL_ORIGIN}${url.pathname}${url.search}`;
  // Permanent move: 301 for safe GET/HEAD, 308 to preserve method/body for the rest.
  const status = method === 'GET' || method === 'HEAD' ? 301 : 308;
  return new Response(null, {
    status,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}
