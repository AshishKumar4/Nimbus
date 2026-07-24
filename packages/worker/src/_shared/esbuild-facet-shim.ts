/**
 * esbuild's `__name` helper, for source injected into a facet isolate.
 *
 * wrangler bundles the supervisor with esbuild `keepNames`, which wraps every
 * named function and named arrow as `__name(fn, "fn")`. Code we ship into a
 * facet by `.toString()` therefore carries bare `__name` references, and the
 * supervisor's module-local binding does NOT cross the isolate boundary — the
 * facet must provide one or the embed dies with "__name is not defined".
 *
 * Assigned on `globalThis` rather than declared with `const` because these
 * injection sites do not own their scope: the pyodide asm.js inlined next to
 * it already declares `__name`/`__defProp` (a `const` would be "already
 * declared"), and the W7 facet frame evaluates the embed elsewhere. A bare
 * `__name` with no lexical binding resolves to the global either way, and the
 * `typeof` guard keeps it idempotent when several embeds share one isolate.
 *
 * Unit tests import the un-bundled TS source, so only the deployed,
 * esbuild-bundled worker ever needs this.
 */
export const ESBUILD_NAME_GLOBAL_SHIM = `if (typeof globalThis.__name !== "function") {
  globalThis.__name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });
}`;
