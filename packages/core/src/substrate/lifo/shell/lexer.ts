import { TokenKind, type Token, type WordPart } from './types.js';
import { expandBackslashEscapes } from '../utils/backslash-escapes.js';

/** Every token of `input`, read at once. */
export function lex(input: string): Token[] {
  const reader = new TokenReader(input);
  const tokens: Token[] = [];
  for (;;) {
    for (const token of reader.next()) {
      tokens.push(token);
      if (token.kind === TokenKind.EOF) return tokens;
    }
  }
}

/**
 * An array literal's words (the text between its parentheses), as bash's
 * reader reads a compound assignment: as anywhere, except that a word
 * beginning `[subscript]=` or `[subscript]+=` reads its subscript whole
 * (TokenReader.readSubscriptedWord).
 */
export function lexArrayElements(input: string): Token[] {
  const reader = new TokenReader(input);
  const tokens: Token[] = [];
  for (;;) {
    const subscripted = reader.readSubscriptedWord();
    if (subscripted !== null) {
      tokens.push(subscripted);
      continue;
    }
    for (const token of reader.next()) {
      if (token.kind === TokenKind.EOF) return tokens;
      tokens.push(token);
    }
  }
}

/** Text a reader reads: the input, or an alias's text read in place of its name (`alias`; `blank`: it ends in a blank). */
interface Frame {
  readonly input: string;
  at: number;
  readonly alias: string | null;
  readonly blank: boolean;
}

/**
 * Where a reader is between tokens: the text it reads at each depth, and the
 * here-documents whose bodies follow its next newline (the first
 * `pendingCount` of `pending`, which a line's words only add to).
 */
export interface ReaderMark {
  readonly frames: readonly Frame[];
  readonly pending: readonly HeredocDelimiter[];
  readonly pendingCount: number;
  readonly operator: TokenKind.Heredoc | TokenKind.HeredocStripTabs | null;
  readonly checkNext: boolean;
}

/**
 * The shell's reader: `input`'s tokens a batch at a time (a token, or a
 * newline and the here-document bodies it opens), as its parser asks for
 * them, so that the parser can go back to where a token began and read a
 * word there in a mode of its own (the regular expression after `=~`), or
 * read an alias's text in place of a word (pushAlias), as bash's reader
 * does: a comment in that text takes the rest of the line it is read in.
 */
export class TokenReader {
  private frames: Frame[];
  private pending: HeredocDelimiter[] = [];
  private operator: TokenKind.Heredoc | TokenKind.HeredocStripTabs | null = null;
  // The next word follows an alias whose text ended in a blank.
  private checkNext = false;

  constructor(input: string) {
    this.frames = [{ input, at: 0, alias: null, blank: false }];
  }

  mark(): ReaderMark {
    return { frames: this.frames.map((frame) => ({ ...frame })), pending: this.pending, pendingCount: this.pending.length, operator: this.operator, checkNext: this.checkNext };
  }

  reset(mark: ReaderMark): void {
    this.frames = mark.frames.map((frame) => ({ ...frame }));
    this.pending = mark.pending.slice(0, mark.pendingCount);
    this.operator = mark.operator;
    this.checkNext = mark.checkNext;
  }

  /** Read `alias`'s text `value` next, in place of its name: none of its words, or the next one's after it, is `alias` again until it is read. */
  pushAlias(alias: string, value: string): void {
    this.frames.push({ input: value, at: 0, alias, blank: /[ \t\n]$/.test(value) });
  }

  /** The text being read: an alias's ends where its text does, and the text it was read in goes on. */
  private get frame(): Frame {
    for (;;) {
      const top = this.frames[this.frames.length - 1];
      if (this.frames.length === 1 || top.at < top.input.length) return top;
      this.frames.pop();
      if (top.blank) this.checkNext = true;
    }
  }

  /** The aliases whose text is being read: their names expand nothing read now. */
  private aliasesInUse(): ReadonlySet<string> | undefined {
    if (this.frames.length === 1) return undefined;
    const names = new Set<string>();
    for (const frame of this.frames) if (frame.alias !== null) names.add(frame.alias);
    return names;
  }

  /** The next batch: a token, or a newline and the here-document bodies it opens; at the input's end, EOF. */
  next(): Token[] {
    const batch = this.read();
    const aliases = this.aliasesInUse();
    if (aliases !== undefined) for (const token of batch) token.aliases = aliases;
    const [first] = batch;
    if (this.checkNext && first !== undefined) {
      if (first.kind === TokenKind.Word) first.aliasCheck = true;
      this.checkNext = false;
    }
    return batch;
  }

