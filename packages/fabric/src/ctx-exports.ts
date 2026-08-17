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

let _ctxExports: any = null;

export function setCtxExports(value: any): void {
  if (_ctxExports) return; // first-write-wins, same as the prior inline impl
  _ctxExports = value;
}

export function getCtxExports(): any {
  return _ctxExports;
}
