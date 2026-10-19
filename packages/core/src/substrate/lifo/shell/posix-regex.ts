/**
 * POSIX extended regular expressions, as glibc's regcomp(REG_EXTENDED) reads
 * them for bash's `[[ word =~ regex ]]`, translated to JavaScript, and a
 * match as regexec gives one: leftmost, then longest.
 *
 * Read as glibc reads it: `(`, `)`, `|`, `*`, `+`, `?`, `{m,n}`, `^`, `$`
 * and `.` (which matches a newline too); a bracket expression's `]` first is
 * a member and its backslash is a member, with [:class:], [=c=] and [.c.];
 * a quantifier after a quantifier quantifies both (`a+?` is `(a+)?`, never
 * lazy); an unmatched `)` is a character; and glibc's \w \W \s \S \b \B \<
 * \> \` \' and \1–\9. Characters are code points, as in a UTF-8 locale.
 */

/** A regular expression glibc refuses, with its regerror message. */
export class RegexSyntaxError extends Error {}

/** A compiled regular expression: its JavaScript source and how many groups it has. */
export interface ExtendedRegex {
  readonly source: string;
  readonly groups: number;
  readonly regex: RegExp;
}

/** A word character, as glibc's \w is in a UTF-8 locale. */
const WORD = '[\\p{Alphabetic}\\p{Nd}_]';

/** Each [:class:]'s members, as a JavaScript class's contents. */
const CLASSES: Readonly<Record<string, string>> = {
  alpha: '\\p{Alphabetic}',
  digit: '0-9',
  alnum: '\\p{Alphabetic}0-9',
  upper: '\\p{Uppercase}',
  lower: '\\p{Lowercase}',
  space: '\\s',
  blank: ' \\t',
  punct: '\\p{P}\\p{S}',
  cntrl: '\\p{Cc}',
  xdigit: '0-9A-Fa-f',
  print: '\\P{C}',
  graph: '\\p{L}\\p{M}\\p{N}\\p{P}\\p{S}',
};

