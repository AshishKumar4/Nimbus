/**
 * kernel-fetch.ts — the workspace-local request dispatcher.
 *
 * curl and wget are each bound to one kernel, and a loopback hop — including
 * one a redirect lands on — is served by that kernel's port registry or its
 * host's loopback router, never by fetch. The outcome is explicit rather
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
/** The loopback port a URL asks for, or null when it is not loopback. */
export declare function workspaceRequestPort(kernel: Kernel, url: URL): number | null;
/** HTTP reason phrase — virtual responses carry no status text. */
export declare function statusText(status: number): string;
/**
 * Serve `request` through the kernel's port registry, else its host's
 * loopback router. The handler's virtual response is adapted to a real
 * Response so callers hold exactly one response shape for local and remote
 * traffic alike. `request.signal` is the only cancellation channel — a
 * parked local handler and the loopback router both observe it.
 */
export declare function dispatchWorkspaceRequest(kernel: Kernel, port: number, request: Request): Promise<WorkspaceRequestResult>;
//# sourceMappingURL=kernel-fetch.d.ts.map