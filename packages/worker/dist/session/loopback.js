import { ProcessNotAdmitted } from '@nimbus-sh/core/runtime/os-contracts.js';
/**
 * `request` to whatever listens on `port`, or null when nothing does. A port
 * a restart left dark (an idle session that hibernated) may be a resident's
 * that is being driven back: the request waits for it (`ensure`), as the
 * port route does, rather than being refused.
 */
export async function routeRuntimeLoopback(ports, port, request, ensure) {
    const route = async (sent) => {
        if (!ports.has(port) && (ensure === undefined || await ensure(port) !== 'started'))
            return null;
        return ports.routeRequest(port, sent, new URL(sent.url).pathname);
    };
    return rerunNotAdmitted(request, route, ensure === undefined ? undefined : route);
}
/**
 * `request` routed, and routed `again` once when the process refused it
 * unsent (ProcessNotAdmitted): it ran nowhere, and its process has ended,
 * so `again` starts the server once more and sends it the request as it was
 * to be sent, its body unread. With no `again`, or refused again, or a
 * refusal that names no request, the caller is told, typed.
 */
export async function rerunNotAdmitted(request, route, again) {
    try {
        return await route(request);
    }
    catch (error) {
        if (!(error instanceof ProcessNotAdmitted) || again === undefined || error.request === undefined)
            throw error;
        return again(error.request);
    }
}
