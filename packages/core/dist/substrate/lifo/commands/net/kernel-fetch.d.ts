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
import { type WorkspaceRequestResult } from '../../kernel/local-serve.js';
import { type RedirectHop, type RedirectWalk } from '../../../../runtime/http-redirect-policy.js';
/**
 * The loopback port a URL asks for, or null when it is not loopback. A name
 * is resolved through the kernel's /etc/hosts; a caller that holds no
 * resolver (a curl bound to a bare port registry) knows loopback by name only.
 */
export declare function workspaceRequestPort(kernel: Partial<Pick<Kernel, 'dns'>>, url: URL): number | null;
/** HTTP reason phrase — virtual responses carry no status text. */
/**
 * Serve `request` through the kernel's port registry, else its host's
 * loopback router. The handler's virtual response is adapted to a real
 * Response so callers hold exactly one response shape for local and remote
 * traffic alike. `request.signal` is the only cancellation channel — a
 * parked local handler and the loopback router both observe it.
 */
export declare function dispatchWorkspaceRequest(kernel: Pick<Kernel, 'portRegistry' | 'routeLoopback'>, port: number, request: Request): Promise<WorkspaceRequestResult>;
/** One hop's request init, as fetch and the port registry take it: GET and HEAD carry no body. */
export declare function hopInit(hop: RedirectHop<string>, signal: AbortSignal): RequestInit;
/**
 * One hop as a kernel serves it: a loopback URL (by name through its
 * resolver) from its port registry or loopback router, refused there if
 * nothing listens, never fetched; any other off the box through the
 * network of the command's process `pid` (its host's egress, when it
 * supplied one). With no kernel, every hop goes through the isolate's own
 * network.
 */
export declare function sendHop(kernel: Pick<Kernel, 'portRegistry' | 'routeLoopback' | 'network'> & Partial<Pick<Kernel, 'dns'>> | undefined, pid: number, url: URL, init: RequestInit): Promise<WorkspaceRequestResult>;
/** Where a command's walk ended: its final response and the URL it came from, the hop that failed, or the cap. */
export type RedirectWalkResult = RedirectWalk<'refused' | 'aborted' | 'timeout'>;
/**
 * Send `start`, and while `follow` holds, the requests its redirects make,
 * as a command follows them (followRedirects' 'command' policy): any 3xx
 * whose Location parses, 301 and 302 making a POST a bodyless GET and 303
 * anything but HEAD one, content headers going with the body and
 * credential headers when a hop crosses origins. `send` serves one hop
 * (the caller's policy: loopback, a gateway, fetch); `arrived` sees each
 * response before its body is read or dropped.
 */
export declare function walkRedirects(start: RedirectHop<string>, options: {
    follow: boolean;
    send: (hop: RedirectHop<string>) => Promise<WorkspaceRequestResult>;
    arrived?: (response: Response) => Promise<void>;
}): Promise<RedirectWalkResult>;
//# sourceMappingURL=kernel-fetch.d.ts.map