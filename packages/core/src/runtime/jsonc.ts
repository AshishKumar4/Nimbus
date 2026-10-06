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

const LINE_END: Record<JsoncDialect, RegExp> = {
  tsconfck: /\n/,
  esbuild: /[\n\r\u2028\u2029]/,
};

/** `text` as JSON for JSON.parse: comments and dangling commas gone. */
export function jsoncToJson(text: string, dialect: JsoncDialect): string {
  const lineEnd = LINE_END[dialect];
  const blank = dialect === 'tsconfck' ? (comment: string) => comment.replace(/\S/g, ' ') : () => ' ';
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      const start = i;
      for (i++; i < source.length && source[i] !== '"'; i++) if (source[i] === '\\') i++;
      out += source.slice(start, i + 1);
    } else if (c === '/' && source[i + 1] === '/') {
      let end = i;
      while (end < source.length && !lineEnd.test(source[end])) end++;
      out += blank(source.slice(i, end));
      i = end - 1;
    } else if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close < 0 && dialect === 'esbuild') throw new Error('Expected "*/" to terminate multi-line comment');
      const end = close < 0 ? source.length : close + 2;
      out += blank(source.slice(i, end));
      i = end - 1;
    } else {
      out += dialect === 'esbuild' && lineEnd.test(c) ? '\n' : c;
    }
  }
  // A comma before a closing bracket, outside strings: find them in the text
  // with its strings blanked, then drop them from the real text.
  const blanked = out.replace(/"(?:[^"\\]|\\.)*"/g, (s) => '"' + ' '.repeat(s.length - 2) + '"');
  let result = '';
  for (let i = 0; i < out.length; i++) {
    if (blanked[i] === ',') {
      let next = i + 1;
      while (next < blanked.length && /\s/.test(blanked[next])) next++;
      if (blanked[next] === '}' || blanked[next] === ']') continue;
    }
    result += out[i];
  }
  return result;
}
