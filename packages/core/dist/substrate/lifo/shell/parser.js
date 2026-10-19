import { lex } from './lexer.js';
import { TokenKind, } from './types.js';
export class ParseError extends Error {
    pos;
    constructor(message, pos) {
        super(message);
        this.pos = pos;
        this.name = 'ParseError';
    }
}
export function parse(tokens) {
    const parser = new Parser(tokens);
    return parser.parseScript();
}
/**
 * A word's text when it could be a reserved word: one part, unquoted, no
 * substitution in it; else null. Syntax is decided by the lexer's parts, never
 * by a word's text with its quoting gone: `'fi'` is a command named fi.
 */
function unquotedLiteral(token) {
    if (token.kind !== TokenKind.Word)
        return null;
    if (token.parts === undefined)
        return token.value;
    const [only] = token.parts;
    return token.parts.length === 1 && only !== undefined && only.quoted === 'none' && only.commandSubstitution === undefined
        ? only.text : null;
}
function isUnquotedLiteralWord(token, value) {
    return unquotedLiteral(token) === value;
}
/** A word as written, for a message: its quotes in it. */
function sourceOf(token) {
    return token.source ?? token.value;
}
const KEYWORDS = new Set([
    'if', 'then', 'else', 'elif', 'fi',
    'for', 'in', 'do', 'done',
    'while', 'until',
    'case', 'esac',
]);
/** Reserved words that cannot begin a command: where one does, unquoted, it is a syntax error, as bash's. */
const STRAY_RESERVED = new Set(['then', 'else', 'elif', 'fi', 'in', 'do', 'done', 'esac', '}', ']]']);
/** bash's legal_identifier. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** bash's check_identifier on a for variable (it must be a name) or a function name (`checkWord` false): its error, or null. */
function identifierError(token, checkWord) {
    const literal = unquotedLiteral(token);
    const valid = literal !== null && !literal.includes('$') && !/^[0-9]+$/.test(literal) && (!checkWord || IDENTIFIER.test(literal));
    return valid ? null : `\`${sourceOf(token)}': not a valid identifier`;
}
class Parser {
    tokens;
    pos = 0;
    pendingHeredocs = [];
    constructor(tokens) {
        this.tokens = tokens;
    }
    peek() {
        return this.tokens[this.pos] ?? { kind: TokenKind.EOF, value: '', pos: -1 };
    }
    peekAt(offset) {
        return this.tokens[this.pos + offset] ?? { kind: TokenKind.EOF, value: '', pos: -1 };
    }
    advance() {
        const token = this.peek();
        if (token.kind !== TokenKind.EOF) {
            this.pos++;
        }
        return token;
    }
    expect(kind) {
        const token = this.peek();
        if (token.kind !== kind) {
            throw new ParseError(`Expected ${TokenKind[kind]} but got ${TokenKind[token.kind]} ('${token.value}')`, token.pos);
        }
        return this.advance();
    }
    expectWord(value) {
        const token = this.peek();
        if (!isUnquotedLiteralWord(token, value)) {
            throw new ParseError(`Expected '${value}' but got '${token.value}'`, token.pos);
        }
        return this.advance();
    }
    isAtEnd() {
        return this.peek().kind === TokenKind.EOF;
    }
    isWord(value) {
        return isUnquotedLiteralWord(this.peek(), value);
    }
    skipNewlines() {
        while (this.peek().kind === TokenKind.Newline) {
            this.advance();
        }
    }
    parseScript() {
        const lists = [];
        // Skip leading separators
        this.skipSeparators();
        while (!this.isAtEnd()) {
            const prevPos = this.pos;
            const list = this.parseList();
            lists.push(list);
            const listEnd = this.pos;
            this.consumeHeredocBodies();
            this.skipSeparators();
            list.endsLine = this.isAtEnd() || this.tokens.slice(listEnd, this.pos).some((token) => token.kind === TokenKind.Newline);
            // Guard against infinite loop: if no progress was made, the current token
            // is unexpected (e.g. a stray '(' from pasted JS code). Throw so the
            // caller can display an error instead of hanging the browser.
            if (this.pos === prevPos) {
                throw new ParseError(`unexpected token '${this.peek().value}'`, this.peek().pos);
            }
        }
        return { type: 'script', lists };
    }
    skipSeparators() {
        while (this.peek().kind === TokenKind.Semi || this.peek().kind === TokenKind.Newline) {
            this.advance();
        }
    }
    parseList() {
        const entries = [];
        let background = false;
        // First pipeline
        const firstPipeline = this.parsePipeline();
        entries.push({ pipeline: firstPipeline, connector: null });
        // Chained pipelines with && or ||
        while (this.peek().kind === TokenKind.And || this.peek().kind === TokenKind.Or) {
            const connectorToken = this.advance();
            const connector = connectorToken.value;
            // Update the previous entry's connector
            entries[entries.length - 1].connector = connector;
            this.skipNewlines();
            const pipeline = this.parsePipeline();
            entries.push({ pipeline, connector: null });
        }
        // Check for background &
        if (this.peek().kind === TokenKind.Amp) {
            this.advance();
            background = true;
        }
        return { type: 'list', entries, background };
    }
    parsePipeline() {
        let negated = false;
        // Check for ! prefix
        if (isUnquotedLiteralWord(this.peek(), '!')) {
            negated = true;
            this.advance();
        }
        const commands = [];
        commands.push(this.parseCommand());
        while (this.peek().kind === TokenKind.Pipe) {
            this.advance();
            this.skipNewlines();
            commands.push(this.parseCommand());
        }
        return { type: 'pipeline', commands, negated };
    }
    parseCommand() {
        const token = this.peek();
        // Check for compound command keywords: a reserved word only unquoted.
        if (token.kind === TokenKind.Word) {
            const keyword = unquotedLiteral(token);
            if (keyword === '[[') {
                return this.parseDoubleBracketCommand();
            }
            switch (keyword) {
                case 'if': return this.parseIf();
                case 'for': return this.parseFor();
                case 'while':
                case 'until': return this.parseLoop(keyword);
                case 'case': return this.parseCase();
            }
            if (keyword !== null && STRAY_RESERVED.has(keyword)) {
                throw new ParseError(`syntax error near unexpected token \`${keyword}'`, token.pos);
            }
            // Check for function definition: name () { ... }
            if (this.peekAt(1).kind === TokenKind.LParen && this.peekAt(2).kind === TokenKind.RParen) {
                // Don't treat keywords as function names
                if (keyword === null || !KEYWORDS.has(keyword)) {
                    return this.parseFunctionDef();
                }
            }
            // { ... } group
            if (keyword === '{') {
                return this.parseGroup();
            }
        }
        if (token.kind === TokenKind.LParen) {
            return this.parseSubshell();
        }
        return this.parseSimpleCommand();
    }
    parseDoubleBracketCommand() {
        this.advance();
        const words = [];
        while (!this.isAtEnd()) {
            const token = this.advance();
            if (isUnquotedLiteralWord(token, ']]')) {
                return {
                    type: 'double_bracket',
                    words,
                    redirections: this.parseTrailingRedirections(),
                };
            }
            words.push(this.doubleBracketTokenParts(token));
        }
        throw new ParseError('missing ]]', this.peek().pos);
    }
    doubleBracketTokenParts(token) {
        if (token.kind === TokenKind.Word) {
            return token.parts ?? [{ text: token.value, quoted: 'none' }];
        }
        return [{ text: token.value, quoted: 'none' }];
    }
    parseCompoundList(terminators) {
        const lists = [];
        this.skipSeparators();
        while (!this.isAtEnd()) {
            const prevPos = this.pos;
            // Check terminators
            const t = this.peek();
            const word = unquotedLiteral(t);
            if (word !== null && terminators.includes(word)) {
                break;
            }
            if (t.kind === TokenKind.RParen && terminators.includes(')')) {
                break;
            }
            if (t.kind === TokenKind.EOF)
                break;
            lists.push(this.parseList());
            this.consumeHeredocBodies();
            this.skipSeparators();
            if (this.pos === prevPos) {
                throw new ParseError(`unexpected token '${this.peek().value}'`, this.peek().pos);
            }
        }
        return lists;
    }
    parseIf() {
        this.expectWord('if');
        const clauses = [];
        let elseBody = null;
        // Parse first if clause
        const condition = this.parseCompoundList(['then']);
        this.expectWord('then');
        const body = this.parseCompoundList(['elif', 'else', 'fi']);
        clauses.push({ condition, body });
        // Parse elif clauses
        while (this.isWord('elif')) {
            this.advance();
            const elifCondition = this.parseCompoundList(['then']);
            this.expectWord('then');
            const elifBody = this.parseCompoundList(['elif', 'else', 'fi']);
            clauses.push({ condition: elifCondition, body: elifBody });
        }
        // Parse else clause
        if (this.isWord('else')) {
            this.advance();
            elseBody = this.parseCompoundList(['fi']);
        }
        this.expectWord('fi');
        const redirections = this.parseTrailingRedirections();
        return { type: 'if', clauses, elseBody, redirections };
    }
    parseFor() {
        this.expectWord('for');
        const varToken = this.expect(TokenKind.Word);
        const variable = varToken.value;
        const variableError = identifierError(varToken, true);
        this.skipNewlines();
        let words = null;
        // Optional 'in word...'
        if (this.isWord('in')) {
            this.advance();
            words = [];
            while (!this.isAtEnd()) {
                const t = this.peek();
                if (t.kind === TokenKind.Semi || t.kind === TokenKind.Newline)
                    break;
                if (isUnquotedLiteralWord(t, 'do'))
                    break;
                if (t.kind !== TokenKind.Word)
                    break;
                this.advance();
                words.push(t.parts ?? [{ text: t.value, quoted: 'none' }]);
            }
        }
        // Consume separator before 'do'
        this.skipSeparators();
        this.expectWord('do');
        const body = this.parseCompoundList(['done']);
        this.expectWord('done');
        const redirections = this.parseTrailingRedirections();
        return { type: 'for', variable, ...(variableError === null ? {} : { variableError }), words, body, redirections };
    }
    parseLoop(keyword) {
        this.expectWord(keyword);
        const condition = this.parseCompoundList(['do']);
        this.expectWord('do');
        const body = this.parseCompoundList(['done']);
        this.expectWord('done');
        const redirections = this.parseTrailingRedirections();
        return { type: keyword, condition, body, redirections };
    }
    parseCase() {
        this.expectWord('case');
        const wordToken = this.expect(TokenKind.Word);
        const word = wordToken.parts ?? [{ text: wordToken.value, quoted: 'none' }];
        this.skipNewlines();
        this.expectWord('in');
        this.skipSeparators();
        const items = [];
        while (!this.isAtEnd() && !this.isWord('esac')) {
            // Optional leading (
            if (this.peek().kind === TokenKind.LParen) {
                this.advance();
            }
            // Parse patterns separated by |
            const patterns = [];
            const patToken = this.expect(TokenKind.Word);
            patterns.push(patToken.parts ?? [{ text: patToken.value, quoted: 'none' }]);
            while (this.peek().kind === TokenKind.Pipe) {
                this.advance();
                const nextPat = this.expect(TokenKind.Word);
                patterns.push(nextPat.parts ?? [{ text: nextPat.value, quoted: 'none' }]);
            }
            // Expect )
            this.expect(TokenKind.RParen);
            // Parse body until ;; or esac
            const body = [];
            this.skipNewlines();
            while (!this.isAtEnd()) {
                const prevPos = this.pos;
                const t = this.peek();
                if (t.kind === TokenKind.DoubleSemi)
                    break;
                if (isUnquotedLiteralWord(t, 'esac'))
                    break;
                if (t.kind === TokenKind.EOF)
                    break;
                body.push(this.parseList());
                this.skipSeparators();
                if (this.pos === prevPos) {
                    throw new ParseError(`unexpected token '${this.peek().value}'`, this.peek().pos);
                }
            }
            items.push({ patterns, body });
            // Consume ;;
            if (this.peek().kind === TokenKind.DoubleSemi) {
                this.advance();
                this.skipSeparators();
            }
        }
        this.expectWord('esac');
        const redirections = this.parseTrailingRedirections();
        return { type: 'case', word, items, redirections };
    }
    parseFunctionDef() {
        const nameToken = this.advance(); // consume name
        const name = nameToken.value;
        const nameError = identifierError(nameToken, false);
        this.expect(TokenKind.LParen);
        this.expect(TokenKind.RParen);
        this.skipNewlines();
        const body = this.parseCommand();
        return { type: 'function_def', name, ...(nameError === null ? {} : { nameError }), body };
    }
    parseGroup() {
        this.expectWord('{');
        const body = this.parseCompoundList(['}']);
        this.expectWord('}');
        const redirections = this.parseTrailingRedirections();
        return { type: 'group', body, redirections };
    }
    parseSubshell() {
        this.expect(TokenKind.LParen);
        const body = this.parseCompoundList([')']);
        this.expect(TokenKind.RParen);
        const redirections = this.parseTrailingRedirections();
        return { type: 'subshell', body, redirections };
    }
    parseTrailingRedirections() {
        const redirections = [];
        while (this.isRedirectOperator(this.peek().kind)) {
            redirections.push(this.parseRedirection());
        }
        return redirections;
    }
    parseSimpleCommand() {
        const assignments = [];
        const words = [];
        const redirections = [];
        while (!this.isAtEnd()) {
            const token = this.peek();
            // Check for redirections
            if (this.isRedirectOperator(token.kind)) {
                redirections.push(this.parseRedirection());
                continue;
            }
            // Check for word tokens
            if (token.kind === TokenKind.Word) {
                // Don't consume keywords that are terminators in compound commands
                // (only when no words have been accumulated yet -- empty command)
                // This check is not needed here since parseCommand dispatches before us
                // Check for VAR=value assignment (only before any regular words)
                if (words.length === 0) {
                    const assignment = parseAssignment(token);
                    if (assignment !== null) {
                        this.advance();
                        assignments.push(assignment);
                        continue;
                    }
                }
                this.advance();
                const parts = token.parts ?? [{ text: token.value, quoted: 'none' }];
                words.push(parts);
                continue;
            }
            // Anything else (operator) ends this command
            break;
        }
        return { type: 'simple_command', assignments, words, redirections };
    }
    parseRedirection() {
        const operatorToken = this.advance();
        if (operatorToken.kind === TokenKind.Heredoc || operatorToken.kind === TokenKind.HeredocStripTabs) {
            return this.parseHeredocRedirection(operatorToken, operatorToken.kind === TokenKind.HeredocStripTabs);
        }
        let operator = this.redirectionOperator(operatorToken.kind);
        const fd = operatorToken.fd ?? this.defaultRedirectionFd(operatorToken.kind);
        if (this.peek().kind === TokenKind.Amp) {
            this.advance();
            switch (operator) {
                case 'write':
                    operator = 'dupOutput';
                    break;
                case 'read':
                    operator = 'dupInput';
                    break;
                default:
                    throw new ParseError(`Unexpected file descriptor duplication after '${operatorToken.value}'`, operatorToken.pos);
            }
        }
        const targetToken = this.expect(TokenKind.Word);
        return {
            operator,
            fd,
            target: targetToken.parts ?? [{ text: targetToken.value, quoted: 'none' }],
        };
    }
    parseHeredocRedirection(operatorToken, stripTabs) {
        const targetToken = this.expect(TokenKind.Word);
        const redirection = {
            operator: 'heredoc',
            fd: operatorToken.fd ?? 0,
            target: targetToken.parts ?? [{ text: targetToken.value, quoted: 'none' }],
            heredoc: {
                body: '',
                quoted: false,
                stripTabs,
            },
        };
        this.pendingHeredocs.push(redirection);
        return redirection;
    }
    consumeHeredocBodies() {
        if (this.pendingHeredocs.length === 0)
            return;
        while (this.peek().kind === TokenKind.Newline)
            this.advance();
        while (this.pendingHeredocs.length > 0) {
            const target = this.pendingHeredocs.shift();
            if (!target)
                break;
            const bodyToken = this.expect(TokenKind.HeredocBody);
            target.heredoc = {
                body: bodyToken.value,
                quoted: bodyToken.heredocQuoted ?? false,
                stripTabs: target.heredoc?.stripTabs ?? false,
            };
        }
    }
    redirectionOperator(kind) {
        switch (kind) {
            case TokenKind.Heredoc:
            case TokenKind.HeredocStripTabs:
                return 'heredoc';
            case TokenKind.RedirectOut:
            case TokenKind.RedirectErr:
                return 'write';
            case TokenKind.RedirectAppend:
            case TokenKind.RedirectErrAppend:
                return 'append';
            case TokenKind.RedirectIn:
                return 'read';
            case TokenKind.RedirectReadWrite:
                return 'readWrite';
            case TokenKind.RedirectAll:
                return 'writeAll';
            default:
                throw new ParseError(`Expected redirection but got ${TokenKind[kind]}`, this.peek().pos);
        }
    }
    defaultRedirectionFd(kind) {
        switch (kind) {
            case TokenKind.RedirectErr:
            case TokenKind.RedirectErrAppend:
                return 2;
            case TokenKind.RedirectIn:
            case TokenKind.Heredoc:
            case TokenKind.HeredocStripTabs:
            case TokenKind.RedirectReadWrite:
                return 0;
            case TokenKind.RedirectOut:
            case TokenKind.RedirectAppend:
                return 1;
            case TokenKind.RedirectAll:
                return null;
            default:
                throw new ParseError(`Expected redirection but got ${TokenKind[kind]}`, this.peek().pos);
        }
    }
    isRedirectOperator(kind) {
        return kind === TokenKind.RedirectOut
            || kind === TokenKind.RedirectAppend
            || kind === TokenKind.RedirectIn
            || kind === TokenKind.RedirectReadWrite
            || kind === TokenKind.Heredoc
            || kind === TokenKind.HeredocStripTabs
            || kind === TokenKind.RedirectErr
            || kind === TokenKind.RedirectErrAppend
            || kind === TokenKind.RedirectAll;
    }
}
/**
 * `NAME=value`, `NAME+=value`, `NAME[expr]=value` and `NAME=(word …)`.
 *
 * As bash's assignment(): the name, the brackets, `+` and `=` are the word's
 * own unquoted characters, so `'x=y'` and `x"="y` are commands named so. A
 * subscript's characters may be quoted. The lexer keeps a parenthesised list
 * attached to its assignment, unquoted, so an array assignment arrives as one
 * word of one unquoted part, `(` to `)`: `x='(a b)'` is a scalar. Returns null
 * for anything that is an ordinary word rather than an assignment.
 */
