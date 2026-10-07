/**
 * The import-detection view of a JavaScript source: one lexer, read in two
 * dialects.
 *
 * `stripCommentsForImports(src)` is the require walk's (prefetch) view: it
 * walks `src` once and returns a copy in which `//` and `/* … *\/` comments
 * are blanked (each comment becomes a space; newlines inside a block comment
 * are preserved so line numbers still match the input) and regex literals
 * are blanked. String and template literals are copied verbatim:
 * IMPORT_RE/REQUIRE_RE must see the specifier string, and a `//` or `/*`
 * inside a literal must NOT open a comment that swallows a following real
 * import. A `/` is a regex unless the last non-blank character ends a
 * value (tests/unit/comment-strip-bounded.mjs pins this byte for byte).
 *
 * `maskSourceForImports(src, path)` is a project source file's view, which
 * the pre-bundle's project scan and a barrel's slice read: the same lexer,
 * reading a keyword that precedes an expression (`return`, `default`, …)
 * as starting one, and, outside TypeScript files, JSX. In valid JavaScript
 * a `<` never starts an expression, so one that does is a JSX element: its
 * tags and text are blanked (a closing tag's slash is no regex, an
 * apostrophe in text opens no string, a URL in text opens no comment) and
 * its `{…}` expressions are lexed as code again. A TypeScript generic
 * arrow's `<T,>` / `<T extends U>`, and in a TSX file a generic function
 * type's `<T>(…) =>`, is not an element. A `<` the lexer can neither close
 * as an element nor read as one of those is a construct it cannot decide:
 * it throws UndecidableSourceError, and the caller reads that file with a
 * parser instead. It never guesses on.
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
/**
 * A project source file's import-detection view (see the module comment);
 * `path` decides the language: TypeScript (`.ts`, no JSX), TSX, or
 * JavaScript with JSX. Throws UndecidableSourceError for a construct the
 * lexer cannot decide.
 */
export declare function maskSourceForImports(src: string, path: string): string;
/** A `<` the import lexer can neither close as a JSX element nor read as type parameters. */
export declare class UndecidableSourceError extends Error {
    readonly offset: number;
    constructor(offset: number);
}
/**
 * Every specifier `code` names after `from`, `import` or `import(`, as
 * written, in order: the one grammar the project scan
 * (barrel-synthesizer scanProjectImports) and a barrel's scoped slice read
 * module edges with. `code` is a masked view (maskSourceForImports), so an
 * import commented out names nothing; a caller keeps the bare or relative
 * ones it wants.
 */
export declare function importedSpecifiers(code: string): string[];
//# sourceMappingURL=comment-strip.d.ts.map