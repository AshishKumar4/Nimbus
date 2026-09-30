/**
 * Source of a function that decodes one JavaScript StringLiteral without
 * compiling code. es-module-lexer uses indirect eval to decode quoted
 * import/export names, swallowing errors; Workers refuses that eval, even for
 * a literal, so every name became undefined and Vite mistook static imports for
 * unanalyzable dynamic imports.
 *
 * This is data decoding, not an evaluator: whitespace plus exactly one quoted
 * string, no templates, expressions, comments, statements or calls. Undefined
 * means it is not such a literal; the caller must preserve native eval's answer
 * (including its refusal) in that case. Indirect eval is non-strict, so legacy
 * octal and non-octal decimal escapes are accepted like Node's indirect eval.
 *
 * generateShimsCode embeds this text once. It is a string, not a function's
 * toString(): tsc and bun print function source differently, which made the
 * staged shims differ from the source they were built from.
 */
export declare const DECODE_JAVASCRIPT_STRING_LITERAL_SOURCE: string;
//# sourceMappingURL=javascript-string-literal.d.ts.map