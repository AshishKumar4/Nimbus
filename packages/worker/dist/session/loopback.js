export async function routeRuntimeLoopback(ports, port, request) {
    if (!ports.has(port))
        return null;
    return ports.routeRequest(port, request, new URL(request.url).pathname);
}
