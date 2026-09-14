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
const PREVIEW_HOST_SAFE_SID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
/** Canonical port form only: no leading zeros, so `03000--x` is not a host. */
const PREVIEW_HOST_LABEL_RE = /^(0|[1-9]\d*)--(.+)$/;
// The public capability form: the bearer is the capability itself, no
// attach token and no embedder credential ever crosses this hostname.
// The label carries everything a request needs — which port, which
// session, and which token — so it works with no server-side lookup.
const PREVIEW_CAPABILITY_HOST_LABEL_RE = /^([a-f0-9]{24})--(\d{1,5})--([a-z0-9-]{1,63})$/;
/** Binding that carries the deployment's preview-host suffix. */
const PREVIEW_HOST_SUFFIX_BINDING = 'NIMBUS_PREVIEW_HOST_SUFFIX';
export function buildPreviewHost(sid, port, suffix) {
    return `${port}--${sid}.${suffix}`;
}
/**
 * `<capability>--<port>--<sid>.<suffix>` — the unauthenticated sibling of
 * `buildPreviewHost`, for applications whose visibility is `public`. The
 * capability is the bearer: 24 lowercase hex, the same shape the port
 * registry mints.
 */
export function buildPublicPreviewHost(sid, port, capability, suffix) {
    return `${capability}--${port}--${sid}.${suffix}`;
}
export function isPreviewHostSafeSid(sid) {
    return sid.length <= 56 && PREVIEW_HOST_SAFE_SID_RE.test(sid);
}
/**
 * Read the configured preview-host suffix out of a bindings env.
 *
 * Bindings are `any` at the Workers boundary; narrowing happens here, once,
 * so a misconfigured binding degrades to "previews disabled" instead of
 * throwing on every request that touches the router.
 */
export function readPreviewHostSuffix(env) {
    const value = env?.[PREVIEW_HOST_SUFFIX_BINDING];
    return typeof value === 'string' && value.length > 0 ? value : null;
}
export function parsePreviewHost(host, suffix) {
    if (!suffix)
        return null;
    // Strip the port, then one optional trailing dot: `x.example.com.` is the
    // same origin as `x.example.com` and must not slip past the suffix match.
    const normalizedHost = host.replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase();
    const normalizedSuffix = suffix.replace(/\.$/, '').toLowerCase();
    const suffixWithDot = `.${normalizedSuffix}`;
    if (!normalizedHost.endsWith(suffixWithDot))
        return null;
    const label = normalizedHost.slice(0, -suffixWithDot.length);
    if (!label || label.includes('.'))
        return null;
    // The capability form is checked first: its leading 24-hex run would
    // otherwise parse as the port of the legacy form's widest match.
    const capabilityMatch = label.match(PREVIEW_CAPABILITY_HOST_LABEL_RE);
    if (capabilityMatch) {
        const capability = capabilityMatch[1];
        const port = Number(capabilityMatch[2]);
        const sid = capabilityMatch[3];
        if (port < 1 || port > 65535 || !isPreviewHostSafeSid(sid))
            return null;
        return { port, sid, capability };
    }
    const match = label.match(PREVIEW_HOST_LABEL_RE);
    if (!match)
        return null;
    const port = Number(match[1]);
    const sid = match[2];
    if (port < 1 || port > 65535 || !isPreviewHostSafeSid(sid))
        return null;
    return { port, sid };
}
/**
 * True when `url` addresses a port preview. Embedders MUST test this BEFORE
 * their own route table: a preview host serves untrusted user code at the
 * root, so a control-plane route answering there both breaks the previewed
 * app and hands the attacker's origin a Nimbus endpoint.
 */
export function isPreviewHostRequest(url, env) {
    return parsePreviewHost(url.host, readPreviewHostSuffix(env)) !== null;
}
