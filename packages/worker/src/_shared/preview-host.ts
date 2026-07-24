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

/** Binding that carries the deployment's preview-host suffix. */
const PREVIEW_HOST_SUFFIX_BINDING = 'NIMBUS_PREVIEW_HOST_SUFFIX';

export interface PreviewHost {
  port: number;
  sid: string;
}

export function isPreviewHostSafeSid(sid: string): boolean {
  return sid.length <= 56 && PREVIEW_HOST_SAFE_SID_RE.test(sid);
}

export function buildPreviewHost(sid: string, port: number, suffix: string): string {
  return `${port}--${sid}.${suffix}`;
}

/**
 * Read the configured preview-host suffix out of a bindings env.
 *
 * Bindings are `any` at the Workers boundary; narrowing happens here, once,
 * so a misconfigured binding degrades to "previews disabled" instead of
 * throwing on every request that touches the router.
 */
export function readPreviewHostSuffix(env: unknown): string | null {
  const value = (env as Record<string, unknown> | null | undefined)?.[PREVIEW_HOST_SUFFIX_BINDING];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parsePreviewHost(
  host: string,
  suffix: string | undefined | null,
): PreviewHost | null {
  if (!suffix) return null;

  // Strip the port, then one optional trailing dot: `x.example.com.` is the
  // same origin as `x.example.com` and must not slip past the suffix match.
  const normalizedHost = host.replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase();
  const normalizedSuffix = suffix.replace(/\.$/, '').toLowerCase();
  const suffixWithDot = `.${normalizedSuffix}`;
  if (!normalizedHost.endsWith(suffixWithDot)) return null;

  const label = normalizedHost.slice(0, -suffixWithDot.length);
  if (!label || label.includes('.')) return null;

  const match = label.match(PREVIEW_HOST_LABEL_RE);
  if (!match) return null;

  const port = Number(match[1]);
  const sid = match[2];
  if (port < 1 || port > 65535 || !isPreviewHostSafeSid(sid)) return null;

  return { port, sid };
}

/**
 * True when `url` addresses a port preview. Embedders MUST test this BEFORE
 * their own route table: a preview host serves untrusted user code at the
 * root, so a control-plane route answering there both breaks the previewed
 * app and hands the attacker's origin a Nimbus endpoint.
 */
export function isPreviewHostRequest(url: URL, env: unknown): boolean {
  return parsePreviewHost(url.host, readPreviewHostSuffix(env)) !== null;
}
