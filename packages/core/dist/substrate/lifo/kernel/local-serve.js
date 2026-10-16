import { waitForSignalOrTimeout } from '../commands/signal.js';
/** How long a local hop waits for a server that has not answered: a handler's end, or the router's response. */
const LOCAL_HOP_TIMEOUT_MS = 30_000;
/**
 * `request` handed to `handler`, a server of a port registry, synchronously,
 * as a server takes a request: its response, with `_donePromise` still to
 * wait for when the handler returned before ending it; null when the handler
 * threw, which refuses the request.
 */
export function serveFromPort(handler, request) {
    const response = { statusCode: 200, headers: {}, body: '' };
    try {
        handler(request, response);
    }
    catch {
        return null;
    }
    return response;
}
/**
 * The wait for a served response's `end`, however late its handler ends it,
 * unless `signal` aborts first or the hop's time passes: `ended`, or how the
 * wait stopped.
 */
export async function awaitServedEnd(end, signal) {
    try {
        const result = await waitForSignalOrTimeout(end, signal, LOCAL_HOP_TIMEOUT_MS);
        return result.type === 'aborted' ? 'aborted' : result.type === 'timeout' ? 'timeout' : 'ended';
    }
    catch {
        return 'refused';
    }
}
/** A served response's body as Node's HTTP server sends it: none for 204 and 304. A Response's is Fetch's (isNullBodyStatus). */
export function servedBody(response) {
    return response.statusCode === 204 || response.statusCode === 304 ? null : response.body;
}
// A Map: an object keyed 200…503 would hold them as sparse indexed storage, a slower lookup.
const STATUS_TEXT = new Map([
    [200, 'OK'], [201, 'Created'], [202, 'Accepted'], [204, 'No Content'],
    [301, 'Moved Permanently'], [302, 'Found'], [303, 'See Other'],
    [304, 'Not Modified'], [307, 'Temporary Redirect'], [308, 'Permanent Redirect'],
    [400, 'Bad Request'], [401, 'Unauthorized'], [403, 'Forbidden'],
    [404, 'Not Found'], [405, 'Method Not Allowed'], [500, 'Internal Server Error'],
    [502, 'Bad Gateway'], [503, 'Service Unavailable'],
]);
export function statusText(status) {
    return STATUS_TEXT.get(status) ?? '';
}
/** `request` through the host's loopback `router`, which observes its signal: refused when no server holds `port`. */
export async function routeToLoopback(router, port, request) {
    const routed = await waitForSignalOrTimeout(router(port, request), request.signal, LOCAL_HOP_TIMEOUT_MS);
    if (routed.type === 'aborted')
        return { kind: 'aborted' };
    if (routed.type === 'timeout')
        return { kind: 'timeout' };
    return routed.value ? { kind: 'response', response: routed.value } : { kind: 'refused' };
}
