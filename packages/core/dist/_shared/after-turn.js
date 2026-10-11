/**
 * Defer bookkeeping until the current continuation has finished, without a
 * timer. Timers in a busy Durable Object queue behind incoming RPC traffic;
 * a continuation fence remains part of the turn that requested the work.
 * The second checkpoint lets continuations queued by the first finish first.
 * Use afterTurn for ordering/bookkeeping. Use fabric/turn-budget.PacedWork
 * (nextTurn via the host's alarm) for a fresh invocation and CPU budget;
 * only that contract lets large bounded units reset their CPU account.
 */
export function afterTurn(work) {
    queueMicrotask(() => queueMicrotask(work));
}
