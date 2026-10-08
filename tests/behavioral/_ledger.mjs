/**
 * The per-run session ledger `_driver.mjs` appends to: one JSON line per
 * mint and per DELETE of a session. run-all reads it once the probes finish.
 * And the exit hook's DELETEs, which a child process runs (deleteSessions).
 */

/**
 * Whether a `DELETE /s/<id>/` response proves the session was destroyed.
 *
 * A 2xx alone does not: a router that serves the session shell for any
 * method answers a DELETE with 200 HTML and destroys nothing. Only the
 * destroy result does — JSON `{ ok: true, result: { ok: true, killed,
 * destroyedAt, reason } }`, what `box.destroy()` answers.
 *
 * @param {Response} response
 * @returns {Promise<{ ok: boolean, status: number, body: string }>}
 */
export async function deletionResult(response) {
  const body = await response.text().catch(() => '');
  let document;
  try { document = JSON.parse(body); } catch { /* not the destroy result */ }
  const result = document?.result;
  const json = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() === 'application/json';
  const confirmed = response.ok && json && document?.ok === true && result?.ok === true
    && Number.isSafeInteger(result.killed) && result.killed >= 0
    && Number.isSafeInteger(result.destroyedAt) && result.destroyedAt >= 0
    && (result.reason === null || typeof result.reason === 'string');
  return { ok: Boolean(confirmed), status: response.status, body };
}

/** IMF-fixdate, the HTTP-date form senders generate (RFC 9110 §5.6.7). */
const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * How long a 503's Retry-After asks to wait, in ms: delay-seconds or an
 * IMF-fixdate (RFC 9110 §10.2.3), from `now`. Null when the header is absent,
 * empty or anything else, so the caller's default applies; Date.parse alone is
 * lenient ("Jan 1 2000" and "1.5" both parse), and a lenient past date would
 * mean retrying at once. The obsolete RFC 850 and asctime forms fall to the
 * default too.
 *
 * @param {string | null} header
 * @param {number} [now]
 * @returns {number | null}
 */
export function retryAfterMs(header, now = Date.now()) {
  const value = (header ?? '').trim();
  const ms = /^\d+$/.test(value) ? Number(value) * 1000
    : IMF_FIXDATE.test(value) ? Date.parse(value) - now : NaN;
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

/**
 * DELETE each session and read the answer through deletionResult. A 503 (the
 * session object refusing work it is too busy to admit; the destroy never
 * ran) or a failed request is tried again, after the answer's Retry-After or
 * else 1 s, at most `tries` times within `budgetMs`: a session busy with an
 * install refused its DELETE once and was counted a leak while it lived. Any
 * other answer is the verdict. The destroy is idempotent.
 *
 * @param {{ base: string, sessions: [string, Record<string, string>][], tries: number, budgetMs: number }} run
 * @returns {Promise<{ status: number | string, confirmed: boolean, attempts: number }[]>}
 */
export async function deleteSessions({ base, sessions, tries, budgetMs }) {
  return Promise.all(sessions.map(async ([sid, headers]) => {
    const deadline = Date.now() + budgetMs;
    for (let attempt = 1; ; attempt++) {
      let last, waitMs = 1000;
      try {
        const response = await fetch(`${base}/s/${encodeURIComponent(sid)}/`, {
          method: 'DELETE', headers, signal: AbortSignal.timeout(Math.max(0, deadline - Date.now())),
        });
        const result = await deletionResult(response);
        last = { status: result.status, confirmed: result.ok, attempts: attempt };
        if (response.status !== 503) return last;
        waitMs = retryAfterMs(response.headers.get('retry-after')) ?? waitMs;
      } catch (error) {
        last = { status: `error: ${error.message}`, confirmed: false, attempts: attempt };
      }
      if (attempt >= tries || Date.now() + waitMs >= deadline) return last;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }));
}

/**
 * What became of each minted session: deleted (a DELETE returned the destroy
 * result, recorded `confirmed`), leaked (none did), or left to the TTL. An
 * anonymous demo session (`reap: 'ttl'` on its mint) cannot be deleted by the
 * probe, since the endpoint answers 401 by design; the demo's TTL reaps it,
 * so it is no leak. A row without `confirmed` — a bare 2xx — proves nothing.
 *
 * @param {string} text  The ledger file's contents.
 * @returns {{ deleted: number, byExitHook: number, leaks: [string, object][], ttlReaped: [string, object][] }}
 */
export function sessionOutcomes(text) {
  const sessions = new Map();
  for (const line of text.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const s = sessions.get(e.sid) ?? { probe: e.probe, deletedBy: null, last: 'none', reap: null };
    if (e.event === 'mint') {
      if (e.reap) s.reap = e.reap;
    } else {
      s.last = e.status;
      if ((e.event === 'delete' || e.event === 'exit-delete') && e.confirmed === true
          && typeof e.status === 'number' && e.status >= 200 && e.status < 300) s.deletedBy = e.event;
    }
    sessions.set(e.sid, s);
  }
  const undeleted = [...sessions].filter(([, s]) => !s.deletedBy);
  return {
    deleted: sessions.size - undeleted.length,
    byExitHook: [...sessions.values()].filter((s) => s.deletedBy === 'exit-delete').length,
    leaks: undeleted.filter(([, s]) => s.reap !== 'ttl'),
    ttlReaped: undeleted.filter(([, s]) => s.reap === 'ttl'),
  };
}
