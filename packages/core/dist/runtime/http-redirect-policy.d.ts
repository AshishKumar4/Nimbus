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
export declare function isRedirectStatus(status: number, policy: RedirectPolicy): boolean;
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
export declare function applyRedirectPolicy<T>(hop: RedirectHop<T>, status: number, next: URL, policy: RedirectPolicy): void;
/** At most this many redirects followed: fetch's limit, and curl's and wget's default. */
export declare const MAX_REDIRECTS = 20;
/** Where a redirect walk ended: its last response and the URL it came from, a hop that failed as `send` named it, or the cap. */
export type RedirectWalk<F extends string> = {
    kind: 'response';
    response: Response;
    url: URL;
    redirected: boolean;
} | {
    [K in F]: {
        kind: K;
        url: URL;
    };
}[F] | {
    kind: 'too-many-redirects';
};
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
export declare function followRedirects<B, F extends string = never>(start: RedirectHop<B>, policy: 'fetch' | 'command', options: {
    follow: boolean;
    send: (hop: RedirectHop<B>) => Promise<Response | F>;
    arrived?: (response: Response) => Promise<void>;
}): Promise<RedirectWalk<F>>;
//# sourceMappingURL=http-redirect-policy.d.ts.map