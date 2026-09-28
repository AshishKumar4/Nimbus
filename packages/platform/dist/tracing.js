/**
 * tracing.ts — Workers custom spans, for modules that cannot import
 * `cloudflare:workers`, as best-effort telemetry that never changes an
 * outcome.
 *
 * The span API is `tracing` from `cloudflare:workers`
 * (https://developers.cloudflare.com/workers/observability/traces/custom-spans/):
 * `enterSpan(name, callback)` runs the callback in a span that is the active
 * parent of every span and platform call made inside it — automatic RPC
 * spans included — and ends it when the callback returns or its promise
 * settles. A span records nothing unless the invocation was head-sampled
 * (`observability.traces.head_sampling_rate`).
 *
 * `setAttributes` and `recordException` shipped on 2026-09-25
 * (https://developers.cloudflare.com/changelog/post/2026-09-25-custom-span-apis/);
 * a runtime from before then has `isTraced` and `setAttribute` only. So the
 * code being traced never touches the runtime's span. It gets a
 * {@link SpanRecorder}, which records only while the span is traced, uses
 * whichever methods the runtime has, and swallows anything a span method
 * throws.
 *
 * Core and fabric stay importable outside workerd, so they reach the API
 * through this leaf: the Worker's composition root hands it over once, at
 * module scope, with {@link adoptTracing}, exactly as it does `ctx.exports`
 * (./composition.ts). With nothing adopted — unit tests, an embedder that
 * never adopts — {@link traced} runs its callback with {@link untraced}.
 */
/** The recorder of a span that is not traced, or of no span at all. */
export const untraced = Object.freeze({ set() { }, exception() { } });
let tracer = null;
/** Hand this isolate's `tracing` over. The first adoption stands, like `adoptCtxExports`. */
export function adoptTracing(value) {
    tracer ??= value;
}
function recorderFor(span) {
    try {
        if (!span.isTraced)
            return untraced;
    }
    catch {
        return untraced;
    }
    return {
        set(attributes) {
            try {
                if (typeof span.setAttributes === 'function') {
                    span.setAttributes(attributes);
                }
                else if (typeof span.setAttribute === 'function') {
                    for (const [key, value] of Object.entries(attributes)) {
                        if (value !== undefined)
                            span.setAttribute(key, value);
                    }
                }
            }
            catch { /* telemetry is best-effort */ }
        },
        exception(error, code, context = '') {
            try {
                if (typeof span.recordException !== 'function')
                    return;
                if (error instanceof Error) {
                    const own = 'code' in error ? error.code : undefined;
                    span.recordException({
                        code: code ?? (typeof own === 'string' || typeof own === 'number' ? own : undefined),
                        name: error.name,
                        message: context + error.message,
                        stack: error.stack,
                    });
                }
                else {
                    span.recordException(code === undefined && !context
                        ? String(error)
                        : { code, message: context + String(error) });
                }
            }
            catch { /* telemetry is best-effort */ }
        },
    };
}
/**
 * Run `fn` in a span named `name` carrying `attributes`, and record on it the
 * exception `fn` throws or its promise rejects with. What `fn` returns or
 * throws reaches the caller unchanged, whatever the span does.
 */
export function traced(name, attributes, fn) {
    if (!tracer)
        return fn(untraced);
    return tracer.enterSpan(name, (runtimeSpan) => {
        const span = recorderFor(runtimeSpan);
        span.set(attributes);
        let result;
        try {
            result = fn(span);
        }
        catch (error) {
            span.exception(error);
            throw error;
        }
        if (!(result instanceof Promise))
            return result;
        return result.catch((error) => {
            span.exception(error);
            throw error;
        });
    });
}
