const PREVIEW_HOST_SAFE_SID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const PREVIEW_HOST_LABEL_RE = /^(\d+)--(.+)$/;
export function isPreviewHostSafeSid(sid) {
    return sid.length <= 56 && PREVIEW_HOST_SAFE_SID_RE.test(sid);
}
export function buildPreviewHost(sid, port, suffix) {
    return `${port}--${sid}.${suffix}`;
}
export function parsePreviewHost(host, suffix) {
    if (!suffix)
        return null;
    const normalizedHost = host.replace(/:\d+$/, '').toLowerCase();
    const normalizedSuffix = suffix.toLowerCase();
    const suffixWithDot = `.${normalizedSuffix}`;
    if (!normalizedHost.endsWith(suffixWithDot))
        return null;
    const label = normalizedHost.slice(0, -suffixWithDot.length);
    if (!label || label.includes('.'))
        return null;
    const match = label.match(PREVIEW_HOST_LABEL_RE);
    if (!match)
        return null;
    const port = Number.parseInt(match[1], 10);
    const sid = match[2];
    if (port < 1 || port > 65535 || !isPreviewHostSafeSid(sid))
        return null;
    return { port, sid };
}
