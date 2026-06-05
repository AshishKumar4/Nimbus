/**
 * session/replica-routes.ts — W12 DO read-replica state helpers.
 *
 * Two free functions paired with class delegators on NimbusSession:
 *
 *   wireReplicasOnConstruct(self) — runs `tryEnableReplicas(ctx)` from
 *     the DO ctor; graceful-degrades to `{ state: 'error', error }` on
 *     throw. Result is stored on `self._w12EnableResult`.
 *
 *   getReplicaState(self) — composes `_w12EnableResult` (constructor-time
 *     enable result) + live `inspectReplicaState(ctx)` (per-fetch isReplica
 *     + bookmark) + `replicasSuspended()` (write-burst guard). Surfaced
 *     via `/api/_diag/memory.replica` so operators (and the CT1 drift
 *     detector) can confirm replicas landed and observe replication lag.
 *
 * No module-level state. The W12 enable-result lives on the class
 * (`self._w12EnableResult`); this file is pure logic.
 */
import { tryEnableReplicas as _w12TryEnableReplicas, inspectReplicaState as _w12InspectReplicaState, } from '../replica/routing.js';
import { replicasSuspended as _w12ReplicasSuspended } from '../replica/suspension.js';
/**
 * Run at DO ctor time. Calls `tryEnableReplicas(ctx)` and returns the
 * result. Pre-GA runtimes lacking the SPEC API yield
 * `{ state: 'unsupported' }` and the DO behaves exactly as pre-W12. A
 * throw (which `tryEnableReplicas` itself catches but we belt-and-braces)
 * yields `{ state: 'error', error }`.
 *
 * `ctx` is the DurableObjectState (typed `any` because the class member
 * is `protected` and can't be put on a public interface).
 */
export function wireReplicasOnConstruct(ctx) {
    try {
        return _w12TryEnableReplicas(ctx);
    }
    catch (e) {
        // tryEnableReplicas itself never throws (it catches), but keep this
        // belt-and-braces so a future change doesn't break the constructor.
        return { state: 'error', error: e?.message ?? String(e) };
    }
}
/**
 * Compose the full operator-facing replica state for
 * `/api/_diag/memory.replica`.
 *
 * - `state` / `error` come from the ctor-time enable result on `host`.
 * - `isReplica` / `bookmark` come from per-fetch `inspectReplicaState(ctx)`.
 * - `suspended` reflects the global write-burst guard
 *   (npm install / git clone in flight) per CF research §G.4.
 *
 * Never throws. Callers can rely on the shape always being filled.
 *
 * Two args (host + ctx) because `ctx` is `protected` on the parent class
 * and can't be reached through a public interface; see ReplicaHost docs.
 */
export function getReplicaState(host, ctx) {
    const enable = host._w12EnableResult ?? { state: 'unknown', error: null };
    let isReplica = false;
    let bookmark = null;
    try {
        const inspect = _w12InspectReplicaState(ctx);
        isReplica = inspect.isReplica;
        bookmark = inspect.bookmark;
    }
    catch { /* never throw from a diag helper */ }
    let suspended = false;
    try {
        suspended = _w12ReplicasSuspended();
    }
    catch { }
    return {
        state: enable.state,
        error: enable.error,
        isReplica,
        bookmark,
        suspended,
    };
}
