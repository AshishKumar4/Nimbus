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
 * How a server of a port registry took a request: its response, with the end
 * still to wait for when its handler returned before ending it (the
 * _donePromise a ServerResponse attaches while the response is open); or a
 * refusal, when the handler threw.
 */
export type Served = {
    kind: 'served';
    response: VirtualResponse;
    end: Promise<void> | null;
} | {
    kind: 'refused';
};
/** `request` handed to `handler`, a server of a port registry, synchronously, as a server takes a request. */
export declare function serveFromPort(handler: VirtualRequestHandler, request: VirtualRequest): Served;
/**
 * The wait for a served response's `end`, however late its handler ends it,
 * unless `signal` aborts first or the hop's time passes: `ended`, or how the
 * wait stopped.
 */
export declare function awaitServedEnd(end: Promise<void>, signal: AbortSignal): Promise<'ended' | 'refused' | 'aborted' | 'timeout'>;
/** A served response's body as HTTP carries it: none for 204 and 304. */
export declare function servedBody(response: VirtualResponse): string | null;
export declare function statusText(status: number): string;
/** `request` through the host's loopback `router`, which observes its signal: refused when no server holds `port`. */
export declare function routeToLoopback(router: LoopbackRouter, port: number, request: Request): Promise<WorkspaceRequestResult>;
//# sourceMappingURL=local-serve.d.ts.map