// Kept here rather than in `demo-auth.ts` for the reason documented at the
// top of `demo-sessions.ts`: that module imports the full `@nimbus-sh/sdk/worker`
// barrel and so is only loadable inside workerd. These are plain responses
// with no OAuth state in them, and they are worth being able to assert
// outside a Worker.
import { demoPage } from './demo-sessions.js';

export function demoAuthRequiredResponse(request: Request, returnTo?: string): Response {
  if (isBrowserNavigation(request)) {
    const url = new URL('/login', request.url);
    url.searchParams.set('return_to', returnTo || new URL(request.url).pathname);
    return new Response(null, {
      status: request.method === 'GET' ? 302 : 303,
      headers: { Location: url.toString(), 'Cache-Control': 'no-store' },
    });
  }
  return Response.json(
    { error: 'Login required', code: 'E_DEMO_LOGIN_REQUIRED' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * Every way the Cloudflare OAuth round-trip can end without an auth cookie.
 *
 * The error alone is not actionable: the common real-world cause is the
 * visitor's own network — a VPN, corporate proxy, or Zero Trust client such
 * as WARP intercepting the callback — and nothing in the failure identifies
 * that, so the page names it as something to check rather than as a
 * diagnosis it cannot support. `/try` is offered beside it because a visitor
 * whose network blocks the callback cannot act on "try again" at all, and
 * the anonymous path does not touch OAuth.
 *
 * `setCookies` carries what the caller needs the browser to apply anyway —
 * the OAuth state cookie clear — since the shared page chrome sets the rest.
 */
export function renderOAuthFailure(message: string, setCookies: string[] = []): Response {
  const page = demoPage(400, `
    <main>
      <h1>Login failed</h1>
      <p>${escapeHtml(message)}</p>
      <p class="note">Some networks block the Cloudflare sign-in callback. If you are on a VPN, a corporate proxy, or a Zero Trust client such as Cloudflare WARP, turn it off for this sign-in, or try a different network or another browser profile.</p>
      <a href="/login">Try again</a>
      <p class="note">You do not need an account to use Nimbus. A free sandbox is ephemeral: it runs for a few minutes and is not saved.</p>
      <a href="/try">Try it now</a>
    </main>
  `);
  for (const cookie of setCookies) page.headers.append('Set-Cookie', cookie);
  return page;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function isBrowserNavigation(request: Request): boolean {
  if (request.headers.get('Upgrade') === 'websocket') return false;
  const accept = request.headers.get('Accept') || '';
  const fetchMode = request.headers.get('Sec-Fetch-Mode') || '';
  const fetchDest = request.headers.get('Sec-Fetch-Dest') || '';
  return accept.includes('text/html')
    || fetchMode === 'navigate'
    || fetchDest === 'document';
}
