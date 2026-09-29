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
export function decodeJavaScriptStringLiteral(source: string): string | undefined {
  const text = source.trim();
  const quote = text[0];
  if ((quote !== '"' && quote !== "'") || text.length < 2) return undefined;
  let result = '';
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === quote) return i === text.length - 1 ? result : undefined;
    if (c === '\n' || c === '\r') return undefined;
    if (c !== '\\') { result += c; continue; }
    if (++i >= text.length) return undefined;
    const escaped = text[i];
    switch (escaped) {
      case 'n': result += '\n'; break;
      case 'r': result += '\r'; break;
      case 't': result += '\t'; break;
      case 'b': result += '\b'; break;
      case 'f': result += '\f'; break;
      case 'v': result += '\v'; break;
      case '\r': if (text[i + 1] === '\n') i++; break;
      case '\n': case '\u2028': case '\u2029': break;
      case 'x': case 'u': {
        const braced = escaped === 'u' && text[i + 1] === '{';
        const start = i + (braced ? 2 : 1);
        const end = braced ? text.indexOf('}', start) : start + (escaped === 'x' ? 2 : 4);
        if (end <= start || end > text.length) return undefined;
        const digits = text.slice(start, end);
        if (!/^[0-9a-fA-F]+$/.test(digits)) return undefined;
        const point = Number.parseInt(digits, 16);
        if (point > 0x10ffff) return undefined;
        result += String.fromCodePoint(point);
        i = braced ? end : end - 1;
        break;
      }
      default: {
        if (escaped >= '0' && escaped <= '7') {
          // 0..3 consumes up to three octal digits; 4..7 only two.
          const end = Math.min(text.length, i + (escaped <= '3' ? 3 : 2));
          let octal = escaped;
          while (i + 1 < end && text[i + 1] >= '0' && text[i + 1] <= '7') octal += text[++i];
          result += String.fromCharCode(Number.parseInt(octal, 8));
        } else result += escaped;
      }
    }
  }
  return undefined;
}
