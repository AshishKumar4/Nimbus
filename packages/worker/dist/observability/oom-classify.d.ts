/**
 * oom-classify.ts — discriminator for OOM-like errors at Nimbus
 * boundaries.
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
declare const OOM_CAUSES: readonly ["sqlite_nomem", "oom", "clone_refused", "rpc_timeout", "subrequest_cap", "condemnation", "hard_evict", "unknown"];
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
 * Deliberately narrow: it must NOT match memory/CPU resets ("isolate
 * exceeded its memory limit and was reset"), which classifyMessage()
 * routes to 'oom' — those recur on retry and must surface, not loop.
 * Observed verbatim signatures:
 *   - "Durable Object reset because its code was updated."
 *   - "Internal error while starting up Durable Object storage caused
 *      object to be reset; reference = ..."
 *   - "Durable Object storage operation exceeded timeout which caused
 *      the object to be reset."
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
export {};
//# sourceMappingURL=oom-classify.d.ts.map