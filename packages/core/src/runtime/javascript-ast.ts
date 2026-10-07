import { Parser, parse, tokenizer, tokTypes, type AnyNode, type Options, type Program, type Token, type TokenType } from 'acorn';

export type AstNode = AnyNode & Record<string, unknown>;

/** How an ES module is parsed. */
export const MODULE_PARSE_OPTIONS: Options = { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true };

/** How a program Node would run is parsed (as a module, else as a CommonJS script): what either allows. */
export const PROGRAM_PARSE_OPTIONS = {
  ecmaVersion: 'latest',
  allowHashBang: true,
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowImportExportEverywhere: true,
} as const;

export function parseJavaScriptModule(source: string): AstNode {
  const program = parse(source, MODULE_PARSE_OPTIONS);
  // Program declares no index signature; the guard gives it AstNode's keyed view.
  if (!isAstNode(program)) throw new TypeError(`acorn parsed a ${program.type}, not a node`);
  return program;
}

/**
 * A program as Node would run it: an ES module, or a CommonJS script (whose
 * top level may `return`); null when it is neither.
 */
export function parseJavaScriptProgram(source: string): Program | null {
  try {
    return parse(source, { ...PROGRAM_PARSE_OPTIONS, sourceType: 'module' });
  } catch {
    try {
      return parse(source, { ...PROGRAM_PARSE_OPTIONS, sourceType: 'script' });
    } catch {
      return null;
    }
  }
}

/** What {@link parseStatements} hands over as it parses. */
export interface StatementHooks {
  /** A top-level statement, once parsed; it is not kept. */
  readonly onStatement?: (statement: AstNode) => void;
  /**
   * A node, once finished: its children before it. A function's body is
   * dropped after the function's own call, so what a hook keeps of one is
   * what it took then.
   */
  readonly onNode?: (node: AstNode) => void;
}

/** The parts of acorn's Parser a plugin uses (acorn's plugin API, which its declarations leave out). */
interface AcornParser {
  type: unknown;
  inModule: boolean;
  undefinedExports: Record<string, { start: number }>;
  parse(): Program;
  parseStatement(context: null, topLevel: boolean, exports: object): unknown;
  finishNode<T>(node: T, type: string): T;
  raiseRecoverable(pos: number, message: string): void;
  next(): void;
}
const AcornParserClass = Parser as unknown as new (options: Options, input: string) => AcornParser;

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** acorn, keeping no tree of the whole program (parseStatements). */
class StatementParser extends AcornParserClass {
  hooks: StatementHooks = {};

  parseTopLevel(node: Program): Program {
    const exports = Object.create(null);
    while (this.type !== tokTypes.eof) {
      const statement = this.parseStatement(null, true, exports);
      if (isAstNode(statement)) this.hooks.onStatement?.(statement);
    }
    if (this.inModule) {
      for (const name of Object.keys(this.undefinedExports)) this.raiseRecoverable(this.undefinedExports[name].start, `Export '${name}' is not defined`);
    }
    this.next();
    return this.finishNode(node, 'Program');
  }

  finishNode<T>(node: T, type: string): T {
    const finished = super.finishNode(node, type);
    if (isAstNode(finished)) {
      this.hooks.onNode?.(finished);
      if (FUNCTION_TYPES.has(type)) {
        const body = finished.body;
        if (isAstNode(body) && body.type === 'BlockStatement') Reflect.set(body, 'body', []);
      }
    }
    return finished;
  }
}

/**
 * acorn's parse of `source` with no tree of the whole program held: each
 * top-level statement goes to the hooks as it is parsed and is not kept,
 * and each function's body is dropped once the function is finished (its
 * parameters stay, which acorn checks after). What is held at once is the
 * chain of functions being parsed and their code outside functions, so a
 * multi-MiB bundle parses in bounded memory (acorn's whole tree is 17 to 24
 * times its source). Throws acorn's SyntaxError, as `parse` does.
 */
export function parseStatements(source: string, options: Options, hooks: StatementHooks): void {
  const parser = new StatementParser(options, source);
  parser.hooks = hooks;
  parser.parse();
}

/** Parentheses, `(0, f)`, `await` and `?.` do not change what is called. */
export function unwrapCallee(node: AnyNode): AnyNode {
  let at = node;
  for (;;) {
    if (at.type === 'ParenthesizedExpression' || at.type === 'ChainExpression') at = at.expression;
    else if (at.type === 'SequenceExpression') at = at.expressions[at.expressions.length - 1];
    else if (at.type === 'AwaitExpression') at = at.argument;
    else return at;
  }
}

/** The name of the function a call reaches: `f`, `x.f`, `x['f']`, through {@link unwrapCallee}. */
export function calleeName(callee: AnyNode): string | null {
  const at = unwrapCallee(callee);
  if (at.type === 'Identifier') return at.name;
  if (at.type !== 'MemberExpression') return null;
  if (!at.computed && at.property.type === 'Identifier') return at.property.name;
  return at.property.type === 'Literal' && typeof at.property.value === 'string' ? at.property.value : null;
}

