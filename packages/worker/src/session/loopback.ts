import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';

/** FacetManager.ensureDurableAppOnPort: a server a restart left dark, driven back and waited for. */
export type EnsurePortServer = (port: number) => Promise<'started' | 'absent' | 'failed'>;

/**
 * `request` to whatever listens on `port`, or null when nothing does. A port
 * a restart left dark (an idle session that hibernated) may be a resident's
 * that is being driven back: the request waits for it (`ensure`), as the
 * port route does, rather than being refused.
 */
export async function routeRuntimeLoopback(
  ports: Pick<PortRegistry, 'has' | 'routeRequest'>,
  port: number,
  request: Request,
  ensure?: EnsurePortServer,
): Promise<Response | null> {
  if (!ports.has(port) && (ensure === undefined || await ensure(port) !== 'started')) return null;
  return ports.routeRequest(port, request, new URL(request.url).pathname);
}
