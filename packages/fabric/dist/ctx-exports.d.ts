/**
 * ctx-exports.ts — leaf module holding the ctx.exports reference.
 *
 * Isolated from the embedder's entry module so helpers (notably
 * loader-pool.ts) can read `ctx.exports` without transitively importing the
 * Durable Object classes. Keeping this a leaf (no imports) lets the pool be
 * unit-tested in a plain Node/Bun process.
 *
 * The embedder's fetch handler calls `setCtxExports(ctx.exports)` on the
 * first request; callers like the loader pool read via `getCtxExports()`.
 * If the pool is constructed before the first fetch (unlikely) it just gets
 * null — the caller decides how to degrade.
 */
export declare function setCtxExports(value: any): void;
export declare function getCtxExports(): any;
/**
 * The embedder's supervisor WorkerEntrypoint factory, as ctx.exports holds
 * it: calling it with props mints one supervisor binding (`env.SUPERVISOR`)
 * for one hosted program.
 */
export type SupervisorEntrypointFactory = (options: {
    props: object;
}) => unknown;
export declare function setSupervisorEntrypointName(name: string): void;
/**
 * Resolve the registered supervisor entrypoint on an exports object —
 * `exportsObj` when given (a WorkerEntrypoint reads its own ctx.exports),
 * the held ctx.exports otherwise. Null when either half is missing; the
 * caller decides whether that degrades or throws.
 */
export declare function supervisorEntrypoint(exportsObj?: unknown): SupervisorEntrypointFactory | null;
/** The registered name, for error messages that point at the missing export. */
export declare function supervisorEntrypointName(): string | null;
//# sourceMappingURL=ctx-exports.d.ts.map