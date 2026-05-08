/**
 * oom-classify.ts — discriminator for OOM-like errors at Nimbus
 * boundaries. Tagged W5 (Lever 5 / J.1.1 in CF-INTERNAL-OPTIMIZATION-
 * RESEARCH.md).
 *
 * Why this exists
 * ───────────────
 * Nimbus has at least four distinct "the work failed" failure modes
 * that all surface today as either a thrown JS Error or a console
 * line:
 *
 *   1. SQLITE_NOMEM at the storage layer (per-DO SQLite cap, post-
 *      STOR/SPEC: Address SQLITE_NOMEM issues).
 *   2. Generic isolate OOM (`Durable Object's isolate exceeded its
 *      memory limit and was reset` per ~sha/DOGE Recommendations).
 *   3. Structured-clone refusal (`Cannot deserialize cloned data`)
 *      between supervisor ↔ facet RPC (32 MiB cap).
 *   4. RPC timeout (TimeoutError from facet-pool's per-task race).
 *
 * Plus a few platform-side terminations (subrequest cap, condemnation,
 * hard eviction) that the user sees but Nimbus has no first-party
 * signal for.
 *
 * Without a classifier, every recordFailure() call has to stringify-
 * match its own error site. With this module, we pin the regex once
 * and reuse it everywhere.
 *
 * Inputs we accept
 * ────────────────
 * The classifier accepts:
 *   - Error instances (read e.message)
 *   - plain strings (use directly — for stderr-line classification at
 *     facet-exit boundaries where we don't have an Error)
 *   - anything else (return 'unknown')
 *
 * Output values
 * ─────────────
 * Same set used by `DiagFailure.cause` in oom-discriminator.ts. Keep
 * the union narrow and additive — adding a new value is fine, but
 * never re-purpose an existing one.
 */

export type OomCause =
  | 'sqlite_nomem'
  | 'oom'
  | 'clone_refused'
  | 'rpc_timeout'
  | 'subrequest_cap'
  | 'condemnation'
  | 'hard_evict'
  | 'unknown';

/**
 * Classify an error or message string into an OomCause. Returns
 * 'unknown' when no signature matches — callers should still record
 * the message via DiagFailure.message so a human can later widen the
 * classifier rules.
 */
export function classifyError(input: unknown): OomCause {
  const msg = readMessage(input);
  if (msg.length === 0) return 'unknown';
  return classifyMessage(msg);
}

/**
 * Variant for callers that already have the message string. Prefer
 * classifyError() at boundaries; this is exposed for cases where the
 * message has already been extracted (e.g. truncated / sanitised).
 */
export function classifyMessage(msg: string): OomCause {
  // Use lower-case match for forgiveness; SQLITE_NOMEM is canonically
  // upper but stderr can be either.
  const m = msg.toLowerCase();

  // SQLITE_NOMEM signals
  if (m.includes('sqlite_nomem')) return 'sqlite_nomem';
  if (m.includes('out of memory')) return 'sqlite_nomem';
  if (m.includes('database or disk is full')) return 'sqlite_nomem';

  // Structured-clone refusal — a 32 MiB-cap cousin
  if (m.includes('cannot deserialize cloned data')) return 'clone_refused';
  if (m.includes('could not be cloned')) return 'clone_refused';

  // RPC timeout (Nimbus's TimeoutError from facet-pool)
  if (m.includes('timeouterror')) return 'rpc_timeout';
  if (/\btimed?\s*out\b/.test(m)) return 'rpc_timeout';

  // Subrequest cap (Cloudflare platform)
  if (m.includes('too many subrequests')) return 'subrequest_cap';

  // Generic DO isolate condemnation / eviction
  if (m.includes('isolate exceeded its memory limit')) return 'oom';
  if (m.includes('memory limit') && m.includes('reset')) return 'oom';
  if (m.includes('worker exceeded memory')) return 'oom';
  if (m.includes('exceeded cpu')) return 'oom';

  // Explicit eviction (per CF research §A.1.2)
  if (m.includes('condemned')) return 'condemnation';
  if (m.includes('hard evict')) return 'hard_evict';

  return 'unknown';
}

function readMessage(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.message ?? '';
  // Some thrown values are plain objects with .message
  if (typeof input === 'object') {
    const m = (input as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  try {
    return String(input);
  } catch {
    return '';
  }
}