function parseAssignment(token) {
    const head = assignmentHead(token);
    if (head === null)
        return null;
    const { length, name, subscript, append } = head;
    const value = partsAfter(token, length);
    const assignment = { name, value };
    if (subscript !== undefined)
        assignment.subscript = subscript;
    if (append)
        assignment.append = true;
    const whole = token.parts === undefined || token.parts.length === 1 ? unquotedLiteral(token) : null;
    const elements = whole === null || subscript !== undefined ? null : parseArrayLiteral(whole.slice(length));
    if (elements !== null) {
        assignment.elements = elements;
        assignment.value = [];
    }
    return assignment;
}
/** An assignment word's prefix: its length in the word's characters, its name, subscript and `+`; or null. */
function assignmentHead(token) {
    const parts = token.parts ?? [{ text: token.value, quoted: 'none' }];
    const [first] = parts;
    if (first === undefined || first.quoted !== 'none' || first.commandSubstitution !== undefined)
        return null;
    const name = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(first.text)?.[0];
    if (name === undefined)
        return null;
    // The characters after the name, each with whether it is quoted.
    let part = 0;
    let at = name.length;
    let length = name.length;
    const next = () => {
        for (; part < parts.length; part++, at = 0) {
            const current = parts[part];
            if (current === undefined || at >= current.text.length)
                continue;
            const char = current.text.charAt(at++);
            length++;
            return { char, quoted: current.quoted !== 'none' || current.commandSubstitution !== undefined };
        }
        return null;
    };
    let char = next();
    let subscript;
    if (char !== null && char.char === '[' && !char.quoted) {
        let text = '';
        let depth = 1;
        for (char = next(); char !== null; char = next()) {
            if (!char.quoted && char.char === '[')
                depth++;
            if (!char.quoted && char.char === ']' && --depth === 0)
                break;
            text += char.char;
        }
        if (char === null)
            return null;
        subscript = text;
        char = next();
    }
    let append = false;
    if (char !== null && char.char === '+' && !char.quoted) {
        append = true;
        char = next();
    }
    if (char === null || char.char !== '=' || char.quoted)
        return null;
    return { length, name, ...(subscript === undefined ? {} : { subscript }), append };
}
/**
 * Whether `parts` is a compound array assignment as written: one unquoted part,
 * `name=(` to `)`, the form the lexer attaches. A declaration builtin's
 * argument is an array literal only so: `declare x='(a b)'` is a scalar.
 */
