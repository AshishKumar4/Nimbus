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
 *
 * The middle label may be a NAME instead of a port — `<name>--<sid>` and
 * `<cap>--<name>--<sid>` — for an application whose reservation carries a
 * name alias. A numeric label is a port; anything else that is a DNS label
 * is a name. The scoped name form is resolved to a port inside the session
 * (its reservation records); the public name form through the directory.
 */
export interface PreviewHost {
    /** The port, on the port forms. Absent on a name form — the name resolves to it. */
    port?: number;
    /** The name alias, on the name forms `<name>--<sid>` / `<cap>--<name>--<sid>`. */
    name?: string;
    sid: string;
    /**
     * Present only on the public capability forms `<cap>--<port>--<sid>` and
     * `<cap>--<name>--<sid>`: the bearer is the capability itself, so the
     * request skips session-attach auth entirely — the session decides by the
     * port's stored visibility.
     */
    capability?: string;
}
/** `<port>--<sid>` or `<name>--<sid>`: the middle label is a port number or a name alias. */
export declare function buildPreviewHost(sid: string, target: number | string, suffix: string): string;
/**
 * `<capability>--<port|name>--<sid>.<suffix>` — the unauthenticated sibling
 * of `buildPreviewHost`, for applications whose visibility is `public`. The
 * capability is the bearer: 24 lowercase hex, the same shape the port
 * registry mints.
 */
export declare function buildPublicPreviewHost(sid: string, target: number | string, capability: string, suffix: string): string;
export declare function isPreviewHostSafeSid(sid: string): boolean;
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
 * A name label: a DNS label that is neither a port (all digits) nor a
 * capability (24 lowercase hex), and contains no `--` host-label separator.
 * The same rule the session applies when it stores a
 * name on a reservation, so every name it accepts is a host it can parse.
 */
export declare function isPreviewHostName(label: string): boolean;
/**
 * True when `url` addresses a port preview. Embedders MUST test this BEFORE
 * their own route table: a preview host serves untrusted user code at the
 * root, so a control-plane route answering there both breaks the previewed
 * app and hands the attacker's origin a Nimbus endpoint.
 */
export declare function isPreviewHostRequest(url: URL, env: unknown): boolean;
//# sourceMappingURL=preview-host.d.ts.map