import { BASE, requestHeaders } from '../_driver.mjs';

const RESET_MESSAGE = 'Application called abort() to reset Durable Object.';

/** The deliberate abort response can beat teardown; retry only that exact platform error. */
export async function afterReset(operation, budgetMs = 10_000) {
  const deadline = Date.now() + Math.min(10_000, budgetMs);
  for (;;) {
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes(RESET_MESSAGE) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
    }
  }
}

/**
 * How `_diag/abort` answered a reset that took effect. The abort ends the
 * instance it is answered from, and the teardown can beat the 204 out: a 500
 * from an instance that then ended is TORN_DOWN, the reset, not a failure. A
 * 500 from an instance that lives on is the endpoint failing, and is red.
 */
export const ABORT_ANSWERED = 'answered';
export const ABORT_TORN_DOWN = 'torn-down';

/**
 * The session's primary instance's incarnation (`hib.isolateGen`), or null
 * while the primary does not answer. The read may be served by a read
 * replica, which the abort does not end: its answer is not the primary's.
 */
export async function incarnation(sid, base = BASE) {
  try {
    const response = await fetch(`${base}/s/${sid}/api/_diag/memory`, { headers: requestHeaders({}, sid), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const { hib, replica } = await response.json();
    return replica?.isReplica === false ? hib?.isolateGen ?? null : null;
  } catch {
    return null;
  }
}

/**
 * Resets `sid`'s instance with `_diag/abort` and grades the reset by its
 * effect: within `budgetMs` the session answers from a new incarnation. `ok`
 * is that; `answer` is how the abort answered (ABORT_ANSWERED or
 * ABORT_TORN_DOWN), which is not graded; `detail` says what was seen.
 */
export async function resetInstance(sid, { base = BASE, budgetMs = 30_000 } = {}) {
  const before = await incarnation(sid, base);
  const abort = await fetch(`${base}/s/${sid}/api/_diag/abort`, { method: 'POST', headers: requestHeaders({}, sid) });
  let after = null;
  for (const deadline = Date.now() + budgetMs; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 250))) {
    after = await incarnation(sid, base);
    if (after !== null && after !== before) break;
  }
  const moved = before !== null && after !== null && after !== before;
  const answer = abort.status === 204 ? ABORT_ANSWERED : abort.status === 500 && moved ? ABORT_TORN_DOWN : null;
  return {
    ok: moved && answer !== null,
    answer,
    detail: `abort answered ${abort.status}; incarnation ${before} → ${after}`,
  };
}