  private read(): Token[] {
    for (let frame = this.frame; frame.at < frame.input.length; frame = this.frame) {
      const input = frame.input;
      const i = frame.at;
      // Skip whitespace (but NOT newlines -- they become Newline tokens)
      if (input[i] === ' ' || input[i] === '\t') {
        frame.at++;
        continue;
      }
      // A line continuation between words is no word and no newline.
      if (input[i] === '\\' && input[i + 1] === '\n') {
        frame.at += 2;
        continue;
      }

      // Newline
      if (input[i] === '\n') {
        const batch: Token[] = [{ kind: TokenKind.Newline, value: '\n', pos: i }];
        frame.at++;
        if (this.pending.length > 0) {
          const bodies = readHeredocBodies(input, frame.at, this.pending);
          for (const body of bodies.tokens) batch.push(body);
          frame.at = bodies.end;
          this.pending = [];
        }
        return batch;
      }

      // Comment -- skip to end of line: past an alias's text, into the line it is read in.
      if (input[i] === '#') {
        let reading = frame;
        for (;;) {
          while (reading.at < reading.input.length && reading.input[reading.at] !== '\n') reading.at++;
          if (reading.at < reading.input.length || this.frames.length === 1) break;
          reading = this.frame;
        }
        continue;
      }

      // Operators
      const op = tryOperator(input, i);
      if (op) {
        if (op.token.kind === TokenKind.Heredoc || op.token.kind === TokenKind.HeredocStripTabs) {
          this.operator = op.token.kind;
        }
        frame.at = op.end;
        return [op.token];
      }

      // Word (may include quotes, escapes, $(), globs, variables)
      const word = readWord(input, i);
      if (word) {
        if (this.operator !== null) {
          this.pending.push({
            delimiter: word.token.value,
            quoted: wordHasQuotedParts(word.token),
            stripTabs: this.operator === TokenKind.HeredocStripTabs,
          });
          this.operator = null;
        }
        frame.at = word.end;
        return [word.token];
      }

      // Shouldn't reach here, but advance to avoid infinite loop
      frame.at++;
    }
    return [{ kind: TokenKind.EOF, value: '', pos: this.frame.at }];
  }

  /**
   * An array literal's `[subscript]=value` (or `+=`) word, read here when one
   * begins at the next word: its subscript to the matching `]`, whose blanks,
   * parentheses and operators are its own and whose quotes are kept as a
   * word's (`[i + 1]`, `[(1+2)]`, `["a]b"]`), then the value as a word. Null,
   * with nothing read but blanks, where the next word is not one.
   */
  readSubscriptedWord(): Token | null {
    const frame = this.frame;
    const input = frame.input;
    while (input[frame.at] === ' ' || input[frame.at] === '\t' || (input[frame.at] === '\\' && input[frame.at + 1] === '\n')) {
      frame.at += input[frame.at] === '\\' ? 2 : 1;
    }
    const pos = frame.at;
    if (input[pos] !== '[') return null;
    const close = subscriptEnd(input, pos);
    if (close === -1) return null;
    const operator = input.startsWith('+=', close + 1) ? '+=' : input[close + 1] === '=' ? '=' : null;
    if (operator === null) return null;
    const parts: WordPart[] = [{ text: '[', quoted: 'none' }];
    // The subscript's words, as far as the `]`; a character no word begins with is its own.
    const subscript = input.slice(0, close);
    for (let i = pos + 1; i < close;) {
      const word = isWordBreak(subscript[i]) ? null : readWord(subscript, i);
      if (word === null) {
        parts.push({ text: subscript[i], quoted: 'none' });
        i++;
        continue;
      }
      parts.push(...(word.token.parts ?? [{ text: word.token.value, quoted: 'none' }]));
      i = word.end;
    }
    parts.push({ text: `]${operator}`, quoted: 'none' });
    let end = close + 1 + operator.length;
    const value = isWordBreak(input[end] ?? ' ') ? null : readWord(input, end);
    if (value !== null) {
      parts.push(...(value.token.parts ?? [{ text: value.token.value, quoted: 'none' }]));
      end = value.end;
    }
    frame.at = end;
    return { kind: TokenKind.Word, value: parts.map((part) => part.text).join(''), pos, parts, source: input.slice(pos, end) };
  }

