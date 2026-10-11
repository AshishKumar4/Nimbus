/**
 * `request` to whatever listens on `port`, or null when nothing does. A port
 * a restart left dark (an idle session that hibernated) may be a resident's
 * that is being driven back: the request waits for it (`ensure`), as the
 * port route does, rather than being refused.
 */
export async function routeRuntimeLoopback(ports, port, request, ensure) {
    if (!ports.has(port) && (ensure === undefined || await ensure(port) !== 'started'))
        return null;
    return ports.routeRequest(port, request, new URL(request.url).pathname);
}
