/**
 * The per-run session ledger `_driver.mjs` appends to: one JSON line per
 * mint and per DELETE of a session. run-all reads it once the probes finish.
 */

/**
 * What became of each minted session: deleted (a DELETE got a 2xx), leaked
 * (none did), or left to the TTL. An anonymous demo session (`reap: 'ttl'`
 * on its mint) cannot be deleted by the probe, since the endpoint answers 401
 * by design; the demo's TTL reaps it, so it is no leak.
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
      if (typeof e.status === 'number' && e.status >= 200 && e.status < 300) s.deletedBy = e.event;
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