/** Characters a JavaScript pattern with the u flag reads specially, outside a class. */
const SYNTAX = new Set(['^', '$', '\\', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/']);

/** RE_DUP_MAX: the largest count an interval may give. */
const DUP_MAX = 0x7fff;

const cache = new Map<string, ExtendedRegex>();

/** `ere` compiled: from a cache of the last 64, or translated; a RegexSyntaxError when glibc refuses it. */
export function compileExtended(ere: string): ExtendedRegex {
  const cached = cache.get(ere);
  if (cached !== undefined) return cached;
  const { source, groups } = translate(ere);
  const compiled = { source, groups, regex: new RegExp(source, 'su') };
  if (cache.size >= 64) {
    const [oldest] = cache.keys();
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(ere, compiled);
  return compiled;
}

/**
 * The leftmost, then longest, match of `compiled` in `text`, as regexec gives
 * it: its text and each group's ("" for one that took no part); null when
 * there is none. The leftmost start is JavaScript's; from it, the match is
 * extended while some way of matching ends later.
 */
export function execExtended(compiled: ExtendedRegex, text: string): string[] | null {
  compiled.regex.lastIndex = 0;
  let match = compiled.regex.exec(text);
  if (match === null) return null;
  const start = match.index;
  for (;;) {
    const remaining = codePoints(text, start + match[0].length);
    if (remaining === 0) break;
    // A way of matching from the same start that ends later, if there is one.
    const longer = new RegExp(`(?:${compiled.source})(?=[\\s\\S]{0,${remaining - 1}}$)`, 'suy');
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
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i++;
  }
  return count;
}

/** `char` as a literal in a JavaScript pattern with the u flag. */
function literal(char: string): string {
  return SYNTAX.has(char) ? `\\${char}` : char;
}

/** `char` as a literal inside a JavaScript class with the u flag. */
function classLiteral(char: string): string {
  return char === '\\' || char === ']' || char === '[' || char === '^' || char === '-' ? `\\${char}` : char;
}

function translate(ere: string): { source: string; groups: number } {
  let out = '';
  let groups = 0;
  // Each open group: where its `(` is in `out`.
  const open: number[] = [];
  // Where the atom a quantifier would apply to begins in `out`, or -1 when none may (a regex's or an alternative's start, after an anchor).
  let atom = -1;
  let quantified = false;
  const emitAtom = (text: string): void => {
    atom = out.length;
    quantified = false;
    out += text;
  };
  const quantify = (quantifier: string): void => {
    if (atom === -1) throw new RegexSyntaxError('Invalid preceding regular expression');
    // A quantifier after a quantifier applies to both: JavaScript would read `+?` as lazy, `**` as an error.
    if (quantified) out = `${out.slice(0, atom)}(?:${out.slice(atom)})`;
    out += quantifier;
    quantified = true;
  };
  for (let i = 0; i < ere.length;) {
    const char = String.fromCodePoint(ere.codePointAt(i) ?? 0);
    const next = i + char.length;
    switch (char) {
      case '\\': {
        if (next >= ere.length) throw new RegexSyntaxError('Trailing backslash');
        const escaped = String.fromCodePoint(ere.codePointAt(next) ?? 0);
        i = next + escaped.length;
        if (escaped >= '1' && escaped <= '9') {
          if (Number(escaped) > groups) throw new RegexSyntaxError('Invalid back reference');
          emitAtom(`\\${escaped}`);
        } else if (escaped === 'w') emitAtom(WORD);
        else if (escaped === 'W') emitAtom(`[^${WORD.slice(1)}`);
        else if (escaped === 's') emitAtom('\\s');
        else if (escaped === 'S') emitAtom('\\S');
        else {
          const anchor = ANCHORS[escaped];
          if (anchor !== undefined) {
            out += anchor;
            atom = -1;
          } else emitAtom(literal(escaped));
        }
        continue;
      }
      case '[': {
        const bracket = readBracket(ere, i);
        emitAtom(bracket.source);
        i = bracket.end;
        continue;
      }
      case '(':
        open.push(out.length);
        groups++;
        out += '(';
        atom = -1;
        break;
      case ')': {
        const at = open.pop();
        // An unmatched `)` is a character (glibc).
        if (at === undefined) emitAtom('\\)');
        else {
          out += ')';
          atom = at;
          quantified = false;
        }
        break;
      }
      case '|':
        out += '|';
        atom = -1;
        break;
      case '*':
      case '+':
      case '?':
        quantify(char);
        break;
      case '{': {
        const interval = readInterval(ere, next);
        if (atom === -1) throw new RegexSyntaxError('Invalid preceding regular expression');
        quantify(interval.text);
        i = interval.end;
        continue;
      }
      case '^':
      case '$':
        out += char;
        atom = -1;
        break;
      case '.':
        emitAtom('.');
        break;
      default:
        emitAtom(literal(char));
    }
    i = next;
  }
  if (open.length > 0) throw new RegexSyntaxError('Unmatched ( or \\(');
  return { source: out, groups };
}

/** glibc's anchors after a backslash: word boundaries and the buffer's ends. */
const ANCHORS: Readonly<Record<string, string>> = {
  b: `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`,
  B: `(?:(?<=${WORD})(?=${WORD})|(?<!${WORD})(?!${WORD}))`,
  '<': `(?<!${WORD})(?=${WORD})`,
  '>': `(?<=${WORD})(?!${WORD})`,
  '`': '^',
  "'": '$',
};

/** An interval's text after its `{` at `pos`: `{m}`, `{m,}`, `{m,n}` or `{,n}`, and where it ends. */
function readInterval(ere: string, pos: number): { text: string; end: number } {
  const close = ere.indexOf('}', pos);
  if (close === -1) {
    // Unclosed: glibc reads on until the expression's end.
    if (/^[0-9]*(,[0-9]*)?$/.test(ere.slice(pos))) throw new RegexSyntaxError('Unmatched \\{');
    throw new RegexSyntaxError('Invalid content of \\{\\}');
  }
  const body = /^([0-9]*)(,([0-9]*))?$/.exec(ere.slice(pos, close));
  if (body === null || (body[1] === '' && body[2] === undefined)) throw new RegexSyntaxError('Invalid content of \\{\\}');
  const min = body[1] === '' ? 0 : Number(body[1]);
  const max = body[2] === undefined ? min : body[3] === '' || body[3] === undefined ? null : Number(body[3]);
  if (max !== null && max < min) throw new RegexSyntaxError('Invalid content of \\{\\}');
  if ((max ?? min) > DUP_MAX) throw new RegexSyntaxError('Regular expression too big');
  return { text: body[2] === undefined ? `{${min}}` : max === null ? `{${min},}` : `{${min},${max}}`, end: close + 1 };
}

/** A bracket expression's member: a character, or a class's members (which cannot end a range). */
type Member = { char: string } | { members: string };

/** The bracket expression at `pos` as a JavaScript class, and where it ends. */
function readBracket(ere: string, pos: number): { source: string; end: number } {
  let i = pos + 1;
  let negate = false;
  if (ere[i] === '^') {
    negate = true;
    i++;
  }
  // glibc: an expression that ends at its `[` (or `[^`) is no bracket at all.
  if (i >= ere.length) throw new RegexSyntaxError('Invalid regular expression');
  let body = '';
  const first = i;
  for (;;) {
    if (i >= ere.length) throw new RegexSyntaxError('Unmatched [, [^, [:, [., or [=');
    if (ere[i] === ']' && i !== first) return { source: `[${negate ? '^' : ''}${body}]`, end: i + 1 };
    const start = readMember(ere, i);
    i = start.end;
    // A range: `-` not last, its end not a class.
    if (ere[i] === '-' && i + 1 < ere.length && ere[i + 1] !== ']') {
      const last = readMember(ere, i + 1);
      if (!('char' in start.member) || !('char' in last.member)) throw new RegexSyntaxError('Invalid range end');
      if ((start.member.char.codePointAt(0) ?? 0) > (last.member.char.codePointAt(0) ?? 0)) throw new RegexSyntaxError('Invalid range end');
      body += `${classLiteral(start.member.char)}-${classLiteral(last.member.char)}`;
      i = last.end;
      continue;
    }
    body += 'char' in start.member ? classLiteral(start.member.char) : start.member.members;
  }
}

/** A bracket expression's member at `pos`: a character (its backslash is one), [:class:], [=c=] or [.c.]. */
function readMember(ere: string, pos: number): { member: Member; end: number } {
  const kind = ere[pos] === '[' ? ere[pos + 1] : undefined;
  if (kind === ':' || kind === '=' || kind === '.') {
    const close = ere.indexOf(`${kind}]`, pos + 2);
    if (close === -1) throw new RegexSyntaxError('Unmatched [, [^, [:, [., or [=');
    const name = ere.slice(pos + 2, close);
    const end = close + 2;
    if (kind === ':') {
      const members = Object.hasOwn(CLASSES, name) ? CLASSES[name] : undefined;
      if (members === undefined) throw new RegexSyntaxError('Invalid character class name');
      return { member: { members }, end };
    }
    // An equivalence class or a collating symbol: one character, itself.
    if ([...name].length !== 1) throw new RegexSyntaxError('Invalid collation character');
    return { member: { char: name }, end };
  }
  const char = String.fromCodePoint(ere.codePointAt(pos) ?? 0);
  return { member: { char }, end: pos + char.length };
}
