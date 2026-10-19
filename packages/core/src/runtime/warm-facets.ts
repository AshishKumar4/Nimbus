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

/** A warm facet's key: one session's, one runtime's (FacetSpec.warm). */
export interface WarmFacetKey {
  readonly session: string;
  readonly name: string;
}

/** A runtime's warm facet keys in one session. */
export interface WarmFacetKeys {
  /** An idle key, or a new one: the caller runs one process on it. */
  take(): WarmFacetKey;
  /**
   * `key` back among the idle ones, after a call on it that ended clean.
   * A key not given back is never used again, nor one past `kept` idle.
   */
  give(key: WarmFacetKey): void;
}

/**
 * The warm facet keys `runtime` uses in `session`, at most `kept` idle. A
 * key is never named twice, nor by another incarnation of the session: a
 * facet one left running is not this one's to enter.
 */
export function warmFacetKeys(session: string, runtime: string, kept: number): WarmFacetKeys {
  if (!session) throw new Error(`warm ${runtime} facets: a warm facet belongs to a session, and none was named`);
  const idle: WarmFacetKey[] = [];
  const incarnation = crypto.randomUUID();
  let named = 0;
  return {
    take: () => idle.pop() ?? { session, name: `${runtime}-${incarnation}-${++named}` },
    give(key) {
      if (key.session !== session) throw new Error(`warm ${runtime} facets: a key of another session was given back`);
      if (idle.length < kept && !idle.includes(key)) idle.push(key);
    },
  };
}

/** The scope a host keys a warm facet's worker by: the session first, so no other session's key can name it. */
export function warmFacetScope(key: WarmFacetKey): string {
  return `${key.session}:${key.name}`;
}
