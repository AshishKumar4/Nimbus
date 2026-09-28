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
/** Attribute values a span holds; `undefined` entries are ignored. */
export type SpanAttributes = Record<string, string | number | boolean | undefined>;
/** The runtime's `Span`, as any Workers runtime with `tracing` may have it. */
export interface RuntimeSpan {
    readonly isTraced: boolean;
    setAttribute?(key: string, value?: string | number | boolean): unknown;
    setAttributes?(attributes: SpanAttributes): unknown;
    recordException?(exception: string | {
        code?: string | number;
        name?: string;
        message?: string;
        stack?: string;
    }): void;
}
/** The part of `cloudflare:workers`'s `tracing` Nimbus uses. */
export interface Tracer {
    enterSpan<T>(name: string, callback: (span: RuntimeSpan) => T): T;
}
/** What traced code records on its span. Never throws; records nothing unless the span is traced. */
export interface SpanRecorder {
    set(attributes: SpanAttributes): void;
    /**
     * Record `error` as an exception event. `code`, when given, replaces the
     * error's own; `context` is prefixed to its message.
     */
    exception(error: unknown, code?: string, context?: string): void;
}
/** The recorder of a span that is not traced, or of no span at all. */
export declare const untraced: SpanRecorder;
/** Hand this isolate's `tracing` over. The first adoption stands, like `adoptCtxExports`. */
export declare function adoptTracing(value: Tracer): void;
/**
 * Run `fn` in a span named `name` carrying `attributes`, and record on it the
 * exception `fn` throws or its promise rejects with. What `fn` returns or
 * throws reaches the caller unchanged, whatever the span does.
 */
export declare function traced<T>(name: string, attributes: SpanAttributes, fn: (span: SpanRecorder) => T): T;
//# sourceMappingURL=tracing.d.ts.map