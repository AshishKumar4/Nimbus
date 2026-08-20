/**
 * generation.ts — the isolate-generation clock, and the deferred
 * reconciliation that runs once per fresh incarnation.
 *
 * Workerd hibernates Durable Objects between requests to free memory. On
 * wake, the new isolate must rebuild its in-memory state from SQL — but it
 * also needs to know "is this the same lifecycle as before, or did workerd
 * recycle me?" That distinction matters for recovery (warmJoin vs cold init)
 * and is captured by the isolate generation, a counter persisted across
 * hibernations.
 *
 * State is keyed weakly off the actor's `ctx`, which lives exactly as long as
 * the incarnation: a fresh isolate gets a fresh `ctx`, adopts the persisted
 * counter, and bumps it once. The embedder reads `generation(ctx)` wherever it
 * needs the incarnation number — one source of truth instead of mirrored host
 * fields.
 */
/**
 * Storage key for the isolate-generation counter (cold-start +
 * post-hibernation wake; one increment per fresh isolate).
 *
 * The VALUE is live production DO storage ('w9_isolate_gen') and must never
 * change — renaming a storage key is a migration, and orphaned rows are the
 * least of what it breaks.
 */
export declare const GENERATION_KEY = "w9_isolate_gen";
/** The storage the generation counter persists through. */
export interface GenerationStorage {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
}
/** The hosting actor's context, as the generation clock reads it. */
export interface GenerationContext {
    storage: GenerationStorage;
}
/** This incarnation's generation. Zero until {@link adoptGeneration} ran. */
export declare function generation(ctx: object): number;
/** Increment + persist the generation counter once per fresh isolate. */
export declare function adoptGeneration(ctx: GenerationContext): Promise<void>;
/**
 * Take on a generation without persisting it, and clear the adopted guard so
 * a later {@link adoptGeneration} re-derives from storage. The
 * destroy-and-recreate path uses this: it wipes storage, re-persists the
 * pre-destroy counter, and runs the rest of this incarnation on the successor
 * generation the next boot will derive.
 */
export declare function assumeGeneration(ctx: object, value: number): void;
/**
 * Queue deferred async reconciliation for this incarnation.
 *
 * The task runs on the first {@link runColdStart} after registration — a turn
 * the embedder already owns, NEVER the constructor's init gate. Awaiting
 * recovery on the gate path is the trap this helper exists to avoid: the gate
 * blocks every request to the object, and reconciliation wants a filesystem
 * and a terminal that only a later turn has. The gate is also a wall, not
 * just a stall: a `blockConcurrencyWhile` callback still pending at ~30 s
 * (BLOCK_CONCURRENCY_CANCEL_MS, proven by probe) is cancelled and RESETS the
 * object with every queued event — so never call {@link runColdStart} from
 * inside one; the pump and the embedder's own turns are the places it runs.
 */
export declare function onColdStart(ctx: object, task: () => Promise<unknown>): void;
/**
 * Drain the queued cold-start tasks, serialized, each awaited so the turn
 * that runs them pays for them. Idempotent between registrations: a drained
 * queue is a cheap no-op, and a task registered after a drain runs on the
 * next call.
 */
export declare function runColdStart(ctx: object): Promise<void>;
//# sourceMappingURL=generation.d.ts.map