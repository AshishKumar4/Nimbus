/**
 * Words quoted for a POSIX shell, in the two forms Nimbus writes: always
 * single-quoted (a command line built to be run), and as GNU coreutils
 * quotes a word to be read back (printf %q, and the names in coreutils'
 * messages).
 */

/** `value` single-quoted, every `'` in it written `'\''`: one word to any POSIX shell. */
export function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The escapes a `$'...'` piece writes control characters with; others are three octal digits. */
const CONTROL_ESCAPES: Readonly<Record<number, string>> = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r' };

/**
 * `value` as gnulib's quotearg shell-escape style writes it, which is what
 * coreutils' printf %q prints and how its messages name a file: bare when
 * no character is special to a shell (`#` and `~` only at the start, `{`
 * and `}` only alone); else double-quoted when it holds a `'` and nothing
 * special inside double quotes; else single-quoted, with control
 * characters as `$'\n'` pieces between single-quoted runs.
 */
export function shellEscape(value: string): string {
  const control = /[\x00-\x1f\x7f]/.test(value);
  if (!control && value !== '' && value !== '{' && value !== '}'
    && !/[ !"$&'()*;<=>?[\\^`|]/.test(value) && !/^[#~]/.test(value)) return value;
  if (!control) {
    return value.includes("'") && !/[$`"\\!]/.test(value) ? `"${value}"` : singleQuote(value);
  }
  let out = "'";
  let inEscape = false;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      if (!inEscape) out += "'$'";
      inEscape = true;
      out += `\\${CONTROL_ESCAPES[code] ?? code.toString(8).padStart(3, '0')}`;
    } else {
      if (inEscape) out += "''";
      inEscape = false;
      out += ch === "'" ? "'\\''" : ch;
    }
  }
  return `${out}'`;
}
