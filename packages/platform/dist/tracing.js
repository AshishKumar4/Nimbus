/**
 * tracing.ts — Workers custom spans, for modules that cannot import
 * `cloudflare:workers`.
 *
 * The span API is `tracing` from `cloudflare:workers`
 * (https://developers.cloudflare.com/workers/observability/traces/custom-spans/):
 * `enterSpan(name, callback)` runs the callback in a span that is the active
 * parent of every span and platform call made inside it — automatic RPC
 * spans included — and ends it when the callback returns or its promise
 * settles. A span records nothing unless the invocation was head-sampled
 * (`observability.traces.head_sampling_rate`), so an unsampled call pays for
 * the callback frame and nothing else.
 *
 * Core and fabric stay importable outside workerd, so they reach the API
 * through this leaf: the Worker's composition root hands it over once, at
 * module scope, with {@link adoptTracing}, exactly as it does `ctx.exports`
 * (./composition.ts). With nothing adopted — unit tests, an embedder that
 * never adopts — {@link traced} runs its callback with no span.
 */
let tracer = null;
/** Hand this isolate's `tracing` over. The first adoption stands, like `adoptCtxExports`. */
export function adoptTracing(value) {
    tracer ??= value;
}
/**
 * `error` as a span exception. Every exception carries the parts the
 * runtime records, `code` included: the errno a callee answered with
 * (ESTALE, EIO) or the platform class a caller gave a failed attempt.
 */
export function spanException(error, code) {
    if (error instanceof Error) {
        const own = 'code' in error ? error.code : undefined;
        return {
            code: code ?? (typeof own === 'string' || typeof own === 'number' ? own : undefined),
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }
    return code === undefined ? String(error) : { code, message: String(error) };
}
/**
 * Run `fn` in a span named `name` carrying `attributes`, and record on it the
 * exception `fn` throws or its promise rejects with, which still reaches the
 * caller unchanged. Without an adopted tracer, `fn` runs with no span.
 */
export function traced(name, attributes, fn) {
    if (!tracer)
        return fn(undefined);
    return tracer.enterSpan(name, (span) => {
        if (span.isTraced)
            span.setAttributes(attributes);
        const failed = (error) => {
            span.recordException(spanException(error));
            throw error;
        };
        let result;
        try {
            result = fn(span);
        }
        catch (error) {
            return failed(error);
        }
        return (result instanceof Promise ? result.catch(failed) : result);
    });
}