  /**
   * The word after `=~`, as bash's reader reads a regular expression: up to a
   * blank or an operator, except that its parentheses nest and, inside them,
   * blanks, newlines, `#` and operators are its own, and `|` is its own
   * anywhere. A `)` outside them ends it, for the conditional to read. Inside
   * them, it goes on past the end of an alias's text into the text the alias
   * was read in, with a blank between unless the alias's text ended in one or
   * in an operator's character (bash's reader gives that blank). Null when no
   * word begins here (a comment, a newline, an operator); `unclosed` when the
   * input ends inside its parentheses.
   */
  readRegexWord(): { token: Token; unclosed: boolean } | null {
    // Blanks and line continuations before it, past the end of an alias's text.
    let frame = this.frame;
    for (;;) {
      const text = frame.input;
      while (text[frame.at] === ' ' || text[frame.at] === '\t' || (text[frame.at] === '\\' && text[frame.at + 1] === '\n')) {
        frame.at += text[frame.at] === '\\' ? 2 : 1;
      }
      if (frame.at < text.length || this.frames.length === 1) break;
      frame = this.frame;
    }
    let input = frame.input;
    const pos = frame.at;
    if (pos >= input.length || input[pos] === '#') return null;
    const parts: WordPart[] = [];
    let depth = 0;
    let i = pos;
    // Its text as written, read up to `i` in `input` from `from`.
    let source = '';
    let from = pos;
    for (;;) {
      if (i >= input.length) {
        if (depth === 0 || this.frames.length === 1) break;
        source += input.slice(from, i);
        if (input !== '' && !/[ \t\n\\|&;()<>]$/.test(input)) {
          parts.push({ text: ' ', quoted: 'none' });
          source += ' ';
        }
        frame.at = i;
        frame = this.frame;
        input = frame.input;
        i = frame.at;
        from = i;
        continue;
      }
      const ch = input[i];
      if (ch === '\\' && input[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (depth === 0 && (ch === ' ' || ch === '\t' || ch === '\n' || ch === ';' || ch === '&' || ch === '<' || ch === '>' || ch === ')')) break;
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (isWordBreak(ch)) {
        parts.push({ text: ch, quoted: 'none' });
        i++;
        continue;
      }
      const word = readWord(input, i);
      if (word === null) {
        parts.push({ text: ch, quoted: 'none' });
        i++;
        continue;
      }
      parts.push(...(word.token.parts ?? [{ text: word.token.value, quoted: 'none' }]));
      i = word.end;
    }
    if (parts.length === 0) return null;
    frame.at = i;
    // It is the word after an alias whose text ended in a blank, if one did.
    this.checkNext = false;
    return {
      token: { kind: TokenKind.Word, value: parts.map((part) => part.text).join(''), pos, parts, source: source + input.slice(from, i) },
      unclosed: depth > 0,
    };
  }
}

export type ContinuationState = 'single' | 'double' | 'backslash';

/**
 * How `input` leaves the lexer at end of input: inside an unclosed single or
 * double quote, or ending in a `\` line continuation (which bash also honors
 * inside double quotes, where `\<newline>` is removed). The interactive shell
 * uses this to keep reading (PS2) instead of executing a truncated command.
 * Comments are skipped exactly where lex() treats `#` as one.
 */
export function continuationState(input: string): ContinuationState | null {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\') {
      if (i === input.length - 1) return 'backslash';
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    // $$, the shell's pid, is two dollars: a quote after it is its own.
    if (ch === '$' && input[i + 1] === '$') {
      i++;
      continue;
    }
    if (ch === '$' && input[i + 1] === "'") {
      const end = ansiCQuoteEnd(input, i);
      if (end === -1) return 'single';
      i = end - 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '#') {
      while (i + 1 < input.length && input[i + 1] !== '\n') i++;
    }
  }
  if (quote === null) return null;
  return quote === '"' ? 'double' : 'single';
}

function tryOperator(input: string, pos: number): { token: Token; end: number } | null {
  const ch = input[pos];
  const next = input[pos + 1];

  const fdRedirect = tryFdRedirectOperator(input, pos);
  if (fdRedirect) return fdRedirect;

  // &> (redirect both)
  if (ch === '&' && next === '>') {
    return { token: { kind: TokenKind.RedirectAll, value: '&>', pos }, end: pos + 2 };
  }

  // && (and)
  if (ch === '&' && next === '&') {
    return { token: { kind: TokenKind.And, value: '&&', pos }, end: pos + 2 };
  }

  // & (background)
  if (ch === '&') {
    return { token: { kind: TokenKind.Amp, value: '&', pos }, end: pos + 1 };
  }

  // || (or)
  if (ch === '|' && next === '|') {
    return { token: { kind: TokenKind.Or, value: '||', pos }, end: pos + 2 };
  }

  // | (pipe)
  if (ch === '|') {
    return { token: { kind: TokenKind.Pipe, value: '|', pos }, end: pos + 1 };
  }

  // >> (append)
  if (ch === '>' && next === '>') {
    return { token: { kind: TokenKind.RedirectAppend, value: '>>', pos }, end: pos + 2 };
  }

  // <<- (heredoc, strip leading tabs)
  if (ch === '<' && next === '<' && input[pos + 2] === '-') {
    return { token: { kind: TokenKind.HeredocStripTabs, value: '<<-', pos }, end: pos + 3 };
  }

  // << (heredoc)
  if (ch === '<' && next === '<') {
    return { token: { kind: TokenKind.Heredoc, value: '<<', pos }, end: pos + 2 };
  }

  // <> (read/write)
  if (ch === '<' && next === '>') {
    return { token: { kind: TokenKind.RedirectReadWrite, value: '<>', pos }, end: pos + 2 };
  }

  // > (redirect out)
  if (ch === '>') {
    return { token: { kind: TokenKind.RedirectOut, value: '>', pos }, end: pos + 1 };
  }

  // < (redirect in)
  if (ch === '<') {
    return { token: { kind: TokenKind.RedirectIn, value: '<', pos }, end: pos + 1 };
  }

  // ;; (double semicolon -- case item terminator)
  if (ch === ';' && next === ';') {
    return { token: { kind: TokenKind.DoubleSemi, value: ';;', pos }, end: pos + 2 };
  }

  // ; (semicolon)
  if (ch === ';') {
    return { token: { kind: TokenKind.Semi, value: ';', pos }, end: pos + 1 };
  }

  // ( (left paren)
  if (ch === '(') {
    return { token: { kind: TokenKind.LParen, value: '(', pos }, end: pos + 1 };
  }

  // ) (right paren)
  if (ch === ')') {
    return { token: { kind: TokenKind.RParen, value: ')', pos }, end: pos + 1 };
  }

  return null;
}

type HeredocDelimiter = {
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
};

/** Whether `line` ends a here-document opened with `delimiter` (`stripTabs`: by `<<-`, whose lines lose their leading tabs). */
export function endsHeredoc(line: string, heredoc: { readonly delimiter: string; readonly stripTabs: boolean }): boolean {
  return (heredoc.stripTabs ? stripLeadingTabs(line) : line) === heredoc.delimiter;
}

function readHeredocBodies(
  input: string,
  pos: number,
  heredocs: HeredocDelimiter[],
): { tokens: Token[]; end: number } {
  const tokens: Token[] = [];
  let i = pos;

  for (const heredoc of heredocs) {
    const bodyStart = i;
    const lines: string[] = [];
    let terminated = false;

    while (i < input.length) {
      const line = readLine(input, i);
      i = line.end;

      if (endsHeredoc(line.text, heredoc)) {
        terminated = true;
        break;
      }

      lines.push(heredoc.stripTabs ? stripLeadingTabs(line.text) : line.text);
      if (!line.hadNewline) break;
    }

    const body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    tokens.push({
      kind: TokenKind.HeredocBody,
      value: body,
      pos: bodyStart,
      heredocQuoted: heredoc.quoted,
      heredocTerminated: terminated,
    });
  }

  return { tokens, end: i };
}

function readLine(input: string, pos: number): { text: string; end: number; hadNewline: boolean } {
  let i = pos;
  while (i < input.length && input[i] !== '\n') i++;
  const end = input[i - 1] === '\r' ? i - 1 : i;
  const text = input.slice(pos, end);
  if (i < input.length && input[i] === '\n') {
    return { text, end: i + 1, hadNewline: true };
  }
  return { text, end: i, hadNewline: false };
}

function stripLeadingTabs(input: string): string {
  let i = 0;
  while (input[i] === '\t') i++;
  return input.slice(i);
}

function wordHasQuotedParts(token: Token): boolean {
  return token.parts?.some((part) => part.quoted !== 'none') ?? false;
}

function tryFdRedirectOperator(input: string, pos: number): { token: Token; end: number } | null {
  if (pos > 0 && !isOperatorBreak(input[pos - 1])) return null;
  if (!isDigit(input[pos])) return null;

  let fdEnd = pos;
  while (isDigit(input[fdEnd])) fdEnd++;

  const fd = Number.parseInt(input.slice(pos, fdEnd), 10);
  const op = input[fdEnd];
  if (op === '>' && input[fdEnd + 1] === '>') {
    return {
      token: {
        kind: fd === 2 ? TokenKind.RedirectErrAppend : TokenKind.RedirectAppend,
        value: input.slice(pos, fdEnd + 2),
        pos,
        fd,
      },
      end: fdEnd + 2,
    };
  }
  if (op === '>') {
    return {
      token: {
        kind: fd === 2 ? TokenKind.RedirectErr : TokenKind.RedirectOut,
        value: input.slice(pos, fdEnd + 1),
        pos,
        fd,
      },
      end: fdEnd + 1,
    };
  }
  if (op === '<') {
    if (input[fdEnd + 1] === '<' && input[fdEnd + 2] === '-') {
      return {
        token: {
          kind: TokenKind.HeredocStripTabs,
          value: input.slice(pos, fdEnd + 3),
          pos,
          fd,
        },
        end: fdEnd + 3,
      };
    }
    if (input[fdEnd + 1] === '<') {
      return {
        token: {
          kind: TokenKind.Heredoc,
          value: input.slice(pos, fdEnd + 2),
          pos,
          fd,
        },
        end: fdEnd + 2,
      };
    }
    if (input[fdEnd + 1] === '>') {
      return {
        token: {
          kind: TokenKind.RedirectReadWrite,
          value: input.slice(pos, fdEnd + 2),
          pos,
          fd,
        },
        end: fdEnd + 2,
      };
    }
    return {
      token: {
        kind: TokenKind.RedirectIn,
        value: input.slice(pos, fdEnd + 1),
        pos,
        fd,
      },
      end: fdEnd + 1,
    };
  }

  return null;
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isOperatorBreak(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '|' || ch === '&' || ch === ';'
    || ch === '>' || ch === '<' || ch === '\n' || ch === '(' || ch === ')';
}

/**
 * The index of the `]` that closes the `[` at `open`, as bash's skipsubscript
 * finds it: brackets nest, and a quoted or backslashed one is not counted.
 * -1 where it is not closed.
 */
function subscriptEnd(input: string, open: number): number {
  let depth = 0;
  for (let i = open; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\\') i++;
    else if (ch === "'") {
      i = input.indexOf("'", i + 1);
      if (i === -1) return -1;
    } else if (ch === '"') {
      for (i++; i < input.length && input[i] !== '"'; i++) if (input[i] === '\\') i++;
    } else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return i;
  }
  return -1;
}

function isWordBreak(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '|' || ch === '&' || ch === ';'
    || ch === '>' || ch === '<' || ch === '#' || ch === '\n' || ch === '(' || ch === ')';
}

/** Everything a word may hold before the `(` of an array assignment. */
const ARRAY_ASSIGNMENT_PREFIX = /^[a-zA-Z_][a-zA-Z0-9_]*(\[[^\]]*\])?\+?=$/;

function readWord(input: string, pos: number): { token: Token; end: number } | null {
  const parts: WordPart[] = [];
  // Each $'…' span and its decoded text: bash's reader keeps the word with it as '…'.
  const ansiC: Array<{ start: number; end: number; text: string }> = [];
  let i = pos;
  let currentText = '';
  let hasContent = false;

  const flushCurrentText = (): void => {
    if (currentText) {
      parts.push({ text: currentText, quoted: 'none' });
      currentText = '';
    }
  };

  while (i < input.length) {
    const ch = input[i];

    // A line continuation: removed, the word going on (bash's shell_getc).
    if (ch === '\\' && input[i + 1] === '\n') {
      i += 2;
      continue;
    }

    // Backslash escape (outside quotes)
    if (ch === '\\' && i + 1 < input.length) {
      flushCurrentText();
      parts.push({ text: input[i + 1], quoted: 'single' });
      i += 2;
      hasContent = true;
      continue;
    }

    // Single quote
    if (ch === "'") {
      flushCurrentText();
      i++; // skip opening quote
      const start = i;
      while (i < input.length && input[i] !== "'") {
        i++;
      }
      parts.push({ text: input.slice(start, i), quoted: 'single' });
      if (i < input.length) i++; // skip closing quote
      hasContent = true;
      continue;
    }

    // Double quote
    if (ch === '"') {
      flushCurrentText();
      i++; // skip opening quote
      let dqText = '';
      let doubleQuotedContent = false;
      const flushDoubleText = (): void => {
        if (dqText) {
          parts.push({ text: dqText, quoted: 'double' });
          dqText = '';
        }
      };
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const nextCh = input[i + 1];
          // Inside double quotes, only these chars are special with backslash; before a newline it continues the line, no content.
          if (nextCh === '\n') {
            i += 2;
            continue;
          }
          if (nextCh === '"' || nextCh === '\\' || nextCh === '$' || nextCh === '`') {
            flushDoubleText();
            parts.push({ text: nextCh, quoted: 'single' });
            doubleQuotedContent = true;
            i += 2;
          } else {
            dqText += '\\';
            i++;
          }
        } else if (input[i] === '$' && input[i + 1] === '{') {
          const braced = readBracedExpansion(input, i);
          dqText += braced.text;
          i = braced.end;
        } else if (input[i] === '$' && input[i + 1] === '(') {
          const subst = readCommandSubstitution(input, i);
          if (subst.kind === 'command') {
            flushDoubleText();
            parts.push({
              text: subst.text,
              quoted: 'double',
              commandSubstitution: subst.command,
            });
          } else {
            dqText += subst.text;
          }
          i = subst.end;
        } else if (input[i] === '`') {
          const subst = readBacktickSubstitution(input, i);
          if (subst.kind === 'command') {
            flushDoubleText();
            parts.push({
              text: subst.text,
              quoted: 'double',
              commandSubstitution: subst.command,
            });
          } else {
            dqText += subst.text;
          }
          i = subst.end;
        } else {
          dqText += input[i];
          i++;
        }
        doubleQuotedContent = true;
      }
      if (dqText || !doubleQuotedContent) {
        parts.push({ text: dqText, quoted: 'double' });
      }
      if (i < input.length) i++; // skip closing quote
      hasContent = true;
      continue;
    }

