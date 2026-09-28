// The custom-span methods Cloudflare shipped on 2026-09-25
// (https://developers.cloudflare.com/changelog/post/2026-09-25-custom-span-apis/,
// typed in full at https://developers.cloudflare.com/workers/observability/traces/custom-spans/#typescript-types),
// missing from the pinned @cloudflare/workers-types 4.20260605.1, whose
// `Span` has only `isTraced` and `setAttribute`. Merges into that ambient
// class. Delete once the pinned types declare them.
interface Span {
  setAttributes(attributes: Record<string, string | number | boolean | undefined>): this;
  recordException(
    exception: string | { code?: string | number; name?: string; message?: string; stack?: string },
  ): void;
}
