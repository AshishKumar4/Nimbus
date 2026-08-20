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
declare const OOM_CAUSES: readonly ["sqlite_nomem", "oom", "cpu_exceeded", "clone_refused", "rpc_timeout", "subrequest_cap", "dynamic_worker_cap", "condemnation", "hard_evict", "unknown"];
export type OomCause = typeof OOM_CAUSES[number];
export declare function isOomCause(input: unknown): input is OomCause;
/**
 * Classify an error or message string into an OomCause. Returns
 * 'unknown' when no signature matches — callers should still record
 * the message via DiagFailure.message so a human can later widen the
 * classifier rules.
 */
export declare function classifyError(input: unknown): OomCause;
/**
 * Variant for callers that already have the message string. Prefer
 * classifyError() at boundaries; this is exposed for cases where the
 * message has already been extracted (e.g. truncated / sanitised).
 */
export declare function classifyMessage(msg: string): OomCause;
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
export declare function isTransientDoReset(input: unknown): boolean;
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
export declare function isDoOverloaded(input: unknown): boolean;
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
export declare function describeError(input: unknown): string;
export {};
//# sourceMappingURL=oom-classify.d.ts.map