/** The module syntax a token opens: a top-level declaration, or `import.meta` anywhere. */
export type ModuleSyntaxToken = 'import' | 'export' | 'import.meta';

/** The names Node's CommonJS wrapper binds, which a module's top level may not redeclare lexically. */
const COMMONJS_WRAPPER_NAMES = new Set(['exports', 'require', 'module', '__filename', '__dirname']);

/**
 * Whether `source` holds syntax only an ES module can, as Node's syntax
 * detection defines it (doc/api/packages.md "Syntax detection", on by
 * default from v22.7.0): syntax that throws when evaluated as CommonJS. That
 * is an `import` or `export` declaration, `import.meta`, `await` at the top
 * level, or a top-level lexical declaration of a name the CommonJS wrapper
 * binds (`const __dirname = …`). `import()` is valid in both.
 *
 * A declaration or `import.meta` is read off the tokens. The other two are
 * read off them as candidates (an `await` outside every function body, a
 * `let`, `const` or `class` of a wrapper name) and settled as Node settles
 * every case: the source fails to compile in the wrapper and parses as a
 * module. A source that does not tokenize as a module is not one.
 */
export function containsModuleSyntax(source: string): boolean {
  let previous: TokenType = tokTypes.eof;
  let lexical = false;
  let candidate = false;
  let awaits = false;
  const found = walkTopLevelModuleTokens(source, (token, syntax, topLevel) => {
    if (syntax !== null) return true;
    const member = previous === tokTypes.dot || previous === tokTypes.questionDot;
    const name = token.type === tokTypes.name ? source.slice(token.start, token.end) : null;
    if (lexical && name !== null && COMMONJS_WRAPPER_NAMES.has(name)) candidate = true;
    if (!member && name === 'await') awaits = true;
    lexical = topLevel && !member && (token.type === tokTypes._const || token.type === tokTypes._class || name === 'let');
    previous = token.type;
    return false;
  });
  if (found !== false) return found === true;
  if (!candidate && !(awaits && hasUnscopedAwait(source))) return false;
  return !compilesAsCommonJs(source) && parses(source, MODULE_PARSE_OPTIONS);
}

/** Whether `source` compiles as Node compiles a CommonJS module: the body of its wrapper function. */
function compilesAsCommonJs(source: string): boolean {
  const body = source.startsWith('#!') ? '//' + source.slice(2) : source;
  return parses(`(function (exports, require, module, __filename, __dirname) {${body}\n})`, { ecmaVersion: 'latest', sourceType: 'script' });
}

