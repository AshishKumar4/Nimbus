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
import { type Kernel } from '../../kernel/index.js';
/** Outcomes of one workspace-local hop, for callers that report failure. */
export type WorkspaceRequestResult = {
    kind: 'response';
    response: Response;
} | {
    kind: 'refused';
} | {
    kind: 'aborted';
} | {
    kind: 'timeout';
};
/**
 * The loopback port a URL asks for, or null when it is not loopback. A name
 * is resolved through the kernel's /etc/hosts; a caller that holds no
 * resolver (a curl bound to a bare port registry) knows loopback by name only.
 */
export declare function workspaceRequestPort(kernel: Partial<Pick<Kernel, 'dns'>>, url: URL): number | null;
/** HTTP reason phrase — virtual responses carry no status text. */
export declare function statusText(status: number): string;
/**
 * Serve `request` through the kernel's port registry, else its host's
 * loopback router. The handler's virtual response is adapted to a real
 * Response so callers hold exactly one response shape for local and remote
 * traffic alike. `request.signal` is the only cancellation channel — a
 * parked local handler and the loopback router both observe it.
 */
export declare function dispatchWorkspaceRequest(kernel: Pick<Kernel, 'portRegistry' | 'routeLoopback'>, port: number, request: Request): Promise<WorkspaceRequestResult>;
/** How many redirects a walk follows before it gives up: curl's and wget's default. */
export declare const MAX_REDIRECTS = 20;
/** A request as it goes from hop to hop of a redirect walk. */
export interface HopRequest {
    url: URL;
    method: string;
    headers: Headers;
    body?: string;
}
/** One hop's request init, as fetch and the port registry take it: GET and HEAD carry no body. */
export declare function hopInit(hop: HopRequest, signal: AbortSignal): RequestInit;
/**
 * One hop as a kernel serves it: a loopback URL (by name through its
 * resolver) from its port registry or loopback router, refused there if
 * nothing listens, never fetched; any other off the box through the
 * workspace's network (its host's egress, when it supplied one). With no
 * kernel, every hop goes through the isolate's own network.
 */
export declare function sendHop(kernel: Pick<Kernel, 'portRegistry' | 'routeLoopback' | 'network'> & Partial<Pick<Kernel, 'dns'>> | undefined, url: URL, init: RequestInit): Promise<WorkspaceRequestResult>;
/** Where a walk ended: its final response and the URL it came from, the hop that failed, or the cap. */
export type RedirectWalkResult = {
    kind: 'response';
    response: Response;
    url: URL;
} | {
    kind: 'refused';
    url: URL;
} | {
    kind: 'aborted';
    url: URL;
} | {
    kind: 'timeout';
    url: URL;
} | {
    kind: 'too-many-redirects';
};
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
export declare function walkRedirects(start: HopRequest, options: {
    follow: boolean;
    send: (hop: HopRequest) => Promise<WorkspaceRequestResult>;
    arrived?: (response: Response) => Promise<void>;
}): Promise<RedirectWalkResult>;
//# sourceMappingURL=kernel-fetch.d.ts.map