/**
 * Prefetch's import-detection view of a JavaScript source.
 *
 * `stripCommentsForImports(src)` walks `src` once and returns a
 * byte-aligned copy in which `//` and `/* … *\/` comments are blanked
 * (each comment becomes a space; newlines inside a block comment are
 * preserved so line numbers still match the input) and regex literals
 * are blanked. String and template literals are copied verbatim:
 * IMPORT_RE/REQUIRE_RE must see the specifier string, and a `//` or `/*`
 * inside a literal must NOT open a comment that swallows a following
 * real import.
 *
 * The output is assembled from input slices and joined once. It used to
 * be built one character at a time (`stripped += c`), which V8 keeps as
 * a rope of one node per append — ~30 bytes of heap per character, all
 * live until the string is first read. On typescript's 6.15 MB
 * `lib/_tsc.js` that rope measured 174 MB against a 128 MB isolate —
 * the session Durable Object was killed inside `tsc`'s spawn before the
 * facet existed. Spans hold the input, the output and a short array.
 */
export declare function stripCommentsForImports(src: string): string;
//# sourceMappingURL=comment-strip.d.ts.map