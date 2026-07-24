/**
 * preview-host.ts — the `<port>--<sid>.<suffix>` port-preview origin.
 *
 * One host per `(session, port)`, with the previewed app mounted at the host
 * ROOT so root-absolute paths resolve with zero rewriting. That makes the
 * origin the trust boundary: everything served there is untrusted user code,
 * and the app owns the whole path space. Nothing else — no control-plane
 * route, no OAuth entrypoint, no asset fallthrough — may answer on it.
 *
 * `buildPreviewHost` and `parsePreviewHost` are exact inverses: every
 * `(sid, port)` has exactly ONE valid origin. Without that bijection a cookie
 * set on the canonical host is missing from an equivalent-but-different one.
 */
export interface PreviewHost {
    port: number;
    sid: string;
}
export declare function isPreviewHostSafeSid(sid: string): boolean;
export declare function buildPreviewHost(sid: string, port: number, suffix: string): string;
/**
 * Read the configured preview-host suffix out of a bindings env.
 *
 * Bindings are `any` at the Workers boundary; narrowing happens here, once,
 * so a misconfigured binding degrades to "previews disabled" instead of
 * throwing on every request that touches the router.
 */
export declare function readPreviewHostSuffix(env: unknown): string | null;
export declare function parsePreviewHost(host: string, suffix: string | undefined | null): PreviewHost | null;
/**
 * True when `url` addresses a port preview. Embedders MUST test this BEFORE
 * their own route table: a preview host serves untrusted user code at the
 * root, so a control-plane route answering there both breaks the previewed
 * app and hands the attacker's origin a Nimbus endpoint.
 */
export declare function isPreviewHostRequest(url: URL, env: unknown): boolean;
//# sourceMappingURL=preview-host.d.ts.map