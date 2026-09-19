/**
 * kernel-fetch.ts — the workspace-local request dispatcher.
 *
 * curl and wget are each bound to one kernel, and a loopback hop — including
 * one a redirect lands on — is served by that kernel's port registry or its
 * host's loopback router, never by fetch. The outcome is explicit rather
 * than null: 'aborted' and 'timeout' surface to the caller's own reporting
 * instead of being mistaken for "no listener".
 */
import { isLoopbackHost, } from '../../kernel/index.js';
import { waitForSignalOrTimeout } from '../signal.js';
/** The loopback port a URL asks for, or null when it is not loopback. */
export function workspaceRequestPort(kernel, url) {
    let host = url.hostname;
    if (kernel.networkStack && !isLoopbackHost(host)) {
        host = kernel.networkStack.getDNS().lookup(host)?.value ?? host;
    }
    if (!isLoopbackHost(host))
        return null;
    return url.port ? Number(url.port) : (url.protocol === 'http:' ? 80 : 443);
}
/** HTTP reason phrase — virtual responses carry no status text. */
export function statusText(status) {
    const map = {
        200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
        301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
        304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
        400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
        404: 'Not Found', 405: 'Method Not Allowed', 500: 'Internal Server Error',
        502: 'Bad Gateway', 503: 'Service Unavailable',
    };
    return map[status] ?? '';
}
/**
 * Serve `request` through the kernel's port registry, else its host's
 * loopback router. The handler's virtual response is adapted to a real
 * Response so callers hold exactly one response shape for local and remote
 * traffic alike. `request.signal` is the only cancellation channel — a
 * parked local handler and the loopback router both observe it.
 */
export async function dispatchWorkspaceRequest(kernel, port, request) {
    const handler = kernel.portRegistry.get(port);
    if (handler) {
        const vReq = {
            method: request.method,
            url: new URL(request.url).pathname + new URL(request.url).search,
            headers: Object.fromEntries(request.headers.entries()),
            body: request.body ? await request.text() : '',
        };
        const vRes = {
            statusCode: 200,
            headers: {},
            body: '',
        };
        try {
            handler(vReq, vRes);
            if (vRes._donePromise) {
                const result = await waitForSignalOrTimeout(vRes._donePromise, request.signal, 30_000);
                if (result.type === 'aborted')
                    return { kind: 'aborted' };
                if (result.type === 'timeout')
                    return { kind: 'timeout' };
            }
        }
        catch {
            return { kind: 'refused' };
        }
        const status = vRes.statusCode;
        const body = (status === 204 || status === 304) ? null : vRes.body;
        return {
            kind: 'response',
            response: new Response(body, {
                status,
                statusText: statusText(status),
                headers: vRes.headers,
            }),
        };
    }
    if (kernel.routeLoopback) {
        const routed = await waitForSignalOrTimeout(kernel.routeLoopback(port, request), request.signal, 30_000);
        if (routed.type === 'aborted')
            return { kind: 'aborted' };
        if (routed.type === 'timeout')
            return { kind: 'timeout' };
        if (routed.value)
            return { kind: 'response', response: routed.value };
    }
    return { kind: 'refused' };
}
