/**
 * derived.ts — a watermark memo: derive a cheap key, compare, rebuild only
 * on change.
 *
 * Proteus's ActorAgent hand-rolls this pair four times — cached value plus
 * cached key, compared and rebuilt inline: the system prompt (key composed
 * from soul text, executors, model, tools, stance), the tool set (keyed
 * partly on `_craftCacheKey()`, two synchronous SQLite aggregates), the MCP
 * tool surface (keyed on UserDO's `mcp_updated_at`), and the SOUL text
 * (no key at all — push-invalidated by `setSoul`). The consumer port moved
 * the prompt and tool-set pairs onto `derived` cleanly; the MCP pair needs
 * the per-call context and the hooks; the SOUL pair cannot move at all.
 *
 * The SOUL pair names this module's limit: a value LOADED asynchronously
 * (an awaited file read at turn start) but READ synchronously (the prompt
 * builder consults what is already in memory). Neither variant expresses
 * that split — `derived` cannot await the load, `derivedAsync` cannot serve
 * a synchronous read — so an async-load/sync-read snapshot stays a
 * hand-rolled field with a push invalidation.
 *
 * `derived` is synchronous end to end, because its consumers are: Think
 * calls `getSystemPrompt(): string` synchronously, and nothing synchronous
 * may await — the init-gate rule. `derivedAsync` exists because ONE consumer
 * call site needs it: the MCP surface awaits a cross-DO RPC for both the
 * watermark and the build, and its proven failure policy is stale-on-error —
 * a watermark or build failure serves the last good value without touching
 * the stored key, and only surfaces when there is no value to serve.
 *
 * `invalidate()` is the push half the SOUL memo proved: an out-of-band write
 * (`setSoul`) clears the memo so the next read rebuilds under an unchanged
 * watermark.
 */
export interface Derived<T, C = void> {
    /**
     * `context` reaches the watermark and the build of THIS call — the seam
     * for per-call state (a stub, a caller identity, a work mode). The memo
     * stores one value; the watermark must cover everything the build reads,
     * context included, or a context change serves another context's value.
     */
    get(context: C): T;
    /** Force the next get to rebuild, watermark unchanged. */
    invalidate(): void;
}
/**
 * The consumer's logging seams. Both MCP logs the port could not express:
 * `onRebuild` fires after a build stores (the "rebuilt @ wm=N" line), and
 * `onStale` — async only — fires when a failure serves the stale value,
 * the one path where the error is otherwise absorbed. A surfaced error
 * (nothing stale to serve) reports itself.
 */
export interface DerivedHooks {
    /** After a build stores. `previousKey` is undefined on the first build. */
    onRebuild?(previousKey: string | number | undefined, nextKey: string | number): void;
}
export interface DerivedAsyncHooks extends DerivedHooks {
    /** A watermark or build failure just served the stale value. */
    onStale?(error: unknown): void;
}
export declare function derived<T, C = void>(watermark: (context: C) => string | number, build: (context: C, key: string | number) => T, hooks?: DerivedHooks): Derived<T, C>;
export interface DerivedAsync<T, C = void> {
    get(context: C): Promise<T>;
    invalidate(): void;
}
export declare function derivedAsync<T, C = void>(watermark: (context: C) => Promise<string | number>, build: (context: C, key: string | number) => Promise<T>, hooks?: DerivedAsyncHooks): DerivedAsync<T, C>;
//# sourceMappingURL=derived.d.ts.map