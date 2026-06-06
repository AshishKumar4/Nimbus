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

export function isBrowserNavigation(request: Request): boolean {
  if (request.headers.get('Upgrade') === 'websocket') return false;
  const accept = request.headers.get('Accept') || '';
  const fetchMode = request.headers.get('Sec-Fetch-Mode') || '';
  const fetchDest = request.headers.get('Sec-Fetch-Dest') || '';
  return accept.includes('text/html')
    || fetchMode === 'navigate'
    || fetchDest === 'document';
}
