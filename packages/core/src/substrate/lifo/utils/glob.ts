import type { ProcessView } from '../../../runtime/process-files.js';
import { operandPath } from './path.js';
import { exists } from '../../../vfs/vfs.js';
import { decodeLossless, encodeLossless, firstLosslessByte } from './lossless-text.js';

/**
 * Match a glob pattern against a text string, as fnmatch(3) without flags:
 * `*`, `?`, `[abc]`, `[!a-z]` (`^` too; `]` first is literal), `\` quotes the
 * next character (a trailing one matches nothing), and a `[` with no closing
 * `]` is a literal `[`. Characters are code points, as in a UTF-8 locale: `?`
 * matches 😀 whole, and a range orders by code point.
 */
export function globMatch(pattern: string, text: string): boolean {
  return matchPattern(pattern, text, false);
}

/**
 * Match as bash's strmatch does (the shell's case, [[ ]], pathname expansion
 * and pattern operators): as globMatch, but a final backslash matches a
 * backslash (bash's sm_loop), where fnmatch(3)'s matches nothing.
 */
export function shellMatch(pattern: string, text: string): boolean {
  return matchPattern(pattern, text, true);
}

/**
 * The units a trim or a substitution of `value` by `pattern` works in, as
 * bash's: characters, or, when either holds a byte that is no character,
 * bytes. `pattern` and `value` are given in those units (a byte one string
 * character), `matches` is shellMatch of the pattern there, `encode` puts
 * other text (a replacement) in them, and `decode` gives a result back as
 * text, so a byte-wise cut never leaves half of a character's UTF-16.
 */
export interface ShellUnits {
  readonly pattern: string;
  readonly value: string;
  readonly matches: (text: string) => boolean;
  readonly encode: (text: string) => string;
  readonly decode: (units: string) => string;
}

export function shellUnits(pattern: string, value: string): ShellUnits {
  if ((!SURROGATE.test(value) || firstLosslessByte(value) === -1) && (!SURROGATE.test(pattern) || firstLosslessByte(pattern) === -1)) {
    return { pattern, value, matches: (text) => matchCharacters(pattern, text, true), encode: (text) => text, decode: (text) => text };
  }
  const bytes = byteString(pattern);
  return {
    pattern: bytes,
    value: byteString(value),
    matches: (text) => matchCharacters(bytes, text, true),
    encode: byteString,
    decode: (units) => {
      const out = new Uint8Array(units.length);
      for (let i = 0; i < units.length; i++) out[i] = units.charCodeAt(i);
      return decodeLossless(out);
    },
  };
}

/** How many UTF-16 units the character at index `i` of `s` takes: 2 for a surrogate pair, else 1. */
export function characterWidth(s: string, i: number): number {
  const high = s.charCodeAt(i);
  return high >= 0xd800 && high <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
}

/** Any surrogate: text with none is its UTF-16 units, character for character, and holds no lossless byte. */
const SURROGATE = /[\uD800-\uDFFF]/;

/** The character (code point) at UTF-16 index `i` of `s`: a surrogate pair whole, anything else one unit. */
export function characterAt(s: string, i: number): string {
  const high = s.charCodeAt(i);
  if (high >= 0xd800 && high <= 0xdbff && i + 1 < s.length) {
    const low = s.charCodeAt(i + 1);
    if (low >= 0xdc00 && low <= 0xdfff) return s.slice(i, i + 2);
  }
  return s.charAt(i);
}

/** The UTF-16 indices where `s`'s characters begin, and its length: every place a character boundary falls. */
export function characterBounds(s: string): number[] {
  const bounds: number[] = [];
  for (let i = 0; i < s.length; i += characterAt(s, i).length) bounds.push(i);
  bounds.push(s.length);
  return bounds;
}

/**
 * As bash's xstrmatch: by character, or, when the pattern or the text holds a
 * byte that is no character (lossless text keeps it as U+DC80 + byte), by
 * byte, both read as their UTF-8 bytes: a `?` is a byte, and a range orders
 * bytes ($'\200' is in [a-😀], whose 😀 is four bytes; z is in $'[a-\377]').
 */
