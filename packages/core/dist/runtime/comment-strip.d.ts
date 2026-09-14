/**
 * One JavaScript source scanner shared by the two comment-stripping
 * call sites — prefetch's import detection and the esbuild transform
 * pipeline's classifiers.
 *
 * `scanJsSource(src, literals)` walks `src` once and returns a
 * byte-aligned copy in which `//` and `/* … *\/` comments are blanked
 * (each comment becomes a space; newlines inside a block comment are
 * preserved so line numbers still match the input). String, template
 * and regex literals are what `literals` decides:
 *
 *   - `'blank'`: literal content is replaced too — templates keep their
 *     `${…}` interpolation expression as code so a depth-tracked caller
 *     sees `await` etc. inside it. This is the transform pipeline's
 *     classification view: nothing quoted can read as an `import`.
 *   - `'keep'`: literals are copied verbatim. This is prefetch's
 *     import-detection view: IMPORT_RE/REQUIRE_RE must see the
 *     specifier string, and a `//` or `/*` inside a literal must NOT
 *     open a comment that swallows a following real import.
 *
 * The output is assembled from input slices and joined once. It used to
 * be built one character at a time (`stripped += c`), which V8 keeps as
 * a rope of one node per append — ~30 bytes of heap per character, all
 * live until the string is first read. On typescript's 6.15 MB
 * `lib/_tsc.js` that rope measured 174 MB against a 128 MB isolate —
 * the session Durable Object was killed inside `tsc`'s spawn before the
 * facet existed. Spans hold the input, the output and a short array.
 *
 * Serialized by name: `generateEsbuildTransformRuntimeSource` embeds
 * this function's `.toString()` in the transform runtime, so every
 * constant it reads is declared inside the body.
 */
export declare function scanJsSource(src: string, literals: 'keep' | 'blank'): string;
/**
 * Strip comments for import/require detection. Literals are kept: the
 * specifier the regexes extract lives inside a string, and a comment
 * marker inside a string must not swallow the code that follows it.
 */
export declare function stripCommentsForImports(src: string): string;
//# sourceMappingURL=comment-strip.d.ts.map