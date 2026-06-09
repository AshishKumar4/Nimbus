import { TokenKind, type Token, type WordPart } from './types.js';

export function lex(input: string): Token[] {
  const tokens: Token[] = [];
  const pendingHeredocs: HeredocDelimiter[] = [];
  let nextHeredocOperator: TokenKind.Heredoc | TokenKind.HeredocStripTabs | null = null;
  let i = 0;

  while (i < input.length) {
    // Skip whitespace (but NOT newlines -- they become Newline tokens)
    if (input[i] === ' ' || input[i] === '\t') {
      i++;
      continue;
    }

    // Newline
    if (input[i] === '\n') {
      tokens.push({ kind: TokenKind.Newline, value: '\n', pos: i });
      i++;
      if (pendingHeredocs.length > 0) {
        const bodies = readHeredocBodies(input, i, pendingHeredocs);
        tokens.push(...bodies.tokens);
        i = bodies.end;
        pendingHeredocs.length = 0;
      }
      continue;
    }

    // Comment -- skip to end of line
    if (input[i] === '#') {
      while (i < input.length && input[i] !== '\n') {
        i++;
      }
      continue;
    }

    // Operators
    const op = tryOperator(input, i);
    if (op) {
      tokens.push(op.token);
      if (op.token.kind === TokenKind.Heredoc || op.token.kind === TokenKind.HeredocStripTabs) {
        nextHeredocOperator = op.token.kind;
      }
      i = op.end;
      continue;
    }

    // Word (may include quotes, escapes, $(), globs, variables)
    const word = readWord(input, i);
    if (word) {
      tokens.push(word.token);
      if (nextHeredocOperator !== null) {
        pendingHeredocs.push({
          delimiter: word.token.value,
          quoted: wordHasQuotedParts(word.token),
          stripTabs: nextHeredocOperator === TokenKind.HeredocStripTabs,
        });
        nextHeredocOperator = null;
      }
      i = word.end;
      continue;
    }

    // Shouldn't reach here, but advance to avoid infinite loop
    i++;
  }

  tokens.push({ kind: TokenKind.EOF, value: '', pos: i });
  return tokens;
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

    while (i < input.length) {
      const line = readLine(input, i);
      const comparable = heredoc.stripTabs ? stripLeadingTabs(line.text) : line.text;
      i = line.end;

      if (comparable === heredoc.delimiter) {
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

function isWordBreak(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '|' || ch === '&' || ch === ';'
    || ch === '>' || ch === '<' || ch === '#' || ch === '\n' || ch === '(' || ch === ')';
}

function readWord(input: string, pos: number): { token: Token; end: number } | null {
  const parts: WordPart[] = [];
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
          // Inside double quotes, only these chars are special with backslash
          if (nextCh === '"' || nextCh === '\\' || nextCh === '$' || nextCh === '`') {
            flushDoubleText();
            parts.push({ text: nextCh, quoted: 'single' });
            doubleQuotedContent = true;
            i += 2;
          } else {
            dqText += '\\';
            i++;
          }
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
      currentText += '${';
      let j = i + 2;
      let depth = 1;
      while (j < input.length && depth > 0) {
        if (input[j] === '{') depth++;
        else if (input[j] === '}') depth--;
        if (depth > 0) {
          currentText += input[j];
        }
        j++;
      }
      currentText += '}';
      i = j;
      hasContent = true;
      continue;
    }

    // $# $@ $N $? -- special variables that start with $
    if (ch === '$' && i + 1 < input.length) {
      const nc = input[i + 1];
      if (nc === '#' || nc === '@' || nc === '?' || /[0-9]/.test(nc)) {
        currentText += '$' + nc;
        i += 2;
        hasContent = true;
        continue;
      }
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
    token: { kind: TokenKind.Word, value, pos, parts },
    end: i,
  };
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

function readBalancedCommand(
  input: string,
  pos: number,
  open: string,
  close: string,
): { body: string; end: number; closed: boolean } {
  let i = pos;
  let depth = 1;
  let body = '';

  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\' && i + 1 < input.length) {
      body += input.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'") {
      const quoted = readQuoted(input, i, "'");
      body += quoted.text;
      i = quoted.end;
      continue;
    }
    if (ch === '"') {
      const quoted = readQuoted(input, i, '"');
      body += quoted.text;
      i = quoted.end;
      continue;
    }
    if (ch === open) {
      depth++;
      body += ch;
      i++;
      continue;
    }
    if (ch === close) {
      depth--;
      if (depth === 0) {
        return { body, end: i + 1, closed: true };
      }
      body += ch;
      i++;
      continue;
    }
    body += ch;
    i++;
  }

  return { body, end: i, closed: false };
}

function readQuoted(input: string, pos: number, quote: '"' | "'"): { text: string; end: number } {
  let i = pos + 1;
  let text = quote;

  while (i < input.length) {
    const ch = input[i];
    text += ch;
    i++;
    if (quote === '"' && ch === '\\' && i < input.length) {
      text += input[i];
      i++;
      continue;
    }
    if (ch === quote) break;
  }

  return { text, end: i };
}
