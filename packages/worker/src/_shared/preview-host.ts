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

/**
 * The host label's grammar is `[<capability>--]<port|name>--<sid>`. A
 * capability, a port and a name never hold `--`, so the label splits at its
 * first separators and the sid is the rest; a sid may hold `--` itself.
 */
const HOST_LABEL_SEPARATOR = '--';
/** One DNS label: lowercase letters, digits and inner hyphens, 63 at most. */
const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** A port's one spelling: no leading zeros, so `03000--x` is not a host. */
const PORT_LABEL_RE = /^[1-9]\d{0,4}$/;
/**
 * The public capability: 24 lowercase hex, the shape the port registry
 * mints. On the public forms it is the bearer: no attach token and no
 * embedder credential ever crosses that hostname, and the label carries
 * everything a request needs with no server-side lookup.
 */
const CAPABILITY_LABEL_RE = /^[a-f0-9]{24}$/;
/** Binding that carries the deployment's preview-host suffix. */
const PREVIEW_HOST_SUFFIX_BINDING = 'NIMBUS_PREVIEW_HOST_SUFFIX';

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
export function buildPreviewHost(sid: string, target: number | string, suffix: string): string {
  return `${target}--${sid}.${suffix}`;
}

/**
 * `<capability>--<port|name>--<sid>.<suffix>` — the unauthenticated sibling
 * of `buildPreviewHost`, for applications whose visibility is `public`. The
 * capability is the bearer: 24 lowercase hex, the same shape the port
 * registry mints.
 */
export function buildPublicPreviewHost(
  sid: string,
  target: number | string,
  capability: string,
  suffix: string,
): string {
  return `${capability}--${target}--${sid}.${suffix}`;
}

/**
 * The preview origin of a session's application: its name where it has one,
 * else its port, and the public bearer form only when the application is
 * public and has a capability; anything else is the session-attached host.
 */
export function previewHostUrl(
  sid: string,
  app: { port: number; name?: string | null; visibility?: string; capability?: string | null },
  suffix: string,
): string {
  const label = app.name ?? app.port;
  return app.visibility === 'public' && typeof app.capability === 'string'
    ? `https://${buildPublicPreviewHost(sid, label, app.capability, suffix)}/`
    : `https://${buildPreviewHost(sid, label, suffix)}/`;
}

export function isPreviewHostSafeSid(sid: string): boolean {
  return sid.length <= 56 && DNS_LABEL_RE.test(sid);
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

  // A 24-hex first part can only be a capability: it is neither a port nor
  // a name (isPreviewHostName refuses that shape).
  const parts = label.split(HOST_LABEL_SEPARATOR);
  const capability = parts.length > 2 && CAPABILITY_LABEL_RE.test(parts[0]) ? parts.shift() : undefined;
  const [target, ...sidParts] = parts;
  const sid = sidParts.join(HOST_LABEL_SEPARATOR);
  if (sidParts.length === 0 || !isPreviewHostSafeSid(sid)) return null;
  const bearer = capability === undefined ? {} : { capability };
  if (PORT_LABEL_RE.test(target)) {
    const port = Number(target);
    return port <= 65535 ? { port, sid, ...bearer } : null;
  }
  return isPreviewHostName(target) ? { name: target, sid, ...bearer } : null;
}

/**
 * A name label: a DNS label that is neither a port (all digits) nor a
 * capability (24 lowercase hex), and contains no `--` host-label separator.
 * The same rule the session applies when it stores a
 * name on a reservation, so every name it accepts is a host it can parse.
 */
export function isPreviewHostName(label: string): boolean {
  return DNS_LABEL_RE.test(label)
    && !label.includes(HOST_LABEL_SEPARATOR)
    && !/^\d+$/.test(label)
    && !CAPABILITY_LABEL_RE.test(label);
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
