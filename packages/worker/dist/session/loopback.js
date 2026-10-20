import { ProcessNotAdmitted } from '@nimbus-sh/core/runtime/os-contracts.js';
/**
 * `request` to whatever listens on `port`, or null when nothing does. A port
 * a restart left dark (an idle session that hibernated) may be a resident's
 * that is being driven back: the request waits for it (`ensure`), as the
 * port route does, rather than being refused.
 */
export async function routeRuntimeLoopback(ports, port, request, ensure) {
    const route = async () => {
        if (!ports.has(port) && (ensure === undefined || await ensure(port) !== 'started'))
            return null;
        return ports.routeRequest(port, request, new URL(request.url).pathname);
    };
    return rerunNotAdmitted(route, ensure === undefined ? undefined : route);
}
/**
 * `route`, and `again` once when the process refused the request unsent
 * (ProcessNotAdmitted): it ran nowhere, and its process has ended, so
 * `again` starts the server once more and sends it the request, whole.
 * With no `again`, or refused again, the caller is told, typed.
 */
export async function rerunNotAdmitted(route, again) {
    try {
        return await route();
    }
    catch (error) {
        if (!(error instanceof ProcessNotAdmitted) || again === undefined)
            throw error;
        return again();
    }
}
