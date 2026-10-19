/**
 * POSIX regular expressions (basic and extended, with GNU's extensions) as
 * JavaScript regex source for the `u` flag, over text held losslessly
 * (bytes-io.ts): a byte that is not valid UTF-8 is U+DC80 + byte, and
 * neither `.` nor a negated bracket matches it, as GNU's matchers do not
 * match an encoding error. Used by grep and sed, and by the shell's
 * `[[ =~ ]]`, which reads an ERE as glibc's regcomp does (`regcomp`).
 */

export class PosixRegexSyntax extends Error {}

export interface TranslateOptions {
  /** ERE (-E) rather than BRE. */
  extended: boolean;
  /** sed's escapes: \n newline, \t tab, \xHH a byte. */
  sed?: boolean;
  /**
   * glibc's regcomp(REG_EXTENDED), as bash's `[[ =~ ]]` compiles: an
   * operator with nothing to apply to, an interval that is none, a second
   * dash after a range, and a back reference to a group not yet closed are
   * errors (grep takes the first two literally), and a range orders code
   * points.
   */
  regcomp?: boolean;
}

/** A translated expression: its JavaScript source, how many groups it has, and whether one start can match ends JavaScript's greedy choice does not reach (`ambiguous`: an alternation, a quantified group, a back reference). */
export interface Translation {
  source: string;
  groups: number;
  ambiguous: boolean;
}

/** An invalid byte, as the lossless decoding holds it. */
const INVALID_BYTES = '\\udc80-\\udcff';

export const WORD = '[\\p{L}\\p{N}_]';
export const NOT_WORD = '[^\\p{L}\\p{N}_]';

const CLASSES: Readonly<Record<string, string>> = {
  alpha: '\\p{L}', digit: '0-9', alnum: '\\p{L}\\p{Nd}', upper: '\\p{Lu}', lower: '\\p{Ll}',
  space: '\\s', blank: ' \\t', punct: '\\p{P}\\p{S}', print: '\\P{C}', graph: '\\p{L}\\p{M}\\p{N}\\p{P}\\p{S}',
  cntrl: '\\p{Cc}', xdigit: '0-9A-Fa-f',
};

