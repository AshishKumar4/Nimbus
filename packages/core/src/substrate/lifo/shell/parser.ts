import { lex } from './lexer.js';
import {
  TokenKind,
  type Token,
  type AssignmentNode,
  type ScriptNode,
  type ListNode,
  type PipelineNode,
  type SimpleCommandNode,
  type RedirectionNode,
  type WordPart,
  type CompoundCommandNode,
  type IfNode,
  type ForNode,
  type WhileNode,
  type UntilNode,
  type CaseNode,
  type DoubleBracketNode,
  type FunctionDefNode,
  type GroupNode,
  type SubshellNode,
} from './types.js';

export class ParseError extends Error {
  constructor(message: string, public pos: number) {
    super(message);
    this.name = 'ParseError';
  }
}

export function parse(tokens: Token[]): ScriptNode {
  const parser = new Parser(tokens);
  return parser.parseScript();
}

function isUnquotedLiteralWord(token: Token, value: string): boolean {
  if (token.kind !== TokenKind.Word || token.value !== value) return false;
  const parts = token.parts ?? [{ text: token.value, quoted: 'none' as const }];
  return parts.length === 1
    && parts[0]?.text === value
    && parts[0]?.quoted === 'none'
    && parts[0]?.commandSubstitution === undefined;
}

const KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi',
  'for', 'in', 'do', 'done',
  'while', 'until',
  'case', 'esac',
]);