    // Backtick command substitution
    if (ch === '`') {
      const subst = readBacktickSubstitution(input, i);
      if (subst.kind === 'command') {
        flushCurrentText();
        parts.push({
          text: subst.text,
          quoted: 'none',
          commandSubstitution: subst.command,
        });
      } else {
        currentText += subst.text;
      }
      i = subst.end;
      hasContent = true;
      continue;
    }

    // $'...': ANSI-C quoting, one quoted part whose escapes are decoded
    if (ch === '$' && input[i + 1] === "'") {
      flushCurrentText();
      const quoted = readAnsiCQuote(input, i);
      parts.push({ text: quoted.text, quoted: 'single' });
      ansiC.push({ start: i, end: quoted.end, text: quoted.text });
      i = quoted.end;
      hasContent = true;
      continue;
    }

    // $(...) or $((...)) command/arithmetic substitution
    if (ch === '$' && input[i + 1] === '(') {
      const subst = readCommandSubstitution(input, i);
      if (subst.kind === 'command') {
        flushCurrentText();
        parts.push({
          text: subst.text,
          quoted: 'none',
          commandSubstitution: subst.command,
        });
      } else {
        currentText += subst.text;
      }
      i = subst.end;
      hasContent = true;
      continue;
    }

    // ${...} braced variable expansion -- read until matching }
    if (ch === '$' && input[i + 1] === '{') {
      const braced = readBracedExpansion(input, i);
      currentText += braced.text;
      i = braced.end;
      hasContent = true;
      continue;
    }

