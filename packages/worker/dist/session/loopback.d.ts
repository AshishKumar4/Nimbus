import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
/** FacetManager.ensureDurableAppOnPort: a server a restart left dark, driven back and waited for. */
export type EnsurePortServer = (port: number) => Promise<'started' | 'absent' | 'failed'>;
/**
 * `request` to whatever listens on `port`, or null when nothing does. A port
 * a restart left dark (an idle session that hibernated) may be a resident's
 * that is being driven back: the request waits for it (`ensure`), as the
 * port route does, rather than being refused.
 */
export declare function routeRuntimeLoopback(ports: Pick<PortRegistry, 'has' | 'routeRequest'>, port: number, request: Request, ensure?: EnsurePortServer): Promise<Response | null>;
/**
 * `request` routed, and routed `again` once when the process refused it
 * unsent (ProcessNotAdmitted): it ran nowhere, and its process has ended,
 * so `again` starts the server once more and sends it the request as it was
 * to be sent, its body unread. With no `again`, or refused again, or a
 * refusal that names no request, the caller is told, typed.
 */
export declare function rerunNotAdmitted<T>(request: Request, route: (request: Request) => Promise<T>, again: ((request: Request) => Promise<T>) | undefined): Promise<T>;
//# sourceMappingURL=loopback.d.ts.map