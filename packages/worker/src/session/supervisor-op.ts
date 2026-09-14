import { SUPERVISOR_OPS, type SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import type { NimbusSession } from './nimbus-session.js';

/**
 * The canonical table in core names every op, its host method, and its
 * argument plan — one source for the worker's dispatch, the in-process
 * workspace's host routing, and the test's case table. This host's own
 * check is that each routed method exists on `NimbusSession` — the
 * `Exclude` below makes that a compile error, not a runtime name guess.
 */
const routes = SUPERVISOR_OPS as Readonly<Record<string, {
  method: keyof NimbusSession;
  args: readonly (number | 'pid' | 'writerId' | 'stream' | 'mutationOwner')[];
}>>;

type RoutedMethod = typeof SUPERVISOR_OPS[keyof typeof SUPERVISOR_OPS]['method'];
type MissingOnSession = Exclude<RoutedMethod, keyof NimbusSession>;
// Every routed method must exist on this host — a missing name is a compile
// error here, not a runtime 'missing host method' surprise.
const _everyRouteResolvesOnThisHost: MissingOnSession = undefined as never as MissingOnSession;
void _everyRouteResolvesOnThisHost;

/** Preserve hosted accounting and lifecycle work behind the shared host seam. */
export async function sessionSupervisorOp(
  host: NimbusSession,
  envelope: SupervisorOpEnvelope,
): Promise<unknown> {
  if (!envelope || typeof envelope.op !== 'string' || !Object.hasOwn(routes, envelope.op)) {
    throw new Error(`supervisor op: '${envelope?.op}' is not served by this host`);
  }
  const route = routes[envelope.op];
  const args = route.args.map((slot) => typeof slot === 'number' ? envelope.args?.[slot] : envelope[slot]);
  const method = host[route.method];
  if (typeof method !== 'function') throw new Error(`supervisor op: missing host method ${route.method}`);
  return Reflect.apply(method, host, args);
}