/** A character as a literal in a JavaScript `u` pattern; `-` is escaped only in a class. */
export function literal(ch: string, inClass = false): string {
  if (ch === '-') return inClass ? '\\-' : '-';
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

const collator = new Intl.Collator('en-US', { caseFirst: 'lower' });
const rangeMembers = new Map<string, string>();

/**
 * glibc's regex (sed's) takes a range between two letters by collation, in
 * en_US.UTF-8: `[a-z]` holds the lowercase letters that collate from a to z
 * (é, ß, ø, but not ž, which follows z, nor É). GNU grep's own
 * matcher keeps ranges to their code points.
 */
function collatedRange(lo: string, hi: string): string {
  const key = lo + hi;
  let members = rangeMembers.get(key);
  if (members === undefined) {
    const upper = lo >= 'A' && lo <= 'Z';
    members = '';
    for (const [from, to] of [[0xc0, 0x24f], [0x1e00, 0x1eff]]) {
      for (let cp = from; cp <= to; cp++) {
        const c = String.fromCodePoint(cp);
        if (!(upper ? /\p{Lu}/u : /\p{Ll}/u).test(c)) continue;
        if (collator.compare(lo, c) <= 0 && collator.compare(c, hi) <= 0) members += c;
      }
    }
    rangeMembers.set(key, members);
  }
  return members;
}

/**
 * A bracket expression's member at `i`: a character (a backslash is one) or
 * a collating symbol naming one, which may end a range; or an equivalence
 * class or a named class, which may not. regcomp, as glibc's under C.UTF-8,
 * takes only an ASCII character's symbol or equivalence class (the other
 * dialects take each character of a longer one).
 */
function bracketMember(p: string, i: number, regcomp: boolean): { char: string; end: number } | { members: string; end: number } {
  const kind = p[i] === '[' ? p[i + 1] : undefined;
  if (kind === ':' || kind === '=' || kind === '.') {
    const close = p.indexOf(`${kind}]`, i + 2);
    if (close === -1) throw new PosixRegexSyntax('Unmatched [, [^, [:, [., or [=');
    const name = p.slice(i + 2, close);
    const end = close + 2;
    if (kind === ':') {
      const cls = Object.hasOwn(CLASSES, name) ? CLASSES[name] : undefined;
      if (cls === undefined) throw new PosixRegexSyntax('Invalid character class name');
      return { members: cls, end };
    }
    if (regcomp && !/^[\0-\x7f]$/.test(name)) throw new PosixRegexSyntax('Invalid collation character');
    const chars = [...name];
    const [only] = chars;
    if (kind === '.' && chars.length === 1 && only !== undefined) return { char: only, end };
    return { members: chars.map((c) => literal(c, true)).join(''), end };
  }
  const char = String.fromCodePoint(p.codePointAt(i) ?? 0);
  return { char, end: i + char.length };
}

/** A POSIX bracket expression starting at `i` (after '['): its JS class and where it ends. */
function bracket(p: string, i: number, collating = false, regcomp = false): { source: string; end: number } {
  let out = '[';
  let negated = false;
  if (p[i] === '^') { out += '^'; i++; negated = true; }
  // glibc: an expression that ends at its `[` (or `[^`) is no bracket at all.
  if (regcomp && i >= p.length) throw new PosixRegexSyntax('Invalid regular expression');
  let first = true;
  // regcomp: a range just ended, after which a dash may only be last.
  let rangeEnded = false;
  for (;;) {
    if (i >= p.length) throw new PosixRegexSyntax('Unmatched [, [^, [:, [., or [=');
    if (p[i] === ']' && !first) return { source: out + (negated ? INVALID_BYTES : '') + ']', end: i + 1 };
    first = false;
    const member = bracketMember(p, i, regcomp);
    i = member.end;
    // A range: a dash after a member, not the expression's last.
    if (p[i] === '-' && i + 1 < p.length && p[i + 1] !== ']') {
      const hi = bracketMember(p, i + 1, regcomp);
      // A class neither begins nor ends a range (glibc).
      if (!('char' in member) || !('char' in hi)) throw new PosixRegexSyntax('Invalid range end');
      if (regcomp) {
        const lo = member.char.codePointAt(0) ?? 0, high = hi.char.codePointAt(0) ?? 0;
        // C.UTF-8 orders no character past ASCII for a range.
        if (lo > 0x7f || high > 0x7f) throw new PosixRegexSyntax('Invalid collation character');
        if (lo > high) throw new PosixRegexSyntax('Invalid range end');
      }
      out += `${literal(member.char, true)}-${literal(hi.char, true)}`;
      // sed's glibc takes a range between letters by collation; regcomp's, for the shell, by code point.
      if (collating && /[a-z]/.test(member.char) === /[a-z]/.test(hi.char) && /^[A-Za-z]$/.test(member.char) && /^[A-Za-z]$/.test(hi.char)) {
        out += collatedRange(member.char, hi.char);
      }
      i = hi.end;
      rangeEnded = true;
      continue;
    }
    if (regcomp && rangeEnded && 'char' in member && member.char === '-' && p[i] !== ']') throw new PosixRegexSyntax('Invalid range end');
    out += 'char' in member ? literal(member.char, true) : member.members;
    rangeEnded = false;
  }
}

/** A BRE or ERE as JavaScript regex source (`u` flag). */
export function translate(p: string, options: TranslateOptions): string {
  return translateDetailed(p, options).source;
}

/** A BRE or ERE as JavaScript regex source (`u` flag), with its groups and whether its matches need the longest found (execLongest). */
export function translateDetailed(p: string, options: TranslateOptions): Translation {
  const extended = options.extended;
  const regcomp = options.regcomp === true;
  let out = '';
  // Where an operator would have nothing to apply to (so it is literal, or for regcomp an error), and open groups.
  let atStart = true;
  // Each open group: where its `(` is in `out`, its number, and (regcomp) the groups closed when it opened and in its alternatives before this one.
  const open: { at: number; group: number; before: number; alternatives: number }[] = [];
  let groups = 0;
  // regcomp: the groups a back reference may name (bit n: group n), those closed in this alternative or before the alternation it is in, as glibc's.
  let closed = 0;
  const alternative = (): void => {
    const group = open.at(-1);
    if (group !== undefined) group.alternatives |= closed;
    closed = group?.before ?? 0;
  };
  let ambiguous = false;
  // Where the atom a quantifier applies to begins in `out` (-1: none), and whether it is quantified already.
  let atom = -1;
  let quantified = false;
  const emit = (text: string): void => {
    atom = out.length;
    quantified = false;
    out += text;
  };
  const anchor = (text: string): void => {
    atom = -1;
    out += text;
  };
  // A quantifier after a quantifier applies to both, as GNU's: JavaScript would read `+?` as lazy, `**` as an error.
  const quantify = (quantifier: string): void => {
    if (atom === -1) {
      // regcomp repeats no anchor: glibc refuses `\\b*` as it does `^*`.
      if (regcomp) nothingToRepeat();
      out += quantifier;
      return;
    }
    if (quantified) out = `${out.slice(0, atom)}(?:${out.slice(atom)})`;
    if (out[atom] === '(') ambiguous = true;
    out += quantifier;
    quantified = true;
  };
  const nothingToRepeat = (): never => {
    throw new PosixRegexSyntax('Invalid preceding regular expression');
  };
  const openGroup = (): void => {
    groups++;
    open.push({ at: out.length, group: groups, before: closed, alternatives: 0 });
    out += '(';
    atom = -1;
    atStart = true;
  };
  const closeGroup = (): void => {
    const group = open.pop();
    if (group === undefined) return;
    closed |= group.alternatives | (group.group <= 9 ? 1 << group.group : 0);
    out += ')';
    atom = group.at;
    quantified = false;
  };
  for (let i = 0; i < p.length;) {
    const ch = p[i];
    const start = atStart;
    atStart = false;
    if (ch === '\\') {
      const next = p[i + 1];
      if (next === undefined) throw new PosixRegexSyntax('Trailing backslash');
      i += 2;
      if (!extended && next === '(') { openGroup(); continue; }
      if (!extended && next === ')') {
        if (open.length === 0) throw new PosixRegexSyntax('Unmatched ) or \\)');
        closeGroup();
        continue;
      }
      if (!extended && next === '|') { alternative(); anchor('|'); ambiguous = true; atStart = true; continue; }
      if (!extended && (next === '+' || next === '?')) {
        if (start) emit(literal(next));
        else quantify(next);
        continue;
      }
      if (!extended && next === '{') {
        const close = p.indexOf('\\}', i);
        if (close === -1) throw new PosixRegexSyntax('Unmatched \\{');
        quantify(interval(p.slice(i, close), start));
        i = close + 2;
        continue;
      }
      if (options.sed && next === 'n') { emit('\\n'); continue; }
      if (options.sed && next === 't') { emit('\\t'); continue; }
      const hex = options.sed && next === 'x' ? /^[0-9a-fA-F]{1,2}/.exec(p.slice(i))?.[0] : undefined;
      if (hex !== undefined) {
        i += hex.length;
        const byte = parseInt(hex, 16);
        // A byte past ASCII is one no valid character spells: the invalid byte's own marker.
        emit(byte < 0x80 ? literal(String.fromCharCode(byte)) : `\\u${(0xdc00 + byte).toString(16)}`);
        continue;
      }
      if (/[1-9]/.test(next)) {
        // regcomp refers only to a group already closed.
        if (regcomp ? (closed & (1 << Number(next))) === 0 : Number(next) > groups) throw new PosixRegexSyntax('Invalid back reference');
        ambiguous = true;
        // Delimited: a digit after it is a character, never part of a two-digit reference.
        emit(`(?:\\${next})`);
        continue;
      }
      if (next === '<') { anchor(`(?<!${WORD})(?=${WORD})`); continue; }
      if (next === '>') { anchor(`(?<=${WORD})(?!${WORD})`); continue; }
      if (next === 'b') { anchor(`(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`); continue; }
      if (next === 'B') { anchor(`(?:(?<=${WORD})(?=${WORD})|(?<!${WORD})(?!${WORD}))`); continue; }
      if (next === 'w') { emit(WORD); continue; }
      if (next === 'W') { emit(NOT_WORD); continue; }
      if (next === 's') { emit('\\s'); continue; }
      if (next === 'S') { emit('\\S'); continue; }
      if (next === '`') { anchor('^'); continue; }
      if (next === "'") { anchor('$'); continue; }
      emit(literal(next));
      continue;
    }
    i++;
    if (ch === '[') {
      if (!regcomp && p.startsWith(':', i) && /^:[a-z]+:\]/.test(p.slice(i))) {
        throw new PosixRegexSyntax('character class syntax is [[:space:]], not [:space:]');
      }
      const b = bracket(p, i, options.sed === true, regcomp);
      emit(b.source);
      i = b.end;
      continue;
    }
    if (ch === '.') { emit(`[^${INVALID_BYTES}]`); continue; }
    if (ch === '*') {
      if (start && regcomp) nothingToRepeat();
      if (start) emit('\\*');
      else quantify('*');
      continue;
    }
    if (ch === '^') {
      // BRE: an anchor only first in the pattern or a group; ERE: always.
      if (extended || start) { anchor('^'); atStart = true; } else emit('\\^');
      continue;
    }
    if (ch === '$') {
      const last = i === p.length || (!extended && (p.startsWith('\\)', i) || p.startsWith('\\|', i)));
      if (extended || last) anchor('$');
      else emit('\\$');
      continue;
    }
    if (extended) {
      if (ch === '(') { openGroup(); continue; }
      if (ch === ')') {
        // An unmatched ) is an ordinary character in GNU's ERE.
        if (open.length === 0) { emit('\\)'); continue; }
        closeGroup();
        continue;
      }
      if (ch === '|') { alternative(); anchor('|'); ambiguous = true; atStart = true; continue; }
      if (ch === '+' || ch === '?') {
        if (start && regcomp) nothingToRepeat();
        if (start) emit(literal(ch));
        else quantify(ch);
        continue;
      }
      if (ch === '{') {
        const close = p.indexOf('}', i);
        const body = close === -1 ? null : p.slice(i, close);
        if (regcomp) {
          if (start) nothingToRepeat();
          if (body === null) throw new PosixRegexSyntax(/^\d*(,\d*)?$/.test(p.slice(i)) ? 'Unmatched \\{' : 'Invalid content of \\{\\}');
          quantify(interval(body, false));
          i = close + 1;
          continue;
        }
        if (start || body === null || !/^\d*(,\d*)?$/.test(body) || body === '' || body === ',') { emit('\\{'); continue; }
        quantify(interval(body, false));
        i = close + 1;
        continue;
      }
    }
    // A character, a surrogate pair whole.
    const char = String.fromCodePoint(p.codePointAt(i - 1) ?? 0);
    i += char.length - 1;
    emit(literal(char));
  }
  if (open.length > 0) throw new PosixRegexSyntax('Unmatched ( or \\(');
  return { source: out, groups, ambiguous };
}

