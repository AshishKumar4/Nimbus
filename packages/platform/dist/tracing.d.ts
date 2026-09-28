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
/** Attribute values a span holds; `undefined` entries are ignored by the runtime. */
export type SpanAttributes = Record<string, string | number | boolean | undefined>;
/** What `span.recordException` accepts: a message, or an error's parts. */
export type SpanException = string | {
    code?: string | number;
    name?: string;
    message?: string;
    stack?: string;
};
/** The part of the runtime's `Span` Nimbus uses. */
export interface TraceSpan {
    readonly isTraced: boolean;
    setAttributes(attributes: SpanAttributes): unknown;
    recordException(exception: SpanException): void;
}
/** The part of `cloudflare:workers`'s `tracing` Nimbus uses. */
export interface Tracer {
    enterSpan<T>(name: string, callback: (span: TraceSpan) => T): T;
}
/** Hand this isolate's `tracing` over. The first adoption stands, like `adoptCtxExports`. */
export declare function adoptTracing(value: Tracer): void;
/**
 * `error` as a span exception. Every exception carries the parts the
 * runtime records, `code` included: the errno a callee answered with
 * (ESTALE, EIO) or the platform class a caller gave a failed attempt.
 */
export declare function spanException(error: unknown, code?: string): SpanException;
/**
 * Run `fn` in a span named `name` carrying `attributes`, and record on it the
 * exception `fn` throws or its promise rejects with, which still reaches the
 * caller unchanged. Without an adopted tracer, `fn` runs with no span.
 */
export declare function traced<T>(name: string, attributes: SpanAttributes, fn: (span: TraceSpan | undefined) => T): T;
//# sourceMappingURL=tracing.d.ts.map