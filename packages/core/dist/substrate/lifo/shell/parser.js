import { arithmeticForParts, lexArrayElements, TokenReader } from './lexer.js';
import { BINARY_OPERATORS, UNARY_OPERATORS } from './conditional-operators.js';
import { TokenKind, } from './types.js';
export class ParseError extends Error {
    pos;
    constructor(message, pos) {
        super(message);
        this.pos = pos;
        this.name = 'ParseError';
    }
}
export function parse(input, options = {}) {
    const parser = new Parser(new TokenReader(input), options);
    return parser.parseScript();
}
/**
 * A text's commands, read a line at a time, as bash's reader reads them: a
 * line is read whole (a syntax error in it runs none of it) only once the
 * lines before it have run, so an alias they define is expanded in it, and a
 * syntax error in a later line leaves the earlier ones run.
 */
export class ScriptLines {
    parser;
    constructor(input, options = {}) {
        this.parser = new Parser(new TokenReader(input), options);
    }
    /** The next line's lists, or null at the text's end; a ParseError when it is no command. */
    nextLine() {
        return this.parser.nextLine();
    }
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
/** The alias a word may name: one unquoted part, with no expansion in it. */
function aliasName(token) {
    const text = unquotedLiteral(token);
    return text === null || /[$`/=]/.test(text) ? null : text;
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
const endsNothing = () => false;
const endsCaseItem = (token) => token.kind === TokenKind.DoubleSemi || isUnquotedLiteralWord(token, 'esac');
class Parser {
    reader;
    // The tokens read so far, and for a token that began a batch the reader's mark before it.
    tokens = [];
    marks = [];
    pos = 0;
    pendingHeredocs = [];
    aliases;
    constructor(reader, options) {
        this.reader = reader;
        this.aliases = options.aliases;
    }
    /**
     * The word at a command's start (or one after an alias whose text ended in
     * a blank): while it names an alias whose text is not being read, read
     * that text in its place, as bash's reader does, before any reserved word
     * is recognized. Whether it did.
     */
    expandAliases() {
        let expanded = false;
        for (;;) {
            const token = this.peek();
            const name = aliasName(token);
            const value = name === null || token.aliases?.has(name) === true ? undefined : this.aliases?.(name);
            if (name === null || value === undefined)
                return expanded;
            // Forget the word, and anything read after it, and read the alias's text after where the word ended.
            const after = this.marks[this.pos + 1];
            if (this.tokens.length > this.pos + 1) {
                if (after === undefined)
                    throw new ParseError('internal: a word read again began no batch', token.pos);
                this.reader.reset(after);
            }
            this.tokens.length = this.pos;
            this.marks.length = this.pos;
            this.reader.pushAlias(name, value);
            expanded = true;
        }
    }
    /** Read until token `index` is there, or the input has ended. */
    fill(index) {
        while (this.tokens.length <= index && this.tokens.at(-1)?.kind !== TokenKind.EOF) {
            const mark = this.reader.mark();
            const batch = this.reader.next();
            this.marks[this.tokens.length] = mark;
            for (const token of batch)
                this.tokens.push(token);
        }
    }
    peek() {
        this.fill(this.pos);
        return this.tokens[this.pos] ?? { kind: TokenKind.EOF, value: '', pos: -1 };
    }
    peekAt(offset) {
        this.fill(this.pos + offset);
        return this.tokens[this.pos + offset] ?? { kind: TokenKind.EOF, value: '', pos: -1 };
    }
    /**
     * Read the current token again in a mode of its own: forget it and every
     * token after it, and go back to where it began. It began a batch: it is
     * read after a word.
     */
    rereadFromHere() {
        this.fill(this.pos);
        const mark = this.marks[this.pos];
        if (mark === undefined)
            throw new ParseError('internal: a token read again began no batch', this.peek().pos);
        this.tokens.length = this.pos;
        this.marks.length = this.pos;
        this.reader.reset(mark);
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
        for (let line = this.nextLine(); line !== null; line = this.nextLine())
            for (const list of line)
                lists.push(list);
        return { type: 'script', lists };
    }
    /** The next line's lists, read whole; null at the end. */
    nextLine() {
        this.skipSeparators();
        if (this.isAtEnd())
            return null;
        const lists = [];
        for (;;) {
            const prevPos = this.pos;
            const list = this.parseList();
            lists.push(list);
            this.requireListEnd(list, endsNothing);
            // Its separators: a newline ends the line (read no further, so the next line is read after this one runs).
            let newline = this.consumeHeredocBodies();
            while (!newline && (this.peek().kind === TokenKind.Semi || this.peek().kind === TokenKind.Newline)) {
                newline = this.consumeHeredocBodies() || this.advance().kind === TokenKind.Newline;
            }
            // Guard against infinite loop: if no progress was made, the current token
            // is unexpected (e.g. a stray '(' from pasted JS code). Throw so the
            // caller can display an error instead of hanging the browser.
            if (this.pos === prevPos) {
                throw new ParseError(`unexpected token '${this.peek().value}'`, this.peek().pos);
            }
            list.endsLine = newline || this.isAtEnd();
            if (list.endsLine)
                return lists;
        }
    }
    /**
     * After a list: a separator, or what ends what encloses it (`ends`), comes
     * next, unless it runs in the background, as bash's grammar has it; any
     * other token there is a syntax error (`x=1 (echo)`, `echo a (b)`).
     */
    requireListEnd(list, ends) {
        const token = this.peek();
        const kind = token.kind;
        if (list.background || kind === TokenKind.Semi || kind === TokenKind.Newline || kind === TokenKind.EOF || ends(token))
            return;
        throw new ParseError(`syntax error near unexpected token \`${token.value}'`, token.pos);
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
        this.expandAliases();
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
            const expression = this.readArithmeticCommand();
            if (expression !== null)
                return { type: 'arithmetic', expression, redirections: this.parseTrailingRedirections() };
            return this.parseSubshell();
        }
        return this.parseSimpleCommand();
    }
    /**
     * `((expression))` at the next token, as the reader reads it
     * (TokenReader.readArithmeticCommand, which also says whether the two `(`
     * are one `((`, an alias's text and the text after it joined); null where
     * it is no such command.
     */
    readArithmeticCommand() {
        if (this.peek().kind !== TokenKind.LParen || this.peekAt(1).kind !== TokenKind.LParen)
            return null;
        this.rereadFromHere();
        const token = this.reader.readArithmeticCommand();
        if (token === null)
            return null;
        this.tokens.push(token);
        this.marks.push(undefined);
        this.pos++;
        return token.value;
    }
    parseDoubleBracketCommand() {
        this.advance();
        const words = [];
        // Where the expression is: at a term's start, after its first operand
        // (where a binary operator may come), or where an operand must come
        // (after a unary or a binary operator); and how many of its groups are open.
        let at = 'term';
        let groups = 0;
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
            const word = token.kind === TokenKind.Word ? unquotedLiteral(token) : null;
            if (at === 'operand')
                at = 'done';
            else if (at === 'first' && word === '=~') {
                // The binary operator =~: its operand is a regular expression.
                words.push(this.parseRegexWord(groups > 0));
                at = 'done';
            }
            else if (at === 'first' && word !== null && Object.hasOwn(BINARY_OPERATORS, word))
                at = 'operand';
            else if (token.kind === TokenKind.And || token.kind === TokenKind.Or)
                at = 'term';
            else if (token.kind === TokenKind.RParen) {
                groups = Math.max(0, groups - 1);
                at = 'done';
            }
            else if (at === 'term') {
                if (token.kind === TokenKind.LParen)
                    groups++;
                else if (word !== '!')
                    at = word !== null && Object.hasOwn(UNARY_OPERATORS, word) ? 'operand' : 'first';
            }
            else
                at = 'done';
        }
        throw new ParseError('missing ]]', this.peek().pos);
    }
    /**
     * The regular expression after `=~`, read from its source as bash's reader
     * reads one (TokenReader.readRegexWord). A `)` after it closes one of the
     * expression's groups (`inGroup`); outside a group it is a syntax error.
     */
    parseRegexWord(inGroup) {
        this.rereadFromHere();
        const regex = this.reader.readRegexWord();
        // Nothing there, or the conditional's own `]]`: no operand.
        if (regex === null || unquotedLiteral(regex.token) === ']]')
            throw new ParseError('unexpected argument to conditional binary operator', this.peek().pos);
        if (regex.unclosed)
            throw new ParseError("unexpected EOF while looking for matching `)'", regex.token.pos);
        this.tokens.push(regex.token);
        this.marks.push(undefined);
        this.pos++;
        if (this.peek().kind === TokenKind.RParen && !inGroup) {
            throw new ParseError("syntax error in conditional expression: unexpected token `)'", this.peek().pos);
        }
        return regex.token.parts ?? [];
    }
    doubleBracketTokenParts(token) {
        if (token.kind === TokenKind.Word) {
            return token.parts ?? [{ text: token.value, quoted: 'none' }];
        }
        return [{ text: token.value, quoted: 'none' }];
    }
    parseCompoundList(terminators) {
        const lists = [];
        const ends = (token) => {
            const word = unquotedLiteral(token);
            return (word !== null && terminators.includes(word)) || (token.kind === TokenKind.RParen && terminators.includes(')'));
        };
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
            const list = this.parseList();
            lists.push(list);
            this.requireListEnd(list, ends);
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
        const header = this.readArithmeticCommand();
        if (header !== null)
            return this.parseArithmeticFor(header);
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
    /** `for ((init; test; step))` and its body, `do … done` or `{ … }`, as bash's parser reads them. */
    parseArithmeticFor(header) {
        const parts = arithmeticForParts(header);
        if (parts === null)
            throw new ParseError('syntax error: arithmetic expression required', this.peek().pos);
        const [init, test, step] = parts;
        this.skipSeparators();
        let body;
        if (this.isWord('{')) {
            this.advance();
            body = this.parseCompoundList(['}']);
            this.expectWord('}');
        }
        else {
            this.expectWord('do');
            body = this.parseCompoundList(['done']);
            this.expectWord('done');
        }
        return { type: 'arithmetic_for', init, test, step, body, redirections: this.parseTrailingRedirections() };
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
                const list = this.parseList();
                body.push(list);
                this.requireListEnd(list, endsCaseItem);
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
                // Check for VAR=value assignment (only before any regular words)
                if (words.length === 0) {
                    const assignment = parseAssignment(token);
                    if (assignment !== null) {
                        this.advance();
                        assignments.push(assignment);
                        continue;
                    }
                }
                // The command word, after assignments or redirections, and a word after an alias whose text ended in a blank, may be an alias.
                if ((words.length === 0 || token.aliasCheck === true) && this.expandAliases())
                    continue;
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
    /** The bodies of the here-documents the line opened, read at its newline (none before it): whether it read one. */
    consumeHeredocBodies() {
        if (this.pendingHeredocs.length === 0 || this.peek().kind !== TokenKind.Newline)
            return false;
        let newline = false;
        while (this.peek().kind === TokenKind.Newline) {
            this.advance();
            newline = true;
        }
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
        return newline;
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
export function parseAssignment(token) {
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
    const rest = operatorAfter(parts, name.length);
    return rest === null ? null : { ...rest, name };
}
/**
 * The `[subscript]` (if any), `+` (if any) and `=` that start at `start`
 * characters into an assignment word, as bash's assignment() reads them: each
 * bracket, `+` and `=` unquoted, a subscript's own characters quoted or not;
 * with the length of the word through the `=`. Null where they are not there.
 */
function operatorAfter(parts, start) {
    // The characters after `start`, each with whether it is quoted.
    let part = 0;
    let at = start;
    let length = start;
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
    return { length, ...(subscript === undefined ? {} : { subscript }), append };
}
/**
 * `(element …)` — each a word lexed like any argument's. One that begins
 * `[subscript]=` or `[subscript]+=`, its `[` unquoted, is written at that
 * subscript (bash's compound assignment); `"[0]=x"` and `\[0]=x` are words.
 */
function parseArrayLiteral(text) {
    if (!text.startsWith('(') || !text.endsWith(')'))
        return null;
    const elements = [];
    for (const token of lexArrayElements(text.slice(1, -1))) {
        if (token.kind !== TokenKind.Word)
            continue;
        const parts = token.parts ?? [{ text: token.value, quoted: 'none' }];
        const [first] = parts;
        const head = first !== undefined && first.quoted === 'none' && first.commandSubstitution === undefined && first.text.startsWith('[')
            ? operatorAfter(parts, 0)
            : null;
        if (head === null || head.subscript === undefined) {
            elements.push({ word: parts });
            continue;
        }
        elements.push({ word: partsAfter(token, head.length), subscript: head.subscript, ...(head.append ? { append: true } : {}) });
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