    // $# $@ $N $? -- special variables that start with $
    if (ch === '$' && i + 1 < input.length) {
      const nc = input[i + 1];
      if (nc === '#' || nc === '@' || nc === '?' || nc === '$' || /[0-9]/.test(nc)) {
        currentText += '$' + nc;
        i += 2;
        hasContent = true;
        continue;
      }
    }

    // `name=(word …)` — an array assignment is a single word, so the list in
    // parentheses must not lex as a subshell the way a bare `(` would.
    if (ch === '(' && parts.length === 0 && ARRAY_ASSIGNMENT_PREFIX.test(currentText)) {
      const balanced = readBalancedCommand(input, i + 1, '(', ')');
      currentText += '(' + balanced.body + (balanced.closed ? ')' : '');
      i = balanced.end;
      hasContent = true;
      continue;
    }

    // Check for operator/break chars that end the word
    // Special case: 2> and 2>> at word start should be handled by tryOperator
    if (isWordBreak(ch)) {
      break;
    }

    // Check for redirect operators that could appear mid-stream
    if (ch === '>' || ch === '<') {
      break;
    }

    currentText += ch;
    i++;
    hasContent = true;
  }

  if (!hasContent) return null;

  flushCurrentText();

  // Build combined value for backward compatibility
  const value = parts.map((p) => p.text).join('');

  return {
    token: { kind: TokenKind.Word, value, pos, parts, source: writtenWord(input, pos, i, ansiC) },
    end: i,
  };
}