/** A compiled extended regular expression, as glibc's regcomp compiles one for `[[ =~ ]]`. */
export interface CompiledRegex extends Translation {
  regex: RegExp;
}

const regcompCache = new Map<string, CompiledRegex>();

/** `ere` as glibc's regcomp(REG_EXTENDED) compiles it, from a cache of the last 64; PosixRegexSyntax when glibc refuses it. */
export function compileRegcomp(ere: string): CompiledRegex {
  const cached = regcompCache.get(ere);
  if (cached !== undefined) return cached;
  const translation = translateDetailed(ere, { extended: true, regcomp: true });
  const compiled = { ...translation, regex: new RegExp(translation.source, 'u') };
  if (regcompCache.size >= 64) {
    const [oldest] = regcompCache.keys();
    if (oldest !== undefined) regcompCache.delete(oldest);
  }
  regcompCache.set(ere, compiled);
  return compiled;
}

/**
 * The leftmost, then longest, match of `compiled` in `text`, as regexec gives
 * one: its text and each group's ("" for one that took no part); null when
 * there is none. The leftmost start is JavaScript's. From it, JavaScript's
 * greedy choice is the longest unless the expression is ambiguous (an
 * alternation, a quantified group, a back reference); then the match is
 * extended while some way of matching ends later.
 */
