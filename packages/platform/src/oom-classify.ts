/**
 * oom-classify.ts — discriminator for OOM-like errors at Nimbus
 * boundaries.
 *
 * Why this exists
 * ───────────────
 * Nimbus has at least five distinct "the work failed" failure modes
 * that all surface today as either a thrown JS Error or a console
 * line:
 *
 *   1. SQLITE_NOMEM at the storage layer (per-DO SQLite cap, post-
 *      STOR/SPEC: Address SQLITE_NOMEM issues).
 *   2. Isolate memory exhaustion → 'oom'.
 *   3. Isolate CPU-budget exhaustion → 'cpu_exceeded'.
 *   4. Structured-clone refusal (`Cannot deserialize cloned data`)
 *      between supervisor ↔ facet RPC (32 MiB cap).
 *   5. RPC timeout (TimeoutError from facet-pool's per-task race).
 *
 * Plus a few platform-side terminations (subrequest cap, condemnation,
 * hard eviction) that the user sees but Nimbus has no first-party
 * signal for.
 *
 * Memory and CPU are separate buckets
 * ───────────────────────────────────
 * workerd models them as distinct trace outcomes — `exceededMemory` vs
 * `exceededCpu` (EventOutcome, workerd/io/outcome.capnp) — and words the
 * two message families so neither one's signature appears in the other:
 *
 *   memory  "Worker has exceeded memory limit."
 *           "Worker exceeded memory limit."
 *           "broken.exceededMemory; jsg.Error: Durable Object's isolate
 *            exceeded its memory limit …"
 *           "Memory limit exceeded"                    (RangeError)
 *   cpu     "Worker exceeded CPU time limit."
 *           "Durable Object exceeded its CPU time limit and was reset."
 *           "Python Worker exceeded CPU time limit"
 *
 * Read a low 'cpu_exceeded' count carefully: neither condition reliably
 * produces a message. Both are uncatchable inside the isolate that died,
 * so the string is only observable by a CALLER across an RPC boundary,
 * and Nimbus has repeatedly measured isolates vanishing with no throw at
 * all. Absence of 'cpu_exceeded' entries is therefore NOT evidence that
 * CPU was not the cause — confirm against `wrangler tail` either way.
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

const OOM_CAUSES = [
  'sqlite_nomem',
  'oom',
  'cpu_exceeded',
  'clone_refused',
  'rpc_timeout',
  'subrequest_cap',
  'dynamic_worker_cap',
  'condemnation',
  'hard_evict',
  'unknown',
] as const;

export type OomCause = typeof OOM_CAUSES[number];

export function isOomCause(input: unknown): input is OomCause {
  return OOM_CAUSES.some((cause) => cause === input);
}

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
  if (m.includes('deserialize cloned data')) return 'clone_refused';
  if (m.includes('could not be cloned')) return 'clone_refused';

  // RPC timeout (Nimbus's TimeoutError from facet-pool)
  if (m.includes('timeouterror')) return 'rpc_timeout';
  if (/\btimed?\s*out\b/.test(m)) return 'rpc_timeout';

  // Subrequest cap (Cloudflare platform)
  if (m.includes('too many subrequests')) return 'subrequest_cap';

  // Worker Loader concurrency cap (Cloudflare platform): a Durable Object
  // admits ~5-6 concurrent dynamic workers, and loader-cache entries are
  // never released — every distinct loader.get(id) permanently consumes a
  // slot, so this cap recurs until the DO itself is replaced.
  if (m.includes('too many concurrent dynamic workers')) return 'dynamic_worker_cap';

  // Memory exhaustion. workerd trace outcome `exceededMemory`; in-band it
  // arrives as a `broken.exceededMemory` actor break, a "…exceeded [its]
  // memory limit" kill, or the "Memory limit exceeded" RangeError.
  if (m.includes('exceededmemory')) return 'oom';
  if (/exceeded (?:its )?memory limit/.test(m)) return 'oom';
  if (m.includes('memory limit exceeded')) return 'oom';
  if (m.includes('memory limit') && m.includes('reset')) return 'oom';

  // CPU-budget exhaustion. A DIFFERENT platform condition from memory —
  // workerd reports it as trace outcome `exceededCpu`. Never fold the two:
  // a CPU kill recurs on the same input, a memory kill recurs on the same
  // working-set size, and the remedies are opposites.
  //
  // `cpu time limit` covers both scopes, which differ only by the
  // possessive: "Worker exceeded CPU time limit." and "Durable Object
  // exceeded its CPU time limit and was reset."
  //
  // Wall-clock handler timeouts are deliberately NOT matched here.
  // "Actor exceeded event execution time and was disconnected." is the
  // caller-configurable setHibernatableWebSocketEventTimeout() bound and
  // "Alarm exceeded its allowed execution time" is its alarm twin. Both
  // are elapsed-time bounds a handler blocked on I/O trips without burning
  // CPU, so bucketing them here would repeat the merge this split undoes.
  if (m.includes('cpu time limit')) return 'cpu_exceeded';
  if (m.includes('exceeded cpu limit')) return 'cpu_exceeded';

  // Explicit eviction (per CF research §A.1.2)
  if (m.includes('condemned')) return 'condemnation';
  if (m.includes('hard evict')) return 'hard_evict';

  return 'unknown';
}

/**
 * Transient Durable Object reset — the object was reset by the platform
 * mid-request for a reason unrelated to the request's own resource use:
 * a code deploy rolling over, or a storage-subsystem cold-start hiccup.
 * The in-flight request/RPC rejects, but the work itself never ran to a
 * conclusion and is safe to re-attempt.
 *
 * Deliberately narrow: it must NOT match resource kills ("isolate exceeded
 * its memory limit and was reset", "Durable Object exceeded its CPU time
 * limit and was reset"), which classifyMessage() routes to 'oom' and
 * 'cpu_exceeded' — those recur on retry and must surface, not loop. Note
 * both end in "and was reset"; the checks below key on the CAUSE clause,
 * never on the reset itself.
 * Observed verbatim signatures:
 *   - "Durable Object reset because its code was updated."
 *   - "Internal error while starting up Durable Object storage caused
 *      object to be reset; reference = ..."
 *   - "Internal error in Durable Object storage caused object to be reset;
 *      reference = ..."
 *   - "Durable Object storage operation exceeded timeout which caused
 *      the object to be reset."
 *
 * The second and third are the SAME condition worded for two moments —
 * startup versus a live write — and only the first was matched here, which is
 * why an object reset mid-write still failed a whole install. Nimbus has
 * measured the live-write wording twice: a 45.7 MB single-turn write reset the
 * object once and the same write then succeeded 12/12 on retry
 * (`vfs/facet-resident-store.ts`), and it reset a session DO mid-npm-install
 * on 2026-08-10 (probe `agentic-cli/new/pi-official-installer`). Retrying is
 * bounded, so the one case that is NOT transient — crossing the object's
 * storage budget, which the platform also reports this way
 * (`loaders/process-fabric.ts`) — recurs, exhausts the budget and surfaces.
 */
