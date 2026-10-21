/** undici.request (Node 22 / undici 6) also follows 300; curl/wget accept any 3xx. */
export function isRedirectStatus(status, policy) {
    if (policy === 'command')
        return status >= 300 && status < 400;
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
        || (policy === 'undici' && status === 300);
}
/**
 * Apply one followed redirect. Fetch and undici.request are not the same API:
 * Node 22's bundled undici 6.29.1 RedirectHandler rewrites only 303, removes
 * Host on every hop and *all* content-* headers on 303 (even for HEAD).
 * Fetch rewrites POST on 301/302 too, and removes body headers on a rewrite.
 * The command walk retains its existing fetch-like body/header semantics.
 *
 * scripts/compile-facet-bodies.mjs compiles these functions into the undici
 * guest's preamble. There is no second handwritten policy in its JS string.
 */
export function applyRedirectPolicy(hop, status, next, policy) {
    const rewrite = policy === 'undici'
        ? status === 303 && hop.method !== 'HEAD'
        : ((status === 301 || status === 302) && hop.method === 'POST')
            || (status === 303 && hop.method !== 'HEAD' && (policy === 'command' || hop.method !== 'GET'));
    if (rewrite) {
        hop.method = 'GET';
        hop.body = undefined;
    }
    if (policy === 'undici' && status === 303) {
        for (const name of [...hop.headers.keys()])
            if (name.toLowerCase().startsWith('content-'))
                hop.headers.delete(name);
    }
    else if (policy === 'fetch' && rewrite) {
        for (const name of ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length'])
            hop.headers.delete(name);
    }
    else if (policy === 'command' && hop.body === undefined) {
        for (const name of ['content-type', 'content-length', 'transfer-encoding', 'expect'])
            hop.headers.delete(name);
    }
    if (next.origin !== hop.url.origin) {
        for (const name of ['authorization', 'cookie', 'proxy-authorization'])
            hop.headers.delete(name);
        if (policy === 'command')
            hop.headers.delete('cookie2');
        else
            hop.headers.delete('host');
    }
    if (policy === 'undici')
        hop.headers.delete('host');
    hop.url = next;
}
/** At most this many redirects followed: fetch's limit, and curl's and wget's default. */
export const MAX_REDIRECTS = 20;
/**
 * Where a Location sends the next hop, or null when it sends it nowhere and
 * the redirect is the answer. Fetch drops its fragment, and refuses one that
 * does not parse or is not HTTP(S) (its network error, thrown); a command
 * follows any that parses.
 */
function redirectTarget(location, base, policy) {
    if (policy === 'command')
        return location !== '' && URL.canParse(location, base.href) ? new URL(location, base) : null;
    const next = new URL(location, base);
    next.hash = '';
    if (next.protocol !== 'http:' && next.protocol !== 'https:')
        throw new Error('URL scheme must be a HTTP(S) scheme');
    return next;
}
/** A followed response's body: cancelled, not waited on, as undici destroys a redirect's connection. */
function drop(response) {
    response.body?.cancel().catch(() => { });
}
/**
 * Send `start`, and while `follow` holds and the answer is a redirect
 * `policy` follows whose Location it takes, the request it redirects to,
 * rewritten as applyRedirectPolicy rewrites it: at most MAX_REDIRECTS, the
 * Location checked before the count, as Fetch's HTTP-redirect fetch checks
 * them. `send` serves one hop: its response, or the failure that ends the
 * walk. `arrived` sees each response before its body is read or dropped,
 * and may end the walk by throwing. The walk owns a copy of `start`'s
 * headers.
 */
export async function followRedirects(start, policy, options) {
    const hop = { ...start, headers: new Headers(start.headers) };
    for (let followed = 0;; followed++) {
        const answer = await options.send(hop);
        if (typeof answer === 'string')
            return { kind: answer, url: hop.url };
        await options.arrived?.(answer);
        const location = options.follow && isRedirectStatus(answer.status, policy) ? answer.headers.get('location') : null;
        let next = null;
        try {
            if (location !== null)
                next = redirectTarget(location, hop.url, policy);
        }
        catch (error) {
            drop(answer);
            throw error;
        }
        if (next === null)
            return { kind: 'response', response: answer, url: hop.url, redirected: followed > 0 };
        drop(answer);
        if (followed === MAX_REDIRECTS)
            return { kind: 'too-many-redirects' };
        applyRedirectPolicy(hop, answer.status, next, policy);
    }
}
