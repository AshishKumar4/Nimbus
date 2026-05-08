/**
 * replica-suspension.ts — W12 — global replica-suspension counter.
 *
 * Per [~lambros/Feedback for DO read replication API](https://wiki.cfdata.org/display/~lambros/Feedback+for+DO+read+replication+API+based+on+D1+read+replication+beta)
 * (cited in CF research §G.4), DO read replicas error with "Network
 * connection lost" during high-volume writes. The recommended mitigation
 * is to disable replicas before a write burst (npm install, git clone)
 * and re-enable after.
 *
 * This module exposes a refcount-style suspend/release API. The counter
 * is checked by `shouldDelegateToPrimary` (in `replica-routing.ts`):
 * when `replicasSuspended() === true`, the replica forwards everything
 * to the primary regardless of route policy.
 *
 * Phase 1 of W12 ships the module + the in-DO consultation. Phase 2
 * (W12.5 if measured demand) wires the npm-installer / git-clone hooks.
 * Today's behaviour: counter stays at 0 → replicas serve normally; the
 * SPEC error path is observed as a graceful-degrade (replica's primary
 * stub returns the error and the user sees a 5xx, same as today's
 * single-region behaviour).
 */

let _suspendCount = 0;

/**
 * Increment the suspension count. Returns a release function that
 * decrements once (subsequent calls are no-ops). Suspends are nestable;
 * any holder keeping the count > 0 keeps replicas suspended.
 */
export function suspendReplicas(): () => void {
  _suspendCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    _suspendCount = Math.max(0, _suspendCount - 1);
  };
}

/** Are any holders currently suspending replicas? */
export function replicasSuspended(): boolean {
  return _suspendCount > 0;
}

/**
 * Test-only escape hatch. Resets the counter to 0. Production code MUST
 * NOT call this — use only the suspend/release pair to keep semantics
 * tight. Exported under a `_` prefix and namespaced for tests.
 */
export function _resetSuspensionForTests(): void {
  _suspendCount = 0;
}
