/**
 * ctx-exports.ts — leaf module holding the ctx.exports reference.
 *
 * Isolated from src/index.ts so helpers (notably src/loaders/loader-pool.ts)
 * can read `ctx.exports` without transitively importing the Durable Object
 * classes. Keeping this a leaf (no imports) lets the pool be unit-tested in
 * a plain Node/Bun process.
 *
 * The fetch handler in src/index.ts calls `setCtxExports(ctx.exports)` on
 * the first request; callers like NimbusLoaderPool read via `getCtxExports()`.
 * If the pool is constructed before the first fetch (unlikely) it just gets
 * null — the caller decides how to degrade.
 */
export declare function setCtxExports(value: any): void;
export declare function getCtxExports(): any;
//# sourceMappingURL=ctx-exports.d.ts.map