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
export function derived(watermark, build) {
    let key;
    let value;
    let has = false;
    return {
        get(context) {
            const next = watermark(context);
            if (has && next === key)
                return value;
            value = build(context, next);
            key = next;
            has = true;
            return value;
        },
        invalidate() {
            has = false;
            value = undefined;
        },
    };
}
export function derivedAsync(watermark, build) {
    let key;
    let value;
    let has = false;
    return {
        async get(context) {
            let next;
            try {
                next = await watermark(context);
            }
            catch (e) {
                if (has)
                    return value;
                throw e;
            }
            if (has && next === key)
                return value;
            let built;
            try {
                built = await build(context, next);
            }
            catch (e) {
                if (has)
                    return value;
                throw e;
            }
            value = built;
            key = next;
            has = true;
            return built;
        },
        invalidate() {
            has = false;
            value = undefined;
        },
    };
}
