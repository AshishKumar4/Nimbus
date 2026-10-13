/** Redirect semantics at the HTTP boundary, shared by hosts and generated guests. */
export type RedirectPolicy = 'fetch' | 'undici' | 'command';

export interface RedirectHop<T = unknown> {
  url: URL;
  method: string;
  /** The walk owns this copy; never mutate the caller's original headers. */
  headers: Headers;
  body?: T;
}

/** undici.request (Node 22 / undici 6) also follows 300; curl/wget accept any 3xx. */
export function isRedirectStatus(status: number, policy: RedirectPolicy): boolean {
  if (policy === 'command') return status >= 300 && status < 400;
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
    || (policy === 'undici' && status === 300);
}

/**
 * Apply one followed redirect. Fetch and undici.request are not the same API:
 * Node 22's bundled undici 6.24.1 RedirectHandler rewrites only 303, removes
 * Host on every hop and *all* content-* headers on 303 (even for HEAD).
 * Fetch rewrites POST on 301/302 too, and removes body headers on a rewrite.
 * The command walk retains its existing fetch-like body/header semantics.
 *
 * scripts/compile-facet-bodies.mjs compiles these functions into the undici
 * guest's preamble. There is no second handwritten policy in its JS string.
 */
export function applyRedirectPolicy<T>(hop: RedirectHop<T>, status: number, next: URL, policy: RedirectPolicy): void {
  const rewrite = policy === 'undici'
    ? status === 303 && hop.method !== 'HEAD'
    : ((status === 301 || status === 302) && hop.method === 'POST')
      || (status === 303 && hop.method !== 'HEAD' && (policy === 'command' || hop.method !== 'GET'));
  if (rewrite) {
    hop.method = 'GET';
    hop.body = undefined;
  }

  if (policy === 'undici' && status === 303) {
    for (const name of [...hop.headers.keys()]) if (name.toLowerCase().startsWith('content-')) hop.headers.delete(name);
  } else if (policy === 'fetch' && rewrite) {
    for (const name of ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length']) hop.headers.delete(name);
  } else if (policy === 'command' && hop.body === undefined) {
    for (const name of ['content-type', 'content-length', 'transfer-encoding', 'expect']) hop.headers.delete(name);
  }

  if (next.origin !== hop.url.origin) {
    for (const name of ['authorization', 'cookie', 'proxy-authorization']) hop.headers.delete(name);
    if (policy === 'command') hop.headers.delete('cookie2');
    else hop.headers.delete('host');
  }
  if (policy === 'undici') hop.headers.delete('host');
  hop.url = next;
}
