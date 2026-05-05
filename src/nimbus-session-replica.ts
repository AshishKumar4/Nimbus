/**
 * nimbus-session-replica.ts — W12 DO read-replica state helpers.
 *
 * Extracted from src/nimbus-session.ts per
 * audit/sections/SESSION-REFACTOR-PLAN.md §B.3.6 + S3.
 *
 * Two free functions paired with class delegators:
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

import {
  tryEnableReplicas as _w12TryEnableReplicas,
  inspectReplicaState as _w12InspectReplicaState,
  type TryEnableReplicasResult as W12EnableResult,
} from './replica-routing.js';
import { replicasSuspended as _w12ReplicasSuspended } from './replica-suspension.js';

export type { W12EnableResult };

/**
 * Minimal shape of `NimbusSession` that the replica helpers need to
 * read/write. Per plan §IX.1 (refined option b'), the class fields used
 * here drop `private`, so this interface declares them as public.
 *
 * NOTE on `ctx`: the parent `CloudflareDurableObject` class declares
 * `ctx` as `protected`, which is nominal-typed in TS. The interface
 * cannot declare `ctx` (TS-2412). Helpers that need ctx must extract
 * it from the call site (passed as a separate arg). We use `any` here
 * for the field set, but `ctx` is never accessed via this interface —
 * the helpers below accept ctx as a parameter when needed.
 */
export interface ReplicaHost {
  _w12EnableResult: W12EnableResult | null;
}

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
export function wireReplicasOnConstruct(ctx: any): W12EnableResult {
  try {
    return _w12TryEnableReplicas(ctx);
  } catch (e: any) {
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
export function getReplicaState(host: ReplicaHost, ctx: any): {
  state: string;
  error: string | null;
  isReplica: boolean;
  bookmark: string | null;
  suspended: boolean;
} {
  const enable = host._w12EnableResult ?? { state: 'unknown', error: null };
  let isReplica = false;
  let bookmark: string | null = null;
  try {
    const inspect = _w12InspectReplicaState(ctx);
    isReplica = inspect.isReplica;
    bookmark = inspect.bookmark;
  } catch { /* never throw from a diag helper */ }
  let suspended = false;
  try { suspended = _w12ReplicasSuspended(); } catch {}
  return {
    state: enable.state,
    error: enable.error,
    isReplica,
    bookmark,
    suspended,
  };
}
