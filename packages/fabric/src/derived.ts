/**
 * derived.ts — a watermark memo: derive a cheap key, compare, rebuild only
 * on change.
 *
 * Proteus's ActorAgent hand-rolls this pair five times — cached value plus
 * cached key, compared and rebuilt inline: the system prompt (key composed
 * from soul text, executors, model, tools, stance), the tool set (keyed
 * partly on `_craftCacheKey()`, two synchronous SQLite aggregates), the MCP
 * tool surface (keyed on UserDO's `mcp_updated_at`), and the SOUL text
 * (no key at all — push-invalidated by `setSoul`). One mechanism, five
 * copies, each with its own field pair to keep coherent.
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

export interface Derived<T> {
  get(): T;
  /** Force the next get to rebuild, watermark unchanged. */
  invalidate(): void;
}

export function derived<T>(watermark: () => string | number, build: () => T): Derived<T> {
  let key: string | number | undefined;
  let value: T | undefined;
  let has = false;
  return {
    get(): T {
      const next = watermark();
      if (has && next === key) return value as T;
      value = build();
      key = next;
      has = true;
      return value;
    },
    invalidate(): void {
      has = false;
      value = undefined;
    },
  };
}

export interface DerivedAsync<T> {
  get(): Promise<T>;
  invalidate(): void;
}

export function derivedAsync<T>(
  watermark: () => Promise<string | number>,
  build: () => Promise<T>,
): DerivedAsync<T> {
  let key: string | number | undefined;
  let value: T | undefined;
  let has = false;
  return {
    async get(): Promise<T> {
      let next: string | number;
      try {
        next = await watermark();
      } catch (e) {
        if (has) return value as T;
        throw e;
      }
      if (has && next === key) return value as T;
      let built: T;
      try {
        built = await build();
      } catch (e) {
        if (has) return value as T;
        throw e;
      }
      value = built;
      key = next;
      has = true;
      return built;
    },
    invalidate(): void {
      has = false;
      value = undefined;
    },
  };
}