function parses(source: string, options: Options): boolean {
  try {
    parseStatements(source, options, {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `source` may hold an `await` outside every function body (a
 * top-level await), read off its tokens: true when one is found, or when the
 * source does not tokenize, so a false answer is certain.
 */
export function hasUnscopedAwait(source: string): boolean {
  try {
    const tokens = tokenizer(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
    });
    const functionBraces: boolean[] = [];
    const functionParenDepths: number[] = [];
    const methodParenCandidates: boolean[] = [];
    const arrowExpressions: Array<{ parens: number; braces: number; brackets: number }> = [];
    let bracketDepth = 0;
    let pendingMethodBody = false;
    let pendingArrowBody = false;
    let pendingFunctionKeyword = false;
    let previous = tokTypes.eof;
    let previousEnd = 0;

    while (true) {
      const token = tokens.getToken();
      const type = token.type;
      if (type === tokTypes.eof) return false;

      if (pendingMethodBody && type !== tokTypes.braceL) pendingMethodBody = false;
      if (pendingArrowBody && type !== tokTypes.braceL) {
        arrowExpressions.push({
          parens: methodParenCandidates.length,
          braces: functionBraces.length,
          brackets: bracketDepth,
        });
        pendingArrowBody = false;
      }

      if (pendingFunctionKeyword) {
        if (
          type === tokTypes.colon || type === tokTypes.comma || type === tokTypes.braceR
          || type === tokTypes.parenR || type === tokTypes.bracketR || type === tokTypes.eq
        ) functionParenDepths.pop();
        pendingFunctionKeyword = false;
      }

      if (source.slice(previousEnd, token.start).includes('\n')) {
        while (arrowExpressions.length > 0) {
          const arrow = arrowExpressions[arrowExpressions.length - 1];
          if (
            methodParenCandidates.length !== arrow.parens
            || functionBraces.length !== arrow.braces
            || bracketDepth !== arrow.brackets
          ) break;
          arrowExpressions.pop();
        }
      }

      while (arrowExpressions.length > 0) {
        const arrow = arrowExpressions[arrowExpressions.length - 1];
        const delimited = (type === tokTypes.semi || type === tokTypes.comma)
          && methodParenCandidates.length === arrow.parens
          && functionBraces.length === arrow.braces
          && bracketDepth === arrow.brackets;
        const closed = (type === tokTypes.parenR && methodParenCandidates.length === arrow.parens)
          || (type === tokTypes.bracketR && bracketDepth === arrow.brackets)
          || (type === tokTypes.braceR && functionBraces.length === arrow.braces);
        if (!delimited && !closed) break;
        arrowExpressions.pop();
      }

      if (
        type === tokTypes.name
        && source.slice(token.start, token.end) === 'await'
        && !functionBraces.includes(true)
        && arrowExpressions.length === 0
      ) return true;

      if (type === tokTypes._function || type === tokTypes._class) {
        if (previous !== tokTypes.dot && previous !== tokTypes.questionDot) {
          functionParenDepths.push(methodParenCandidates.length);
          pendingFunctionKeyword = true;
        }
      } else if (type === tokTypes.arrow) {
        pendingArrowBody = true;
      } else if (type === tokTypes.parenL) {
        methodParenCandidates.push(
          functionBraces.length > 0
            && (previous === tokTypes.name || previous === tokTypes.string
              || previous === tokTypes.num || previous === tokTypes.bracketR),
        );
      } else if (type === tokTypes.parenR) {
        pendingMethodBody = methodParenCandidates.pop() === true;
      } else if (type === tokTypes.bracketL) {
        bracketDepth++;
      } else if (type === tokTypes.bracketR) {
        bracketDepth = Math.max(0, bracketDepth - 1);
      } else if (type === tokTypes.dollarBraceL) {
        functionBraces.push(false);
      } else if (type === tokTypes.braceL) {
        const functionBody = pendingArrowBody
          || pendingMethodBody
          || functionParenDepths[functionParenDepths.length - 1] === methodParenCandidates.length;
        if (functionParenDepths[functionParenDepths.length - 1] === methodParenCandidates.length) {
          functionParenDepths.pop();
        }
        functionBraces.push(functionBody);
        pendingArrowBody = false;
        pendingMethodBody = false;
      } else if (type === tokTypes.braceR) {
        functionBraces.pop();
      }
      previousEnd = token.end;
      previous = type;
    }
  } catch {
    return true;
  }
}

/**
 * Walk `source`'s tokens tracking brace, paren and bracket depth, without
 * building an AST (a multi-MiB bundle chunk must fit a 48 MiB heap). `visit`
 * sees each token with whether it sits at top level and the module syntax
 * it opens: for a top-level `import` or `export` keyword, the declaration
 * (not `import(`), and for an `import` anywhere, `import.meta`; never for a
 * member named so (after `.` or `?.`). The token after an `import` keyword
 * is read to decide that and not visited. `visit` returns true to stop the
 * walk.
 *
 * Returns true when `visit` stopped it, false at the end of the source, and
 * null when the source does not tokenize.
 */
export function walkTopLevelModuleTokens(
  source: string,
  visit: (token: Token, syntax: ModuleSyntaxToken | null, topLevel: boolean) => boolean,
): boolean | null {
  try {
    const tokens = tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    let braces = 0;
    let parens = 0;
    let brackets = 0;
    let previous: TokenType = tokTypes.eof;
    const updateDepth = (type: TokenType): void => {
      if (type === tokTypes.braceL || type === tokTypes.dollarBraceL) braces++;
      else if (type === tokTypes.braceR) braces = Math.max(0, braces - 1);
      else if (type === tokTypes.parenL) parens++;
      else if (type === tokTypes.parenR) parens = Math.max(0, parens - 1);
      else if (type === tokTypes.bracketL) brackets++;
      else if (type === tokTypes.bracketR) brackets = Math.max(0, brackets - 1);
    };
    for (;;) {
      const token = tokens.getToken();
      const type = token.type;
      if (type === tokTypes.eof) return false;
      const topLevel = braces === 0 && parens === 0 && brackets === 0;
      const keyword = previous !== tokTypes.dot && previous !== tokTypes.questionDot;
      previous = type;
      let syntax: ModuleSyntaxToken | null = null;
      if (keyword && topLevel && type === tokTypes._export) {
        syntax = 'export';
      } else if (keyword && type === tokTypes._import) {
        const next = tokens.getToken();
        previous = next.type;
        updateDepth(next.type);
        if (next.type === tokTypes.dot) syntax = 'import.meta';
        else if (topLevel && next.type !== tokTypes.parenL) syntax = 'import';
      } else {
        updateDepth(type);
      }
      if (visit(token, syntax, topLevel)) return true;
    }
  } catch {
    return null;
  }
}

/** A replacement of source text `[start, end)` by `text`. */
export interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * `source` with `edits` applied, in source order. Edits may come in any
 * order and may insert (start === end), but never overlap: an overlap is a
 * rewrite that lost track of what it replaced, and throws.
 */
export function applySourceEdits(source: string, edits: readonly SourceEdit[]): string {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const parts: string[] = [];
  let at = 0;
  for (const { start, end, text } of ordered) {
    if (start < at) throw new Error(`overlapping source edits at ${start}`);
    parts.push(source.slice(at, start), text);
    at = end;
  }
  parts.push(source.slice(at));
  return parts.join('');
}

export function nodeList(node: AstNode, key: string): AstNode[] {
  const value = node[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isAstNode);
}

export function nodeProp(node: AstNode | undefined, key: string): AstNode | undefined {
  if (!node) return undefined;
  const value = node[key];
  return isAstNode(value) ? value : undefined;
}

export function nodeName(node: AstNode | undefined): string | undefined {
  if (node?.type !== 'Identifier' && node?.type !== 'Literal') return undefined;
  if (node.type === 'Identifier') return stringField(node, 'name');
  return literalStringValue(node);
}

export function stringField(node: AstNode, key: string): string | undefined {
  const value = node[key];
  return typeof value === 'string' ? value : undefined;
}

export function booleanField(node: AstNode, key: string): boolean {
  const value = node[key];
  return typeof value === 'boolean' ? value : false;
}

export function literalStringValue(node: AstNode | undefined): string | undefined {
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined;
}

export function literalBooleanValue(node: AstNode | undefined): boolean | undefined {
  return node?.type === 'Literal' && typeof node.value === 'boolean' ? node.value : undefined;
}

/** Every node type acorn's AnyNode names: `satisfies` holds the list to acorn's types. */
const NODE_TYPES: ReadonlySet<string> = new Set(Object.keys({
  ArrayExpression: true, ArrayPattern: true, ArrowFunctionExpression: true, AssignmentExpression: true,
  AssignmentPattern: true, AwaitExpression: true, BinaryExpression: true, BlockStatement: true, BreakStatement: true,
  CallExpression: true, CatchClause: true, ChainExpression: true, ClassBody: true, ClassDeclaration: true,
  ClassExpression: true, ConditionalExpression: true, ContinueStatement: true, DebuggerStatement: true,
  DoWhileStatement: true, EmptyStatement: true, ExportAllDeclaration: true, ExportDefaultDeclaration: true,
  ExportNamedDeclaration: true, ExportSpecifier: true, ExpressionStatement: true, ForInStatement: true,
  ForOfStatement: true, ForStatement: true, FunctionDeclaration: true, FunctionExpression: true, Identifier: true,
  IfStatement: true, ImportAttribute: true, ImportDeclaration: true, ImportDefaultSpecifier: true,
  ImportExpression: true, ImportNamespaceSpecifier: true, ImportSpecifier: true, LabeledStatement: true,
  Literal: true, LogicalExpression: true, MemberExpression: true, MetaProperty: true, MethodDefinition: true,
  NewExpression: true, ObjectExpression: true, ObjectPattern: true, ParenthesizedExpression: true,
  PrivateIdentifier: true, Program: true, Property: true, PropertyDefinition: true, RestElement: true,
  ReturnStatement: true, SequenceExpression: true, SpreadElement: true, StaticBlock: true, Super: true,
  SwitchCase: true, SwitchStatement: true, TaggedTemplateExpression: true, TemplateElement: true,
  TemplateLiteral: true, ThisExpression: true, ThrowStatement: true, TryStatement: true, UnaryExpression: true,
  UpdateExpression: true, VariableDeclaration: true, VariableDeclarator: true, WhileStatement: true,
  WithStatement: true, YieldExpression: true,
} satisfies Record<AnyNode['type'], true>));

/**
 * A node of a tree acorn parsed: an object whose `type` is one of acorn's
 * node types. Its other fields are acorn's, which this does not re-check.
 */
export function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && 'type' in value
    && typeof value.type === 'string' && NODE_TYPES.has(value.type);
}

const NON_CHILD_KEYS = new Set(['type', 'start', 'end', 'loc', 'range']);

/** Each child node of `node`. */
export function forEachChild(node: AnyNode, visit: (child: AnyNode) => void): void {
  for (const key of Object.keys(node)) {
    if (NON_CHILD_KEYS.has(key)) continue;
    const child: unknown = Reflect.get(node, key);
    if (Array.isArray(child)) {
      const children: readonly unknown[] = child;
      for (const c of children) if (isAstNode(c)) visit(c);
    } else if (isAstNode(child)) {
      visit(child);
    }
  }
}

/** Every node below `node`, functions included, in source order. */
export function forEachNode(node: AnyNode, visit: (n: AnyNode) => void): void {
  visit(node);
  forEachChild(node, (child) => forEachNode(child, visit));
}
