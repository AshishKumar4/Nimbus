/**
 * JSON with comments, as the two tools Nimbus mirrors read a tsconfig.
 *
 * tsconfck (Vite's tsconfig loader) and esbuild (a `tsconfigRaw` string)
 * both drop a leading byte-order mark, `//` and block comments, and a comma
 * before a closing bracket, and walk strings so none of those is looked for
 * inside one. They differ in two places, which the dialect names:
 *
 * - `tsconfck` ends a `//` comment at a line feed only, runs an open block
 *   comment to the end of the text, and blanks a comment's characters
 *   rather than dropping them, so whitespace JSON does not allow (U+2028,
 *   a BOM) inside one still fails the parse;
 * - `esbuild` ends a `//` comment at any line terminator, reads one between
 *   tokens as whitespace, and refuses an open block comment in its words.
 */
export type JsoncDialect = 'tsconfck' | 'esbuild';
/** `text` as JSON for JSON.parse: comments and dangling commas gone. */
export declare function jsoncToJson(text: string, dialect: JsoncDialect): string;
/** A JSON object: not null, not an array. */
export declare function isJsonRecord(value: unknown): value is Record<string, unknown>;
//# sourceMappingURL=jsonc.d.ts.map