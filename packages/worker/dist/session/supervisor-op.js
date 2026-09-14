import { SUPERVISOR_OPS } from '@nimbus-sh/core/workspace/supervisor-op.js';
/**
 * The canonical table in core names every op, its host method, and its
 * argument plan — one source for the worker's dispatch, the in-process
 * workspace's host routing, and the test's case table. This host's own
 * check is that each routed method exists on `NimbusSession` — the
 * `Exclude` below makes that a compile error, not a runtime name guess.
 */
const routes = SUPERVISOR_OPS;
// Every routed method must exist on this host — a missing name is a compile
// error here, not a runtime 'missing host method' surprise.
const _everyRouteResolvesOnThisHost = undefined;
void _everyRouteResolvesOnThisHost;
/** Preserve hosted accounting and lifecycle work behind the shared host seam. */
export async function sessionSupervisorOp(host, envelope) {
    if (!envelope || typeof envelope.op !== 'string' || !Object.hasOwn(routes, envelope.op)) {
        throw new Error(`supervisor op: '${envelope?.op}' is not served by this host`);
    }
    const route = routes[envelope.op];
    const args = route.args.map((slot) => typeof slot === 'number' ? envelope.args?.[slot] : envelope[slot]);
    const method = host[route.method];
    if (typeof method !== 'function')
        throw new Error(`supervisor op: missing host method ${route.method}`);
    return Reflect.apply(method, host, args);
}