/** The word from `pos` to `end` as bash's reader keeps it: its quotes in it, each $'…' as '…' decoded. */
function writtenWord(input: string, pos: number, end: number, ansiC: ReadonlyArray<{ start: number; end: number; text: string }>): string {
  let written = '';
  let at = pos;
  for (const span of ansiC) {
    written += `${input.slice(at, span.start)}'${span.text}'`;
    at = span.end;
  }
  return written + input.slice(at, end);
}

type SubstitutionRead =
  | { kind: 'command'; text: string; command: string; end: number }
  | { kind: 'text'; text: string; end: number };

function readCommandSubstitution(input: string, pos: number): SubstitutionRead {
  let i = pos + 1; // skip $

  if (input[i] !== '(') {
    return { kind: 'text', text: '$', end: pos + 1 };
  }

  if (input[i + 1] === '(') {
    return readArithmeticSubstitution(input, pos);
  }

  const balanced = readBalancedCommand(input, i + 1, '(', ')');
  if (!balanced.closed) {
    return { kind: 'text', text: input.slice(pos, balanced.end), end: balanced.end };
  }
  return {
    kind: 'command',
    text: input.slice(pos, balanced.end),
    command: balanced.body,
    end: balanced.end,
  };
}

function readArithmeticSubstitution(input: string, pos: number): SubstitutionRead {
  let text = '$((';
  let i = pos + 3;
  let parenDepth = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === '\\' && i + 1 < input.length) {
      text += input.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (ch === '(') {
      parenDepth++;
      text += ch;
      i++;
      continue;
    }

    if (ch === ')') {
      if (parenDepth === 0 && input[i + 1] === ')') {
        text += '))';
        return { kind: 'text', text, end: i + 2 };
      }
      if (parenDepth > 0) {
        parenDepth--;
      }
      text += ch;
      i++;
      continue;
    }

    text += ch;
    i++;
  }

  return { kind: 'text', text, end: i };
}