export function isTransientDoReset(input: unknown): boolean {
  const m = readMessage(input).toLowerCase();
  if (m.length === 0) return false;
  if (m.includes('reset because its code was updated')) return true;
  if (m.includes('durable object storage caused object to be reset')) return true;
  if (m.includes('storage operation') && m.includes('reset')) return true;
  return false;
}

/**
 * Workerd shed the call because the target Durable Object's input-gate
 * queue was too deep or too old: "Durable Object is overloaded."
 *
 * Distinct from `isTransientDoReset` on purpose. The object is alive and
 * the work never started, so the call is safe to re-attempt — but the
 * cause is queue pressure, so the only useful retry is one that backs off
 * long enough for the queue to drain. Callers pair this with a longer
 * backoff than a reset retry uses.
 */
export function isDoOverloaded(input: unknown): boolean {
  return readMessage(input).toLowerCase().includes('durable object is overloaded');
}

/**
 * How one failed Durable Object call relates to a retry. The taxonomy
 * Proteus hand-wrote in `cf-backend/src/lib/do-rpc.ts:71-79` because the
 * Agents SDK does not export its own, plus the `overloaded` class both
 * consumers need: Cloudflare documents that errors carry `.retryable` and
 * `.overloaded`, that a retryable error should be retried with backoff on a
 * FRESH stub, and that an overloaded one must not be retried at all
 * (developers.cloudflare.com/durable-objects/best-practices/error-handling).
 */