function matchPattern(pattern: string, text: string, finalBackslash: boolean): boolean {
  if ((SURROGATE.test(text) && firstLosslessByte(text) !== -1) || (SURROGATE.test(pattern) && firstLosslessByte(pattern) !== -1)) {
    return matchCharacters(byteString(pattern), byteString(text), finalBackslash);
  }
  return matchCharacters(pattern, text, finalBackslash);
}

/** `text`'s bytes, each one character of a string. */
function byteString(text: string): string {
  let out = '';
  for (const byte of encodeLossless(text)) out += String.fromCharCode(byte);
  return out;
}

function matchCharacters(pattern: string, text: string, finalBackslash: boolean): boolean {
  let pi = 0;
  let ti = 0;
  let starPi = -1;
  let starTi = -1;
  while (ti < text.length) {
    if (pi < pattern.length && pattern[pi] === '*') {
      starPi = pi++;
      starTi = ti;
      continue;
    }
    const width = characterWidth(text, ti);
    const ch = width === 1 ? text.charAt(ti) : text.slice(ti, ti + 2);
    const next = pi < pattern.length ? matchOne(pattern, pi, ch, finalBackslash) : -1;
    if (next >= 0) {
      pi = next;
      ti += ch.length;
      continue;
    }
    if (starPi < 0) return false;
    pi = starPi + 1;
    starTi += characterWidth(text, starTi);
    ti = starTi;
  }
  while (pi < pattern.length && pattern[pi] === '*') pi++;
  return pi === pattern.length;
}

/** Where the pattern continues after its token at `pi` matched the character `ch`, or -1. */
function matchOne(pattern: string, pi: number, ch: string, finalBackslash: boolean): number {
  const c = characterWidth(pattern, pi) === 1 ? pattern.charAt(pi) : pattern.slice(pi, pi + 2);
  if (c === '?') return pi + 1;
  if (c === '\\') {
    // A trailing backslash quotes nothing: it matches nothing (glibc), or itself (bash).
    if (pi + 1 >= pattern.length) return finalBackslash && ch === '\\' ? pi + 1 : -1;
    const quoted = characterAt(pattern, pi + 1);
    return quoted === ch ? pi + 1 + quoted.length : -1;
  }
  if (c === '[') {
    const cls = matchCharClass(pattern, pi, ch);
    if (cls !== null) return cls.matched ? cls.end : -1;
  }
  return c === ch ? pi + c.length : -1;
}

/** A bracket expression's member at `i`: its character, backslash-quoted or not, and where it ends. */
function classMember(pattern: string, i: number): { char: string; end: number } {
  if (pattern[i] === '\\' && i + 1 < pattern.length) {
    const char = characterAt(pattern, i + 1);
    return { char, end: i + 1 + char.length };
  }
  const char = characterAt(pattern, i);
  return { char, end: i + char.length };
}

/** A bracket expression at `pos`: whether it matches `ch` and where it ends; null when it never closes. */
function matchCharClass(pattern: string, pos: number, ch: string): { matched: boolean; end: number } | null {
  let i = pos + 1;
  let negate = false;
  if (i < pattern.length && (pattern[i] === '!' || pattern[i] === '^')) {
    negate = true;
    i++;
  }
  let matched = false;
  const start = i;
  const code = ch.codePointAt(0) ?? 0;
  while (i < pattern.length && (pattern[i] !== ']' || i === start)) {
    const lo = classMember(pattern, i);
    if (lo.end + 1 < pattern.length && pattern[lo.end] === '-' && pattern[lo.end + 1] !== ']') {
      const hi = classMember(pattern, lo.end + 1);
      // A range orders by code point (by byte, in byte matching).
      if (code >= (lo.char.codePointAt(0) ?? 0) && code <= (hi.char.codePointAt(0) ?? 0)) matched = true;
      i = hi.end;
    } else {
      if (ch === lo.char) matched = true;
      i = lo.end;
    }
  }
  if (i >= pattern.length) return null;
  return { matched: negate ? !matched : matched, end: i + 1 };
}