function readBacktickSubstitution(input: string, pos: number): SubstitutionRead {
  let i = pos + 1;
  let inner = '';

  while (i < input.length) {
    const ch = input[i];
    if (ch === '`') {
      return { kind: 'command', text: input.slice(pos, i + 1), command: inner, end: i + 1 };
    }
    if (ch === '\\' && i + 1 < input.length) {
      const next = input[i + 1];
      if (next === '`' || next === '$' || next === '\\') {
        inner += next;
        i += 2;
        continue;
      }
    }
    inner += ch;
    i++;
  }

  return { kind: 'text', text: input.slice(pos), end: input.length };
}

/**
 * The full `${...}` span starting at `pos`. Quotes, nested braces and command
 * substitutions inside it belong to the expansion, not to the surrounding
 * word — `"${v:-"a b"}"` and `"${v:-$(cmd)}"` are one parameter expansion each.
 */
export function readBracedExpansion(
  input: string, pos: number,
): { text: string; inner: string; end: number } {
  const balanced = readBalancedCommand(input, pos + 2, '{', '}');
  return { text: input.slice(pos, balanced.end), inner: balanced.body, end: balanced.end };
}

/** What a `#` that starts a comment may follow: a blank, or an operator that ends a word. */
const COMMENT_AFTER = ' \t\n;&|()<>';

/** A table of the ASCII characters in `chars`, for nextStop. */
function stopTable(chars: string): Uint8Array {
  const table = new Uint8Array(128);
  for (const c of chars) table[c.charCodeAt(0)] = 1;
  return table;
}

/** Where a balanced span's scan must look, by its brackets: every other character is body as it stands. */
const SPAN_STOPS: Readonly<Record<'(' | '{', Uint8Array>> = {
  '(': stopTable('\\\'"$`#()<\n'),
  '{': stopTable('\\\'"$`#{}'),
};
/** Where a double-quoted span's scan must look. */
const DOUBLE_QUOTED_STOPS = stopTable('"\\$`');

/** The first index from `i` whose character `stops` marks, or the input's length. */
function nextStop(input: string, i: number, stops: Uint8Array): number {
  for (; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c < 128 && stops[c] === 1) return i;
  }
  return i;
}

/**
 * The body of a balanced `open`...`close` span whose body starts at `pos`
 * (just past `open`), and where it ends (just past `close`, or the input's
 * end when it never closes). Quotes and nested `$(...)` inside it are
 * skipped whole, so a `close` inside them does not end it. In a command's
 * span, a here-document's body is too: read at the newline after its `<<`,
 * as the shell's reader reads it, so its `'` or `)` is text. An arithmetic
 * span, `$((…))` (its body at the second `(`), has no here-document: `<<` shifts.
 */