export function execLongest(compiled: CompiledRegex, text: string): string[] | null {
  compiled.regex.lastIndex = 0;
  let match = compiled.regex.exec(text);
  if (match === null) return null;
  const start = match.index;
  while (compiled.ambiguous) {
    const remaining = codePoints(text, start + match[0].length);
    if (remaining === 0) break;
    const longer = new RegExp(`(?:${compiled.source})(?=[\\s\\S]{0,${remaining - 1}}$)`, 'uy');
    longer.lastIndex = start;
    const next = longer.exec(text);
    if (next === null) break;
    match = next;
  }
  const values = [match[0]];
  for (let group = 1; group <= compiled.groups; group++) values.push(match[group] ?? '');
  return values;
}

/** How many code points `text` holds from `from` to its end. */
function codePoints(text: string, from: number): number {
  let count = 0;
  for (let i = from; i < text.length; i++) {
    count++;
    if (/[\uD800-\uDBFF]/.test(text[i]) && /[\uDC00-\uDFFF]/.test(text[i + 1] ?? '')) i++;
  }
  return count;
}

function interval(body: string, start: boolean): string {
  if (start) throw new PosixRegexSyntax('Invalid preceding regular expression');
  const m = /^(\d*)(,?)(\d*)$/.exec(body);
  if (m === null || (m[1] === '' && m[2] === '')) throw new PosixRegexSyntax('Invalid content of \\{\\}');
  const lo = m[1] === '' ? 0 : Number(m[1]);
  const hi = m[2] === '' ? lo : m[3] === '' ? Infinity : Number(m[3]);
  if (hi < lo || lo > 32767 || (hi !== Infinity && hi > 32767)) throw new PosixRegexSyntax('Invalid content of \\{\\}');
  return m[2] === '' ? `{${lo}}` : hi === Infinity ? `{${lo},}` : `{${lo},${hi}}`;
}
