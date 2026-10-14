/**
 * kernel-fetch.ts — the workspace-local request dispatcher.
 *
 * curl and wget are each bound to one kernel, and a loopback hop — including
 * one a redirect lands on — is served by that kernel's port registry or its
 * host's loopback router, never by fetch; any other hop goes off the box
 * through the workspace's network. The outcome is explicit rather
 * than null: 'aborted' and 'timeout' surface to the caller's own reporting
 * instead of being mistaken for "no listener".
 */
import { isLoopbackHost, } from '../../kernel/index.js';
import { waitForSignalOrTimeout } from '../signal.js';
import { ISOLATE_NETWORK } from '../../../../_shared/workspace-network.js';
import { applyRedirectPolicy, isRedirectStatus } from '../../../../runtime/http-redirect-policy.js';
/**
 * `request` served by `handler`, a server of a port registry: its response
 * once the handler has ended it (the _donePromise a ServerResponse attaches),
 * however late, unless `signal` aborts first or 30 s pass. A handler that
 * throws refuses the request.
 */
export async function serveFromPort(handler, request, signal) {
    const response = { statusCode: 200, headers: {}, body: '' };
    try {
        handler(request, response);
        if (response._donePromise) {
            const result = await waitForSignalOrTimeout(response._donePromise, signal, 30_000);
            if (result.type === 'aborted')
                return { kind: 'aborted' };
            if (result.type === 'timeout')
                return { kind: 'timeout' };
        }
    }
    catch {
        return { kind: 'refused' };
    }
    return { kind: 'served', response };
}
/** A served response's body as HTTP carries it: none for 204 and 304. */
export function servedBody(response) {
    return response.statusCode === 204 || response.statusCode === 304 ? null : response.body;
}
/**
 * The loopback port a URL asks for, or null when it is not loopback. A name
 * is resolved through the kernel's /etc/hosts; a caller that holds no
 * resolver (a curl bound to a bare port registry) knows loopback by name only.
 */
export function workspaceRequestPort(kernel, url) {
    let host = url.hostname;
    if (!isLoopbackHost(host))
        host = kernel.dns?.lookup(host)?.value ?? host;
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
        const url = new URL(request.url);
        const served = await serveFromPort(handler, {
            method: request.method,
            url: url.pathname + url.search,
            headers: Object.fromEntries(request.headers.entries()),
            body: request.body ? await request.text() : '',
        }, request.signal);
        if (served.kind !== 'served')
            return served;
        const status = served.response.statusCode;
        return {
            kind: 'response',
            response: new Response(servedBody(served.response), {
                status,
                statusText: statusText(status),
                headers: served.response.headers,
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
/** How many redirects a walk follows before it gives up: curl's and wget's default. */
export const MAX_REDIRECTS = 20;
/** One hop's request init, as fetch and the port registry take it: GET and HEAD carry no body. */
export function hopInit(hop, signal) {
    const hasBody = hop.method !== 'GET' && hop.method !== 'HEAD' && hop.body !== undefined;
    return { method: hop.method, headers: hop.headers, body: hasBody ? hop.body : undefined, redirect: 'manual', signal };
}
/**
 * One hop as a kernel serves it: a loopback URL (by name through its
 * resolver) from its port registry or loopback router, refused there if
 * nothing listens, never fetched; any other off the box through the
 * network of the command's process `pid` (its host's egress, when it
 * supplied one). With no kernel, every hop goes through the isolate's own
 * network.
 */
export async function sendHop(kernel, pid, url, init) {
    const port = kernel ? workspaceRequestPort(kernel, url) : null;
    if (kernel && port !== null)
        return await dispatchWorkspaceRequest(kernel, port, new Request(url, init));
    return { kind: 'response', response: await (kernel?.network ?? ISOLATE_NETWORK).forProcess(pid).fetch(url, init) };
}
/**
 * Send `start`, and while `follow` holds and the answer is a 3xx with a
 * Location, send the request it redirects to, at most MAX_REDIRECTS times.
 * `send` serves one hop (the caller's policy: loopback, a gateway, fetch);
 * `arrived` sees each response before its body is read or dropped. A hop
 * is rewritten as fetch-follow rewrites it: 301 and 302 make a POST a
 * bodyless GET, 303 makes anything but HEAD one, content headers go with
 * the body, and credential headers when the hop crosses origins. A
 * redirect without a usable Location is final; a followed one's body is
 * cancelled.
 */
export async function walkRedirects(start, options) {
    const hop = { ...start, headers: new Headers(start.headers) };
    for (let redirects = 0;; redirects++) {
        const result = await options.send(hop);
        if (result.kind !== 'response')
            return { kind: result.kind, url: hop.url };
        const { response } = result;
        await options.arrived?.(response);
        const location = options.follow && isRedirectStatus(response.status, 'command')
            ? response.headers.get('location')
            : null;
        if (!location)
            return { kind: 'response', response, url: hop.url };
        if (redirects === MAX_REDIRECTS) {
            response.body?.cancel().catch(() => { });
            return { kind: 'too-many-redirects' };
        }
        let next;
        try {
            next = new URL(location, hop.url);
        }
        catch {
            return { kind: 'response', response, url: hop.url };
        }
        response.body?.cancel().catch(() => { });
        applyRedirectPolicy(hop, response.status, next, 'command');
    }
}