export function readBalancedCommand(
  input: string,
  pos: number,
  open: '(' | '{',
  close: ')' | '}',
): { body: string; end: number; closed: boolean } {
  const arithmetic = open === '(' && input[pos] === '(' && input[pos - 1] === '(' && input[pos - 2] === '$';
  const stops = SPAN_STOPS[open];
  let i = pos;
  let depth = 1;
  let body = '';
  // The here-documents whose bodies follow the next newline.
  const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];

  while (i < input.length) {
    // Characters that are no syntax here go into the body as one run.
    const at = nextStop(input, i, stops);
    if (at > i) {
      body += input.slice(i, at);
      i = at;
      if (i === input.length) break;
    }
    const ch = input[i];
    if (ch === '\\' && i + 1 < input.length) {
      body += input.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quoted = readQuoted(input, i, ch);
      body += quoted.text;
      i = quoted.end;
      continue;
    }
    if (ch === '$' || ch === '`') {
      const next = input[i + 1];
      // $$ is two dollars; $'...', ${...}, $(...) and a backquoted command
      // are each one span, so nothing in them closes this one.
      const end = ch === '`' ? readBacktickSubstitution(input, i).end
        : next === '$' ? i + 2
        : next === "'" ? ansiCQuoteEnd(input, i)
        : next === '{' ? readBracedExpansion(input, i).end
        : next === '(' ? readBalancedCommand(input, i + 2, '(', ')').end
        : i + 1;
      const stop = end === -1 ? input.length : end;
      body += input.slice(i, stop);
      i = stop;
      continue;
    }
    // A comment, where a word may start in a command's span: its text to
    // the line's end, quotes and all, is no syntax.
    if (ch === '#' && open === '(' && (i === pos || COMMENT_AFTER.includes(input[i - 1]))) {
      const newline = input.indexOf('\n', i);
      const stop = newline === -1 ? input.length : newline;
      body += input.slice(i, stop);
      i = stop;
      continue;
    }
    // A `<<` or `<<-` (not `<<<`): its delimiter word, its quotes removed, names where its body ends.
    if (ch === '<' && open === '(' && !arithmetic && input[i + 1] === '<' && input[i + 2] !== '<') {
      const stripTabs = input[i + 2] === '-';
      let at = i + (stripTabs ? 3 : 2);
      while (input[at] === ' ' || input[at] === '\t') at++;
      const word = readWord(input, at);
      if (word !== null) {
        heredocs.push({ delimiter: word.token.value, stripTabs });
        body += input.slice(i, word.end);
        i = word.end;
        continue;
      }
    }
    if (ch === '\n' && heredocs.length > 0) {
      i++;
      body += ch;
      for (const heredoc of heredocs) {
        while (i < input.length) {
          const line = readLine(input, i);
          body += input.slice(i, line.end);
          i = line.end;
          if (endsHeredoc(line.text, heredoc) || !line.hadNewline) break;
        }
      }
      heredocs.length = 0;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return { body, end: i + 1, closed: true };
    body += ch;
    i++;
  }

  return { body, end: i, closed: false };
}

/**
 * Where the `$'...'` at `pos` ends, just past its closing quote, or -1 when
 * the input ends first. A backslash takes the character after it, so `\'`
 * does not close it.
 */
function ansiCQuoteEnd(input: string, pos: number): number {
  let i = pos + 2;
  while (i < input.length && input[i] !== "'") i += input[i] === '\\' ? 2 : 1;
  return i < input.length ? i + 1 : -1;
}

/** The `$'...'` at `pos`: its text, escapes decoded (backslash-escapes.ts, `ansi-c`), and where it ends. */
export function readAnsiCQuote(input: string, pos: number): { text: string; end: number } {
  const end = ansiCQuoteEnd(input, pos);
  const body = input.slice(pos + 2, end === -1 ? input.length : end - 1);
  return { text: expandBackslashEscapes(body, 'ansi-c').text, end: end === -1 ? input.length : end };
}

/**
 * The quoted span at `pos`, whole. In double quotes a `$(...)`, `${...}` or
 * backtick substitution is its own span, so a `"` inside it does not close
 * the quote (`"$(echo ")")"`).
 */
function readQuoted(input: string, pos: number, quote: '"' | "'"): { text: string; end: number } {
  if (quote === "'") {
    const close = input.indexOf("'", pos + 1);
    const end = close === -1 ? input.length : close + 1;
    return { text: input.slice(pos, end), end };
  }
  let i = pos + 1;
  let text = quote;
  while (i < input.length) {
    const at = nextStop(input, i, DOUBLE_QUOTED_STOPS);
    text += input.slice(i, at);
    i = at;
    if (i === input.length) break;
    const ch = input[i];
    const next = input[i + 1];
    const end = ch === '"' ? i + 1
      : ch === '\\' ? Math.min(i + 2, input.length)
      : ch === '`' ? readBacktickSubstitution(input, i).end
      : next === '(' ? readCommandSubstitution(input, i).end
      : next === '{' ? readBracedExpansion(input, i).end
      : i + 1;
    text += input.slice(i, end);
    i = end;
    if (ch === '"') break;
  }
  return { text, end: i };
}
