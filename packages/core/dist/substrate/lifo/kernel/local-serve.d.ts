/**
 * One hop to a server of this workspace's: a server of a port registry (a
 * Node program's own, or the shell's), else the host's loopback router. The
 * host's dispatcher (commands/net/kernel-fetch.ts) and a Node program's http
 * client (node-compat/http.ts) both serve through here; it imports nothing a
 * Node guest's realm would not load anyway.
 */
import type { LoopbackRouter, VirtualRequest, VirtualRequestHandler, VirtualResponse } from './index.js';
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
 * `request` handed to `handler`, a server of a port registry, synchronously,
 * as a server takes a request: its response, with `_donePromise` still to
 * wait for when the handler returned before ending it; null when the handler
 * threw, which refuses the request.
 */
export declare function serveFromPort(handler: VirtualRequestHandler, request: VirtualRequest): VirtualResponse | null;
/**
 * The wait for a served response's `end`, however late its handler ends it,
 * unless `signal` aborts first or the hop's time passes: `ended`, or how the
 * wait stopped.
 */
export declare function awaitServedEnd(end: Promise<void>, signal: AbortSignal): Promise<'ended' | 'refused' | 'aborted' | 'timeout'>;
/** A served response's body as Node's HTTP server sends it: none for 204 and 304. A Response's is Fetch's (isNullBodyStatus). */
export declare function servedBody(response: VirtualResponse): string | null;
export declare function statusText(status: number): string;
/** `request` through the host's loopback `router`, which observes its signal: refused when no server holds `port`. */
export declare function routeToLoopback(router: LoopbackRouter, port: number, request: Request): Promise<WorkspaceRequestResult>;
//# sourceMappingURL=local-serve.d.ts.map