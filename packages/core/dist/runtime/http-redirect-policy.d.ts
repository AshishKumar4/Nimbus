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
 * Node 22's bundled undici 6.24.1 RedirectHandler rewrites only 303, removes
 * Host on every hop and *all* content-* headers on 303 (even for HEAD).
 * Fetch rewrites POST on 301/302 too, and removes body headers on a rewrite.
 * The command walk retains its existing fetch-like body/header semantics.
 *
 * scripts/compile-facet-bodies.mjs compiles these functions into the undici
 * guest's preamble. There is no second handwritten policy in its JS string.
 */
export declare function applyRedirectPolicy<T>(hop: RedirectHop<T>, status: number, next: URL, policy: RedirectPolicy): void;
//# sourceMappingURL=http-redirect-policy.d.ts.map