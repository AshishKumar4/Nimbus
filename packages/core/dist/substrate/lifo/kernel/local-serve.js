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
// Node's http.STATUS_CODES (Node 22). A Map: an object keyed 100…511 would hold them as sparse indexed storage, a slower lookup.
const STATUS_TEXT = new Map([
    [100, 'Continue'], [101, 'Switching Protocols'], [102, 'Processing'], [103, 'Early Hints'], [200, 'OK'],
    [201, 'Created'], [202, 'Accepted'], [203, 'Non-Authoritative Information'], [204, 'No Content'],
    [205, 'Reset Content'], [206, 'Partial Content'], [207, 'Multi-Status'], [208, 'Already Reported'],
    [226, 'IM Used'], [300, 'Multiple Choices'], [301, 'Moved Permanently'], [302, 'Found'], [303, 'See Other'],
    [304, 'Not Modified'], [305, 'Use Proxy'], [307, 'Temporary Redirect'], [308, 'Permanent Redirect'],
    [400, 'Bad Request'], [401, 'Unauthorized'], [402, 'Payment Required'], [403, 'Forbidden'], [404, 'Not Found'],
    [405, 'Method Not Allowed'], [406, 'Not Acceptable'], [407, 'Proxy Authentication Required'],
    [408, 'Request Timeout'], [409, 'Conflict'], [410, 'Gone'], [411, 'Length Required'], [412, 'Precondition Failed'],
    [413, 'Payload Too Large'], [414, 'URI Too Long'], [415, 'Unsupported Media Type'], [416, 'Range Not Satisfiable'],
    [417, 'Expectation Failed'], [418, "I'm a Teapot"], [421, 'Misdirected Request'], [422, 'Unprocessable Entity'],
    [423, 'Locked'], [424, 'Failed Dependency'], [425, 'Too Early'], [426, 'Upgrade Required'],
    [428, 'Precondition Required'], [429, 'Too Many Requests'], [431, 'Request Header Fields Too Large'],
    [451, 'Unavailable For Legal Reasons'], [500, 'Internal Server Error'], [501, 'Not Implemented'],
    [502, 'Bad Gateway'], [503, 'Service Unavailable'], [504, 'Gateway Timeout'], [505, 'HTTP Version Not Supported'],
    [506, 'Variant Also Negotiates'], [507, 'Insufficient Storage'], [508, 'Loop Detected'],
    [509, 'Bandwidth Limit Exceeded'], [510, 'Not Extended'], [511, 'Network Authentication Required'],
]);
/** The reason phrase a status has as Node's HTTP server sends it: 'unknown' for one Node does not name. */
export function statusText(status) {
    return STATUS_TEXT.get(status) ?? 'unknown';
}
/** A served response's reason phrase: its handler's (writeHead's reason, statusMessage), else its status's. */
export function servedReason(response) {
    return response.statusMessage || statusText(response.statusCode);
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