export function isArrayLiteralWord(parts) {
    const [only] = parts;
    return parts.length === 1 && only !== undefined && only.quoted === 'none' && only.commandSubstitution === undefined
        && /^[a-zA-Z_][a-zA-Z0-9_]*\+?=\(.*\)$/s.test(only.text);
}
/** `(word …)` — the words inside are lexed and expanded like any argument. */
function parseArrayLiteral(text) {
    if (!text.startsWith('(') || !text.endsWith(')'))
        return null;
    const elements = [];
    for (const token of lex(text.slice(1, -1))) {
        if (token.kind !== TokenKind.Word)
            continue;
        elements.push(token.parts ?? [{ text: token.value, quoted: 'none' }]);
    }
    return elements;
}
/** The word parts that fall after `offset` characters of a token's text. */
function partsAfter(token, offset) {
    if (!token.parts)
        return [{ text: token.value.slice(offset), quoted: 'none' }];
    const parts = [];
    let consumed = 0;
    for (const part of token.parts) {
        const end = consumed + part.text.length;
        if (end <= offset) {
            consumed = end;
            continue;
        }
        parts.push(consumed < offset ? { ...part, text: part.text.slice(offset - consumed) } : part);
        consumed = end;
    }
    if (parts.length === 0)
        parts.push({ text: '', quoted: 'none' });
    return parts;
}