class Parser {
  private tokens: Token[];
  private pos = 0;
  private pendingHeredocs: RedirectionNode[] = [];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: TokenKind.EOF, value: '', pos: -1 };
  }

  private peekAt(offset: number): Token {
    return this.tokens[this.pos + offset] ?? { kind: TokenKind.EOF, value: '', pos: -1 };
  }

  private advance(): Token {
    const token = this.peek();
    if (token.kind !== TokenKind.EOF) {
      this.pos++;
    }
    return token;
  }

  private expect(kind: TokenKind): Token {
    const token = this.peek();
    if (token.kind !== kind) {
      throw new ParseError(
        `Expected ${TokenKind[kind]} but got ${TokenKind[token.kind]} ('${token.value}')`,
        token.pos,
      );
    }
    return this.advance();
  }

  private expectWord(value: string): Token {
    const token = this.peek();
    if (token.kind !== TokenKind.Word || token.value !== value) {
      throw new ParseError(
        `Expected '${value}' but got '${token.value}'`,
        token.pos,
      );
    }
    return this.advance();
  }

  private isAtEnd(): boolean {
    return this.peek().kind === TokenKind.EOF;
  }

  private isWord(value: string): boolean {
    return this.peek().kind === TokenKind.Word && this.peek().value === value;
  }

  private skipNewlines(): void {
    while (this.peek().kind === TokenKind.Newline) {
      this.advance();
    }
  }

  parseScript(): ScriptNode {
    const lists: ListNode[] = [];

    // Skip leading separators
    this.skipSeparators();

    while (!this.isAtEnd()) {
      const prevPos = this.pos;
      lists.push(this.parseList());
      this.consumeHeredocBodies();
      this.skipSeparators();
      // Guard against infinite loop: if no progress was made, the current token
      // is unexpected (e.g. a stray '(' from pasted JS code). Throw so the
      // caller can display an error instead of hanging the browser.
      if (this.pos === prevPos) {
        throw new ParseError(
          `unexpected token '${this.peek().value}'`,
          this.peek().pos,
        );
      }
    }

    return { type: 'script', lists };
  }

  private skipSeparators(): void {
    while (this.peek().kind === TokenKind.Semi || this.peek().kind === TokenKind.Newline) {
      this.advance();
    }
  }

  private parseList(): ListNode {
    const entries: ListNode['entries'] = [];
    let background = false;

    // First pipeline
    const firstPipeline = this.parsePipeline();
    entries.push({ pipeline: firstPipeline, connector: null });

    // Chained pipelines with && or ||
    while (this.peek().kind === TokenKind.And || this.peek().kind === TokenKind.Or) {
      const connectorToken = this.advance();
      const connector = connectorToken.value as '&&' | '||';
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

  private parsePipeline(): PipelineNode {
    let negated = false;

    // Check for ! prefix
    if (this.peek().kind === TokenKind.Word && this.peek().value === '!') {
      negated = true;
      this.advance();
    }

    const commands: CompoundCommandNode[] = [];
    commands.push(this.parseCommand());

    while (this.peek().kind === TokenKind.Pipe) {
      this.advance();
      this.skipNewlines();
      commands.push(this.parseCommand());
    }

    return { type: 'pipeline', commands, negated };
  }

  private parseCommand(): CompoundCommandNode {
    const token = this.peek();

    // Check for compound command keywords
    if (token.kind === TokenKind.Word) {
      if (isUnquotedLiteralWord(token, '[[')) {
        return this.parseDoubleBracketCommand();
      }

      switch (token.value) {
        case 'if': return this.parseIf();
        case 'for': return this.parseFor();
        case 'while': return this.parseWhile();
        case 'until': return this.parseUntil();
        case 'case': return this.parseCase();
      }

      // Check for function definition: name () { ... }
      if (this.peekAt(1).kind === TokenKind.LParen && this.peekAt(2).kind === TokenKind.RParen) {
        const name = token.value;
        // Don't treat keywords as function names
        if (!KEYWORDS.has(name)) {
          return this.parseFunctionDef();
        }
      }
    }

    // { ... } group
    if (token.kind === TokenKind.Word && token.value === '{') {
      return this.parseGroup();
    }

    if (token.kind === TokenKind.LParen) {
      return this.parseSubshell();
    }

    return this.parseSimpleCommand();
  }

  private parseDoubleBracketCommand(): DoubleBracketNode {
    this.advance();
    const words: WordPart[][] = [];

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

  private doubleBracketTokenParts(token: Token): WordPart[] {
    if (token.kind === TokenKind.Word) {
      return token.parts ?? [{ text: token.value, quoted: 'none' as const }];
    }
    return [{ text: token.value, quoted: 'none' }];
  }

  private parseCompoundList(terminators: string[]): ListNode[] {
    const lists: ListNode[] = [];

    this.skipSeparators();

    while (!this.isAtEnd()) {
      const prevPos = this.pos;
      // Check terminators
      const t = this.peek();
      if (t.kind === TokenKind.Word && terminators.includes(t.value)) {
        break;
      }
      if (t.kind === TokenKind.RParen && terminators.includes(')')) {
        break;
      }
      if (t.kind === TokenKind.EOF) break;

      lists.push(this.parseList());
      this.consumeHeredocBodies();
      this.skipSeparators();
      if (this.pos === prevPos) {
        throw new ParseError(
          `unexpected token '${this.peek().value}'`,
          this.peek().pos,
        );
      }
    }

    return lists;
  }

  private parseIf(): IfNode {
    this.expectWord('if');
    const clauses: IfNode['clauses'] = [];
    let elseBody: ListNode[] | null = null;

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

  private parseFor(): ForNode {
    this.expectWord('for');
    const varToken = this.expect(TokenKind.Word);
    const variable = varToken.value;

    this.skipNewlines();

    let words: WordPart[][] | null = null;

    // Optional 'in word...'
    if (this.isWord('in')) {
      this.advance();
      words = [];
      while (!this.isAtEnd()) {
        const t = this.peek();
        if (t.kind === TokenKind.Semi || t.kind === TokenKind.Newline) break;
        if (t.kind === TokenKind.Word && t.value === 'do') break;
        if (t.kind !== TokenKind.Word) break;
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

    return { type: 'for', variable, words, body, redirections };
  }

  private parseWhile(): WhileNode {
    this.expectWord('while');
    const condition = this.parseCompoundList(['do']);
    this.expectWord('do');
    const body = this.parseCompoundList(['done']);
    this.expectWord('done');

    const redirections = this.parseTrailingRedirections();

    return { type: 'while', condition, body, redirections };
  }

  private parseUntil(): UntilNode {
    this.expectWord('until');
    const condition = this.parseCompoundList(['do']);
    this.expectWord('do');
    const body = this.parseCompoundList(['done']);
    this.expectWord('done');

    const redirections = this.parseTrailingRedirections();

    return { type: 'until', condition, body, redirections };
  }

  private parseCase(): CaseNode {
    this.expectWord('case');
    const wordToken = this.expect(TokenKind.Word);
    const word = wordToken.parts ?? [{ text: wordToken.value, quoted: 'none' }];

    this.skipNewlines();
    this.expectWord('in');
    this.skipSeparators();

    const items: CaseNode['items'] = [];

    while (!this.isAtEnd() && !this.isWord('esac')) {
      // Optional leading (
      if (this.peek().kind === TokenKind.LParen) {
        this.advance();
      }

      // Parse patterns separated by |
      const patterns: WordPart[][] = [];
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
      const body: ListNode[] = [];
      this.skipNewlines();

      while (!this.isAtEnd()) {
        const prevPos = this.pos;
        const t = this.peek();
        if (t.kind === TokenKind.DoubleSemi) break;
        if (t.kind === TokenKind.Word && t.value === 'esac') break;
        if (t.kind === TokenKind.EOF) break;
        body.push(this.parseList());
        this.skipSeparators();
        if (this.pos === prevPos) {
          throw new ParseError(
            `unexpected token '${this.peek().value}'`,
            this.peek().pos,
          );
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

  private parseFunctionDef(): FunctionDefNode {
    const nameToken = this.advance(); // consume name
    const name = nameToken.value;
    this.expect(TokenKind.LParen);
    this.expect(TokenKind.RParen);
    this.skipNewlines();

    const body = this.parseCommand();

    return { type: 'function_def', name, body };
  }

  private parseGroup(): GroupNode {
    this.expectWord('{');
    const body = this.parseCompoundList(['}']);
    this.expectWord('}');

    const redirections = this.parseTrailingRedirections();

    return { type: 'group', body, redirections };
  }

  private parseSubshell(): SubshellNode {
    this.expect(TokenKind.LParen);
    const body = this.parseCompoundList([')']);
    this.expect(TokenKind.RParen);

    const redirections = this.parseTrailingRedirections();

    return { type: 'subshell', body, redirections };
  }

  private parseTrailingRedirections(): RedirectionNode[] {
    const redirections: RedirectionNode[] = [];
    while (this.isRedirectOperator(this.peek().kind)) {
      redirections.push(this.parseRedirection());
    }
    return redirections;
  }

  private parseSimpleCommand(): SimpleCommandNode {
    const assignments: SimpleCommandNode['assignments'] = [];
    const words: WordPart[][] = [];
    const redirections: RedirectionNode[] = [];

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

  private parseRedirection(): RedirectionNode {
    const operatorToken = this.advance();
    if (operatorToken.kind === TokenKind.Heredoc || operatorToken.kind === TokenKind.HeredocStripTabs) {
      return this.parseHeredocRedirection(
        operatorToken,
        operatorToken.kind === TokenKind.HeredocStripTabs,
      );
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
          throw new ParseError(
            `Unexpected file descriptor duplication after '${operatorToken.value}'`,
            operatorToken.pos,
          );
      }
    }

    const targetToken = this.expect(TokenKind.Word);
    return {
      operator,
      fd,
      target: targetToken.parts ?? [{ text: targetToken.value, quoted: 'none' }],
    };
  }

  private parseHeredocRedirection(
    operatorToken: Token,
    stripTabs: boolean,
  ): RedirectionNode {
    const targetToken = this.expect(TokenKind.Word);
    const redirection: RedirectionNode = {
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

  private consumeHeredocBodies(): void {
    if (this.pendingHeredocs.length === 0) return;
    while (this.peek().kind === TokenKind.Newline) this.advance();

    while (this.pendingHeredocs.length > 0) {
      const target = this.pendingHeredocs.shift();
      if (!target) break;
      const bodyToken = this.expect(TokenKind.HeredocBody);
      target.heredoc = {
        body: bodyToken.value,
        quoted: bodyToken.heredocQuoted ?? false,
        stripTabs: target.heredoc?.stripTabs ?? false,
      };
    }
  }

  private redirectionOperator(kind: TokenKind): RedirectionNode['operator'] {
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

  private defaultRedirectionFd(kind: TokenKind): number | null {
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

  private isRedirectOperator(kind: TokenKind): boolean {
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
 * The lexer keeps a parenthesised list attached to its assignment, so an array
 * assignment arrives as one word and is recognised here by its shape. Returns
 * null for anything that is an ordinary word rather than an assignment.
 */
function parseAssignment(token: Token): AssignmentNode | null {
  const head = /^([a-zA-Z_][a-zA-Z0-9_]*)(\[[^\]]*\])?(\+)?=/.exec(token.value);
  if (head === null) return null;

  const [matched, name, bracket, plus] = head;
  const value = partsAfter(token, matched.length);
  const assignment: AssignmentNode = { name, value };
  if (bracket !== undefined) assignment.subscript = bracket.slice(1, -1);
  if (plus !== undefined) assignment.append = true;

  const elements = parseArrayLiteral(token.value.slice(matched.length));
  if (elements !== null) {
    assignment.elements = elements;
    assignment.value = [];
  }
  return assignment;
}

/** `(word …)` — the words inside are lexed and expanded like any argument. */
function parseArrayLiteral(text: string): WordPart[][] | null {
  if (!text.startsWith('(') || !text.endsWith(')')) return null;
  const elements: WordPart[][] = [];
  for (const token of lex(text.slice(1, -1))) {
    if (token.kind !== TokenKind.Word) continue;
    elements.push(token.parts ?? [{ text: token.value, quoted: 'none' }]);
  }
  return elements;
}

/** The word parts that fall after `offset` characters of a token's text. */
function partsAfter(token: Token, offset: number): WordPart[] {
  if (!token.parts) return [{ text: token.value.slice(offset), quoted: 'none' }];

  const parts: WordPart[] = [];
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
  if (parts.length === 0) parts.push({ text: '', quoted: 'none' });
  return parts;
}
