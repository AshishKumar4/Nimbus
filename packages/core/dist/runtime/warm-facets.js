/**
 * Warm facets: workers a runtime keeps between its processes, so a process
 * does not pay a cold isolate (its image loaded and compiled again).
 *
 * A warm facet belongs to one session. Its key is made from the session and
 * the runtime, and nothing else names one: a worker kept warm in a session
 * never serves another session's process, which would hand one user's
 * worker to another. One process runs on a key at a time, so two processes
 * never share a worker's memory or its limit; a key given back only after a
 * call that ended clean, and never one a call left in doubt, is how a crash
 * stays with the process that had it.
 */
import { DO_DYNAMIC_WORKER_LIMIT } from '@nimbus-sh/platform/limits.js';
/**
 * The most idle keys a runtime keeps in a session. A key is made only when a
 * run finds none idle, so the idle ones are as many as the runtime's runs
 * that were in flight at once, and never more than this: the platform lets
 * a Durable Object have DO_DYNAMIC_WORKER_LIMIT Dynamic Workers in flight at
 * once, so no more of one runtime's workers can ever run together. The
 * session's other work in flight (its residents, the build facets, git's
 * network steps) only lowers how many do at a time, by an amount that changes
 * from moment to moment; subtracting a fixed share of it would only make a
 * burst that found the slots free load its image again.
 */
export const WARM_FACETS_KEPT = DO_DYNAMIC_WORKER_LIMIT;
/**
 * The warm facet keys `runtime` uses in `session`, at most WARM_FACETS_KEPT
 * idle. A key is never named twice, nor by another incarnation of the
 * session: a facet one left running is not this one's to enter.
 */
export function warmFacetKeys(session, runtime) {
    if (!session)
        throw new Error(`warm ${runtime} facets: a warm facet belongs to a session, and none was named`);
    const idle = [];
    const incarnation = crypto.randomUUID();
    let named = 0;
    return {
        take: () => idle.pop() ?? { session, name: `${runtime}-${incarnation}-${++named}` },
        give(key, ...ends) {
            if (key.session !== session)
                throw new Error(`warm ${runtime} facets: a key of another session was given back`);
            if (!ends.every((end) => end.reusable === true && end.error === undefined && !end.killed))
                return;
            if (idle.length < WARM_FACETS_KEPT && !idle.includes(key))
                idle.push(key);
        },
    };
}
/**
 * The scope a host keys a warm facet's worker by: the session first, so no
 * other session's key can name it. A key that names no session is refused
 * here, where every host reads one, however the key was made.
 */
export function warmFacetScope(key) {
    if (typeof key.session !== 'string' || key.session === '')
        throw new Error(`warm facet ${key.name}: a warm facet belongs to a session, and none was named`);
    return `${key.session}:${key.name}`;
}
