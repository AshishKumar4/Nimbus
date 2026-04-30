/**
 * ctx-exports.ts — leaf module holding the ctx.exports reference.
 *
 * Isolated from src/index.ts so helpers (notably src/parallel/facet-pool.ts)
 * can read `ctx.exports` without transitively importing the Durable Object
 * classes. Keeping this a leaf (no imports) lets the pool be unit-tested in
 * a plain Node/Bun process.
 *
 * The fetch handler in src/index.ts calls `setCtxExports(ctx.exports)` on
 * the first request; callers like NimbusFacetPool read via `getCtxExports()`.
 * If the pool is constructed before the first fetch (unlikely) it just gets
 * null — the caller decides how to degrade.
 */

let _ctxExports: any = null;

export function setCtxExports(value: any): void {
  if (_ctxExports) return; // first-write-wins, same as the prior inline impl
  _ctxExports = value;
}

export function getCtxExports(): any {
  return _ctxExports;
}
