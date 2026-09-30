/**
 * Decode one JavaScript StringLiteral without compiling code. es-module-lexer
 * uses indirect eval to decode quoted import/export names, swallowing errors;
 * Workers refuses that eval, even for a literal, so every name became undefined
 * and Vite mistook static imports for unanalyzable dynamic imports.
 *
 * This is data decoding, not an evaluator: whitespace plus exactly one quoted
 * string, no templates, expressions, comments, statements or calls. Undefined
 * means it is not such a literal; the caller must preserve native eval's answer
 * (including its refusal) in that case. Indirect eval is non-strict, so legacy
 * octal and non-octal decimal escapes are accepted like Node's indirect eval.
 * Self-contained because generateShimsCode embeds this function's source.
 */
export declare function decodeJavaScriptStringLiteral(source: string): string | undefined;
//# sourceMappingURL=javascript-string-literal.d.ts.map