export type DoCallClass =
  /** A deploy replaced the isolate mid-call. */
  | 'superseded_isolate'
  /** The stub or storage connection dropped. */
  | 'connection_lost'
  /** Storage reset the object — cold start, live write, or a timeout. */
  | 'storage_reset'
  /** The runtime flagged the error `retryable` itself. */
  | 'retryable_flag'
  /** The object shed the call under queue pressure. NEVER retried: retrying
   *  an overloaded object is what overloaded it. */
  | 'overloaded'
  /** Everything else — the call ran and the answer is the error. */
  | 'permanent';

/** The classes a fresh-stub retry may act on. `overloaded` is deliberately
 *  outside: the platform's own docs forbid retrying it. */
export function isRetryableDoCall(input: DoCallClass): boolean {
  return input === 'superseded_isolate'
    || input === 'connection_lost'
    || input === 'storage_reset'
    || input === 'retryable_flag';
}

/**
 * Prose signatures of the transient classes, matched against the rendered
 * cause chain — a wrapper error (Proteus measured its SqlError doing this)
 * drops the `.retryable` property, so only the joined prose survives it.
 *
 * `storage_reset` carries the live-write wording on purpose. Proteus's
 * mirror of the SDK matcher excludes it because a storage-budget breach is
 * reported the same way; Nimbus measured the reset-mid-write case succeed
 * 12/12 on retry ({@link isTransientDoReset}), and a bounded retry lets the
 * budget-wall case recur and surface.
 */
const DO_CALL_TRANSIENT: ReadonlyArray<readonly [DoCallClass, RegExp]> = [
  ['superseded_isolate', /reset because its code was updated|this script has been upgraded/i],
  ['connection_lost', /network connection lost/i],
  ['storage_reset', /durable object storage caused object to be reset|storage operation exceeded timeout which caused the object to be reset/i],
];

/**
 * Classify one failed Durable Object call. Overloaded is checked first, per
 * link, because it vetoes everything: an overloaded-and-retryable error is
 * overloaded. The `.retryable` flag is also read per link — it is a
 * property, not prose, so the rendered chain cannot carry it. The walk is
 * cycle-guarded.
 */
export function classifyDoCall(input: unknown): DoCallClass {
  if (!(input instanceof Error)) return 'permanent';
  const seen = new Set<Error>();
  const messages: string[] = [];
  let flagged = false;
  let link: Error | null = input;
  while (link !== null && !seen.has(link)) {
    seen.add(link);
    const overloaded = ('overloaded' in link && link.overloaded === true)
      || isDoOverloaded(link.message);
    if (overloaded) return 'overloaded';
    if ('retryable' in link && link.retryable === true) flagged = true;
    messages.push(link.message ?? '');
    const cause: unknown = link.cause;
    link = cause instanceof Error ? cause : null;
  }
  const chain = messages.join('; ');
  for (const [transient, pattern] of DO_CALL_TRANSIENT) {
    if (pattern.test(chain)) return transient;
  }
  if (flagged) return 'retryable_flag';
  return 'permanent';
}

/**
 * One line about a failure, in terms someone can act on.
 *
 * npm install's catch sites each wrote `e?.remoteMessage || e?.message ||
 * String(e)`. That reduces a failure to a bare sentence, and when the platform
 * declines to describe a rejected Durable Object call the sentence is the word
 * `internal error` — which is how `resolver-fanout layer 2 failed: internal
 * error` reached users for months carrying nothing at all. The message is
 * often the least we know: the error's class, whether the description came
 * from a remote isolate, and which condition it classifies as are all still in
 * hand, and naming them costs nothing and invents nothing.
 */
export function describeError(input: unknown): string {
  const remote = typeof input === 'object' && input !== null
    ? (input as { remoteMessage?: unknown }).remoteMessage
    : undefined;
  const message = (typeof remote === 'string' && remote.length > 0)
    ? `${remote} (remote)`
    : readMessage(input) || String(input);
  const name = input instanceof Error && input.name && input.name !== 'Error'
    ? `${input.name}: `
    : '';
  const cause = classifyError(input);
  const suffix = cause !== 'unknown' ? ` [${cause}]`
    : isTransientDoReset(input) ? ' [transient-do-reset]'
    : isDoOverloaded(input) ? ' [do-overloaded]'
    : '';
  return `${name}${message}${suffix}`;
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
