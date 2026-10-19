import { TokenKind } from './types.js';
import { expandBackslashEscapes } from '../utils/backslash-escapes.js';
export function lex(input) {
    return lexText(input).tokens;
}
/**
 * The tokens of `input`, and whether it ends inside a comment, which takes the
 * rest of its line: what would follow it there is no word (an alias whose text
 * ends in `#…`).
 */
export function lexText(input) {
    const tokens = [];
    let endsInComment = false;
    const pendingHeredocs = [];
    let nextHeredocOperator = null;
    let i = 0;
    while (i < input.length) {
        // Skip whitespace (but NOT newlines -- they become Newline tokens)
        if (input[i] === ' ' || input[i] === '\t') {
            i++;
            continue;
        }
        // A line continuation between words is no word and no newline.
        if (input[i] === '\\' && input[i + 1] === '\n') {
            i += 2;
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
            endsInComment = i >= input.length;
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
    return { tokens, endsInComment };
}
/**
 * How `input` leaves the lexer at end of input: inside an unclosed single or
 * double quote, or ending in a `\` line continuation (which bash also honors
 * inside double quotes, where `\<newline>` is removed). The interactive shell
 * uses this to keep reading (PS2) instead of executing a truncated command.
 * Comments are skipped exactly where lex() treats `#` as one.
 */
export function continuationState(input) {
    let quote = null;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (quote === "'") {
            if (ch === "'")
                quote = null;
            continue;
        }
        if (ch === '\\') {
            if (i === input.length - 1)
                return 'backslash';
            i++;
            continue;
        }
        if (quote === '"') {
            if (ch === '"')
                quote = null;
            continue;
        }
        // $$, the shell's pid, is two dollars: a quote after it is its own.
        if (ch === '$' && input[i + 1] === '$') {
            i++;
            continue;
        }
        if (ch === '$' && input[i + 1] === "'") {
            const end = ansiCQuoteEnd(input, i);
            if (end === -1)
                return 'single';
            i = end - 1;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === '#') {
            while (i + 1 < input.length && input[i + 1] !== '\n')
                i++;
        }
    }
    if (quote === null)
        return null;
    return quote === '"' ? 'double' : 'single';
}
function tryOperator(input, pos) {
    const ch = input[pos];
    const next = input[pos + 1];
    const fdRedirect = tryFdRedirectOperator(input, pos);
    if (fdRedirect)
        return fdRedirect;
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
/** Whether `line` ends a here-document opened with `delimiter` (`stripTabs`: by `<<-`, whose lines lose their leading tabs). */
export function endsHeredoc(line, heredoc) {
    return (heredoc.stripTabs ? stripLeadingTabs(line) : line) === heredoc.delimiter;
}
function readHeredocBodies(input, pos, heredocs) {
    const tokens = [];
    let i = pos;
    for (const heredoc of heredocs) {
        const bodyStart = i;
        const lines = [];
        let terminated = false;
        while (i < input.length) {
            const line = readLine(input, i);
            i = line.end;
            if (endsHeredoc(line.text, heredoc)) {
                terminated = true;
                break;
            }
            lines.push(heredoc.stripTabs ? stripLeadingTabs(line.text) : line.text);
            if (!line.hadNewline)
                break;
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
function readLine(input, pos) {
    let i = pos;
    while (i < input.length && input[i] !== '\n')
        i++;
    const end = input[i - 1] === '\r' ? i - 1 : i;
    const text = input.slice(pos, end);
    if (i < input.length && input[i] === '\n') {
        return { text, end: i + 1, hadNewline: true };
    }
    return { text, end: i, hadNewline: false };
}
function stripLeadingTabs(input) {
    let i = 0;
    while (input[i] === '\t')
        i++;
    return input.slice(i);
}
function wordHasQuotedParts(token) {
    return token.parts?.some((part) => part.quoted !== 'none') ?? false;
}
function tryFdRedirectOperator(input, pos) {
    if (pos > 0 && !isOperatorBreak(input[pos - 1]))
        return null;
    if (!isDigit(input[pos]))
        return null;
    let fdEnd = pos;
    while (isDigit(input[fdEnd]))
        fdEnd++;
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
function isDigit(ch) {
    return ch !== undefined && ch >= '0' && ch <= '9';
}
function isOperatorBreak(ch) {
    return ch === ' ' || ch === '\t' || ch === '|' || ch === '&' || ch === ';'
        || ch === '>' || ch === '<' || ch === '\n' || ch === '(' || ch === ')';
}
function isWordBreak(ch) {
    return ch === ' ' || ch === '\t' || ch === '|' || ch === '&' || ch === ';'
        || ch === '>' || ch === '<' || ch === '#' || ch === '\n' || ch === '(' || ch === ')';
}
/** Everything a word may hold before the `(` of an array assignment. */
const ARRAY_ASSIGNMENT_PREFIX = /^[a-zA-Z_][a-zA-Z0-9_]*(\[[^\]]*\])?\+?=$/;
function readWord(input, pos) {
    const parts = [];
    // Each $'…' span and its decoded text: bash's reader keeps the word with it as '…'.
    const ansiC = [];
    let i = pos;
    let currentText = '';
    let hasContent = false;
    const flushCurrentText = () => {
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
            if (i < input.length)
                i++; // skip closing quote
            hasContent = true;
            continue;
        }
        // Double quote
        if (ch === '"') {
            flushCurrentText();
            i++; // skip opening quote
            let dqText = '';
            let doubleQuotedContent = false;
            const flushDoubleText = () => {
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
                    }
                    else {
                        dqText += '\\';
                        i++;
                    }
                }
                else if (input[i] === '$' && input[i + 1] === '{') {
                    const braced = readBracedExpansion(input, i);
                    dqText += braced.text;
                    i = braced.end;
                }
                else if (input[i] === '$' && input[i + 1] === '(') {
                    const subst = readCommandSubstitution(input, i);
                    if (subst.kind === 'command') {
                        flushDoubleText();
                        parts.push({
                            text: subst.text,
                            quoted: 'double',
                            commandSubstitution: subst.command,
                        });
                    }
                    else {
                        dqText += subst.text;
                    }
                    i = subst.end;
                }
                else if (input[i] === '`') {
                    const subst = readBacktickSubstitution(input, i);
                    if (subst.kind === 'command') {
                        flushDoubleText();
                        parts.push({
                            text: subst.text,
                            quoted: 'double',
                            commandSubstitution: subst.command,
                        });
                    }
                    else {
                        dqText += subst.text;
                    }
                    i = subst.end;
                }
                else {
                    dqText += input[i];
                    i++;
                }
                doubleQuotedContent = true;
            }
            if (dqText || !doubleQuotedContent) {
                parts.push({ text: dqText, quoted: 'double' });
            }
            if (i < input.length)
                i++; // skip closing quote
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
            }
            else {
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
            }
            else {
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
    if (!hasContent)
        return null;
    flushCurrentText();
    // Build combined value for backward compatibility
    const value = parts.map((p) => p.text).join('');
    return {
        token: { kind: TokenKind.Word, value, pos, parts, source: writtenWord(input, pos, i, ansiC) },
        end: i,
    };
}
/** The word from `pos` to `end` as bash's reader keeps it: its quotes in it, each $'…' as '…' decoded. */
function writtenWord(input, pos, end, ansiC) {
    let written = '';
    let at = pos;
    for (const span of ansiC) {
        written += `${input.slice(at, span.start)}'${span.text}'`;
        at = span.end;
    }
    return written + input.slice(at, end);
}
function readCommandSubstitution(input, pos) {
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
function readArithmeticSubstitution(input, pos) {
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
function readBacktickSubstitution(input, pos) {
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
export function readBracedExpansion(input, pos) {
    const balanced = readBalancedCommand(input, pos + 2, '{', '}');
    return { text: input.slice(pos, balanced.end), inner: balanced.body, end: balanced.end };
}
/** What a `#` that starts a comment may follow: a blank, or an operator that ends a word. */
const COMMENT_AFTER = ' \t\n;&|()<>';
/** A table of the ASCII characters in `chars`, for nextStop. */
function stopTable(chars) {
    const table = new Uint8Array(128);
    for (const c of chars)
        table[c.charCodeAt(0)] = 1;
    return table;
}
/** Where a balanced span's scan must look, by its brackets: every other character is body as it stands. */
const SPAN_STOPS = {
    '(': stopTable('\\\'"$`#()<\n'),
    '{': stopTable('\\\'"$`#{}'),
};
/** Where a double-quoted span's scan must look. */
const DOUBLE_QUOTED_STOPS = stopTable('"\\$`');
/** The first index from `i` whose character `stops` marks, or the input's length. */
function nextStop(input, i, stops) {
    for (; i < input.length; i++) {
        const c = input.charCodeAt(i);
        if (c < 128 && stops[c] === 1)
            return i;
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
export function readBalancedCommand(input, pos, open, close) {
    const arithmetic = open === '(' && input[pos] === '(' && input[pos - 1] === '(' && input[pos - 2] === '$';
    const stops = SPAN_STOPS[open];
    let i = pos;
    let depth = 1;
    let body = '';
    // The here-documents whose bodies follow the next newline.
    const heredocs = [];
    while (i < input.length) {
        // Characters that are no syntax here go into the body as one run.
        const at = nextStop(input, i, stops);
        if (at > i) {
            body += input.slice(i, at);
            i = at;
            if (i === input.length)
                break;
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
            while (input[at] === ' ' || input[at] === '\t')
                at++;
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
                    if (endsHeredoc(line.text, heredoc) || !line.hadNewline)
                        break;
                }
            }
            heredocs.length = 0;
            continue;
        }
        if (ch === open)
            depth++;
        else if (ch === close && --depth === 0)
            return { body, end: i + 1, closed: true };
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
function ansiCQuoteEnd(input, pos) {
    let i = pos + 2;
    while (i < input.length && input[i] !== "'")
        i += input[i] === '\\' ? 2 : 1;
    return i < input.length ? i + 1 : -1;
}
/** The `$'...'` at `pos`: its text, escapes decoded (backslash-escapes.ts, `ansi-c`), and where it ends. */
export function readAnsiCQuote(input, pos) {
    const end = ansiCQuoteEnd(input, pos);
    const body = input.slice(pos + 2, end === -1 ? input.length : end - 1);
    return { text: expandBackslashEscapes(body, 'ansi-c').text, end: end === -1 ? input.length : end };
}
/**
 * The quoted span at `pos`, whole. In double quotes a `$(...)`, `${...}` or
 * backtick substitution is its own span, so a `"` inside it does not close
 * the quote (`"$(echo ")")"`).
 */
function readQuoted(input, pos, quote) {
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
        if (i === input.length)
            break;
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
        if (ch === '"')
            break;
    }
    return { text, end: i };
}