/**
 * Expand a field against the VFS: `pattern` is the field as globMatch reads it
 * (its quoted characters escaped), `text` the field itself. Returns the sorted
 * matching paths, or [text] when the pattern has no unescaped glob character
 * or nothing matches.
 */
export async function expandGlob(pattern: string, text: string, cwd: string, vfs: ProcessView): Promise<string[]> {
  if (!hasUnescapedGlob(pattern)) {
    return [text];
  }

  // The working directory's name matches only itself: escaped, as the pattern's quoted characters are.
  const absPattern = pattern.startsWith('/') ? pattern : operandPath(escapeGlob(cwd), pattern);
  const parts = absPattern.split('/').filter(Boolean);
  const isAbsolute = pattern.startsWith('/');

  let candidates = ['/'];

  for (const part of parts) {
    const nextCandidates: string[] = [];

    if (!hasUnescapedGlob(part)) {
      // Literal path segment
      const name = unescapeGlob(part);
      for (const dir of candidates) {
        const full = dir === '/' ? `/${name}` : `${dir}/${name}`;
        if (await vfs.exists(full)) {
          nextCandidates.push(full);
        }
      }
    } else {
      // Glob segment -- match against directory entries
      for (const dir of candidates) {
        try {
          const entries = await vfs.readdir(dir);
          for (const entry of entries) {
            if (shellMatch(part, entry.name)) {
              const full = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
              nextCandidates.push(full);
            }
          }
        } catch {
          // dir doesn't exist or isn't a directory
        }
      }
    }

    candidates = nextCandidates;
  }

  if (candidates.length === 0) {
    return [text]; // no matches: the field as it is
  }

  // Convert back to relative paths if pattern was relative
  let results: string[];
  if (isAbsolute) {
    results = candidates;
  } else {
    const prefix = cwd === '/' ? '/' : cwd + '/';
    results = candidates.map((c) => {
      if (c.startsWith(prefix)) {
        return c.slice(prefix.length);
      }
      return c;
    });
  }

  return results.sort();
}

/**
 * How many characters `pattern` matches when that is fixed (no `*` in it), as
 * bash's umatchlen: each `?`, character, backslash-quoted character or bracket
 * expression is one. Null when it varies.
 */
export function fixedMatchLength(pattern: string): number | null {
  let length = 0;
  for (let i = 0; i < pattern.length; length++) {
    const c = pattern[i];
    if (c === '*') return null;
    if (c === '\\' && i + 1 < pattern.length) i += 1 + characterAt(pattern, i + 1).length;
    else if (c === '[') i = classEnd(pattern, i) ?? i + 1;
    else i += characterAt(pattern, i).length;
  }
  return length;
}

/** Where the bracket expression at `pos` ends, just past its `]`, or null when it never closes (as matchCharClass reads it). */
function classEnd(pattern: string, pos: number): number | null {
  let i = pos + 1;
  if (pattern[i] === '!' || pattern[i] === '^') i++;
  const start = i;
  while (i < pattern.length && (pattern[i] !== ']' || i === start)) i = classMember(pattern, i).end;
  return i < pattern.length ? i + 1 : null;
}

/** Whether `s` holds a glob's special characters (`*`, `?`, `[`). */
export function hasGlobChars(s: string): boolean {
  return s.includes('*') || s.includes('?') || s.includes('[');
}

/**
 * `text` as a pattern that matches only itself: each character globMatch reads
 * specially quoted with a backslash, a bracket expression's `-`, `!` and `^`
 * too (`[a$'-'z]` holds a, - and z).
 */
export function escapeGlob(text: string): string {
  return text.replace(/[\\*?[\]\-!^]/g, '\\$&');
}

/** Whether pattern `s` holds a glob character no backslash quotes. */
function hasUnescapedGlob(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '*' || s[i] === '?' || s[i] === '[') return true;
  }
  return false;
}

/** Pattern `s` with its backslash quoting removed: the name it matches when it has no glob character. */
function unescapeGlob(s: string): string {
  return s.replace(/\\(.)/gs, '$1');
}
