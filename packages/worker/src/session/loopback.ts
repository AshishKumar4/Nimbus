import type { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';

export async function routeRuntimeLoopback(
  ports: Pick<PortRegistry, 'has' | 'routeRequest'>,
  port: number,
  request: Request,
): Promise<Response | null> {
  if (!ports.has(port)) return null;
  return ports.routeRequest(port, request, new URL(request.url).pathname);
}
