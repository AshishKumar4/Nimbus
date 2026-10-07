/**
 * repl-line.ts — what a line typed at a JavaScript REPL runs as.
 *
 * Node's REPL runs each line as a script in one realm, so a line's top-level
 * declarations are there for the next, and it runs a line with top-level
 * `await` through lib/internal/repl/await.js: the line becomes the body of an
 * async function, its declarations hoisted out of it, its last expression
 * statement returned as `{ value }`. A Worker compiles code only from its
 * launch's module map, so a line is compiled the way any code a program
 * produces is (core/_shared/commonjs-cell.ts, RUNTIME CODE): as an async
 * function's body. There is no script scope for that function to share with
 * the next line, so every line gets await.js's treatment, its declarations
 * kept on the global object instead, as a script's var and function
 * declarations are:
 *   - every name a `var` binds outside a function (in a block, a loop head,
 *     a pattern) and every top-level function is a global before the line
 *     runs, keeping a value it has; a top-level function is assigned there
 *     too, as a script's are, as a function expression under its name, so
 *     the line has no binding of its own to shadow the global;
 *   - a declaration's initializers assign those globals where it stands,
 *     and `let`, `const` and `class` at the top level assign a global of
 *     their name the same way (a `const` stays assignable);
 *   - `import()` resolves as from the REPL's own module (REPL_IMPORT,
 *     runtime/js-repl.ts), whichever way the line is compiled;
 *   - the line's last statement, when it is an expression, is its value.
 *
 * Runs in the interpreter's bundle, so it calls only the built-ins the launch
 * captured at its start (intrinsics.ts), as the rest of the interpreter does.
 */
import {
  parse, type FunctionDeclaration, type ModuleDeclaration, type Options, type Pattern, type Program, type Statement,
  type VariableDeclaration,
} from 'acorn';
import {
  SafeSet, SyntaxError, append, arrayIsArray, charCodeAt, isWhitespaceCode, newSafeList, objectKeys, reflectGet, stringOf,
  stringSlice, type SafeList,
} from './intrinsics.js';
import { own } from './parser-realm.js';
import { isObject } from './runtime.js';
import { REPL_IMPORT } from '../runtime/js-repl-names.js';

const LINE_OPTIONS: Options = own({ ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true });

/** A replacement of `[start, end)` by `text`; edits never overlap. */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** What a line declares and how its text changes. */
interface Line {
  readonly source: string;
  readonly edits: SafeList<Edit>;
  /** Names that are globals before the line runs (var-bound and top-level functions), in order, once each. */
  readonly globals: SafeList<string>;
  readonly declared: SafeSet<string>;
  /** Top-level function declarations, assigned to their globals before the line runs. */
  readonly functions: SafeList<FunctionDeclaration>;
}

/**
 * The body of the async function a REPL line runs as, called with the global
 * object as `this`; it returns `{ value }` when the line ends in an
 * expression statement. Null when the line is incomplete (more lines may
 * finish it, as Node's REPL reads them). Throws the SyntaxError of a line no
 * more input can complete.
 */
export function replLineBody(text: string): string | null {
  // A line ends with its line break: where the parser's next token is the
  // end of the input is past it (recoverable).
  const code = endsWithLineBreak(text) ? text : `${text}\n`;
  // An object literal reads as one, not as a block (repl.js defaultEval).
  let source = code;
  if (startsWithBrace(code) && !endsWithSemicolon(code)) {
    const wrapped = `(${code})`;
    if (parsesOrNull(wrapped) !== null) source = wrapped;
  }
  let program: Program;
  try {
    program = parse(source, LINE_OPTIONS);
  } catch (error) {
    if (recoverable(error, code) || (startsWithBrace(code) && recoverable(errorOf(`(${code}`), `(${code}`))) return null;
    throw new SyntaxError(withoutPosition(messageOf(error)));
  }
  const line: Line = { source, edits: newSafeList(), globals: newSafeList(), declared: new SafeSet(), functions: newSafeList() };
  const body = program.body;
  for (let i = 0; i < body.length; i++) statement(body[i], true, line);
  routeImports(program, line.edits);
  const last = lastStatement(body);
  if (last !== null && last.type === 'ExpressionStatement') {
    // `return ` before the statement, `{ value: (` before its expression: a
    // parenthesized statement keeps its parentheses around both.
    append(line.edits, { start: last.start, end: last.start, text: 'return ' });
    append(line.edits, { start: last.expression.start, end: last.expression.start, text: '{ value: (' });
    append(line.edits, { start: last.expression.end, end: last.expression.end, text: ') }' });
  }
  // Each top-level function leaves its place for the prologue, with the
  // edits inside it (its import() calls).
  let assigned = '';
  for (let i = 0; i < line.functions.length; i++) {
    const node = line.functions[i];
    const inner = newSafeList<Edit>();
    const rest = newSafeList<Edit>();
    for (let j = 0; j < line.edits.length; j++) {
      const edit = line.edits[j];
      append(edit.start >= node.start && edit.end <= node.end ? inner : rest, edit);
    }
    // Under its name and without it: the anonymous function takes the name
    // it is assigned to, and its body sees the global, not a binding of its own.
    append(inner, { start: node.id.start, end: node.id.end, text: '' });
    assigned += `${node.id.name} = ${applyEdits(source, inner, node.start, node.end)}; `;
    append(rest, { start: node.start, end: node.end, text: '' });
    line.edits.length = 0;
    for (let j = 0; j < rest.length; j++) append(line.edits, rest[j]);
  }
  let prologue = '';
  for (let i = 0; i < line.globals.length; i++) {
    const name = line.globals[i];
    prologue += `("${name}" in this) || (this.${name} = void 0); `;
  }
  // After the directives: a "use strict" line stays strict.
  append(line.edits, { start: directivesEnd(body), end: directivesEnd(body), text: prologue + assigned });
  return applyEdits(source, line.edits, 0, source.length);
}

/** A global the line declares, once. */
function declareGlobal(line: Line, name: string): void {
  if (line.declared.has(name)) return;
  line.declared.add(name);
  append(line.globals, name);
}

/** Rewrite the declarations of one statement, outside any function; `top` when it is the line's own. */
function statement(node: Statement | ModuleDeclaration, top: boolean, line: Line): void {
  switch (node.type) {
    case 'VariableDeclaration':
      if (node.kind === 'var' || top) declaration(node, line, null);
      return;
    case 'FunctionDeclaration': {
      declareGlobal(line, node.id.name);
      if (top) {
        append(line.functions, node);
      } else {
        // A function in a block is assigned when the block runs (Annex B).
        append(line.edits, { start: node.start, end: node.start, text: `${node.id.name} = ` });
        append(line.edits, { start: node.id.start, end: node.id.end, text: '' });
        append(line.edits, { start: node.end, end: node.end, text: ';' });
      }
      return;
    }
    case 'ClassDeclaration':
      if (top) {
        append(line.edits, { start: node.start, end: node.start, text: `${node.id.name} = ` });
        append(line.edits, { start: node.end, end: node.end, text: ';' });
      }
      return;
    case 'BlockStatement':
      for (let i = 0; i < node.body.length; i++) statement(node.body[i], false, line);
      return;
    case 'IfStatement':
      statement(node.consequent, false, line);
      if (node.alternate) statement(node.alternate, false, line);
      return;
    case 'LabeledStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'WithStatement':
      statement(node.body, false, line);
      return;
    case 'ForStatement':
      if (node.init && node.init.type === 'VariableDeclaration' && node.init.kind === 'var') declaration(node.init, line, 'init');
      statement(node.body, false, line);
      return;
    case 'ForInStatement':
    case 'ForOfStatement':
      if (node.left.type === 'VariableDeclaration' && node.left.kind === 'var') declaration(node.left, line, 'each');
      statement(node.body, false, line);
      return;
    case 'TryStatement':
      statement(node.block, false, line);
      if (node.handler) statement(node.handler.body, false, line);
      if (node.finalizer) statement(node.finalizer, false, line);
      return;
    case 'SwitchStatement':
      for (let i = 0; i < node.cases.length; i++) {
        const consequent = node.cases[i].consequent;
        for (let j = 0; j < consequent.length; j++) statement(consequent[j], false, line);
      }
      return;
    default:
      return;
  }
}

/**
 * A declaration as assignments to the names it declares: a statement as
 * `void ((a = 1), (b = undefined))`, a `for` initializer as the bare
 * assignments, a `for-in`/`for-of` head as its pattern. A `var`'s names are
 * globals before the line runs, so one without an initializer assigns
 * nothing (`void 0`).
 */
function declaration(node: VariableDeclaration, line: Line, head: 'init' | 'each' | null): void {
  const declarators = node.declarations;
  const first = declarators[0];
  if (node.kind === 'var') {
    for (let i = 0; i < declarators.length; i++) declarePattern(line, declarators[i].id);
  }
  if (head !== null) {
    append(line.edits, { start: node.start, end: first.start, text: '' });
    return;
  }
  append(line.edits, { start: node.start, end: first.start, text: 'void (' });
  for (let i = 0; i < declarators.length; i++) {
    const declarator = declarators[i];
    if (i > 0) append(line.edits, { start: declarators[i - 1].end, end: declarator.start, text: ', ' });
    if (declarator.init === null || declarator.init === undefined) {
      if (node.kind === 'var') {
        append(line.edits, { start: declarator.start, end: declarator.end, text: 'void 0' });
        continue;
      }
      append(line.edits, { start: declarator.start, end: declarator.start, text: '(' });
      append(line.edits, { start: declarator.end, end: declarator.end, text: ' = undefined)' });
      continue;
    }
    append(line.edits, { start: declarator.start, end: declarator.start, text: '(' });
    append(line.edits, { start: declarator.end, end: declarator.end, text: ')' });
  }
  append(line.edits, { start: declarators[declarators.length - 1].end, end: declarators[declarators.length - 1].end, text: ')' });
}

/** Each name `pattern` binds, declared a global. */
function declarePattern(line: Line, pattern: Pattern | null): void {
  if (pattern === null) return;
  switch (pattern.type) {
    case 'Identifier':
      declareGlobal(line, pattern.name);
      return;
    case 'ObjectPattern':
      for (let i = 0; i < pattern.properties.length; i++) {
        const property = pattern.properties[i];
        declarePattern(line, property.type === 'RestElement' ? property.argument : property.value);
      }
      return;
    case 'ArrayPattern':
      for (let i = 0; i < pattern.elements.length; i++) declarePattern(line, pattern.elements[i]);
      return;
    case 'RestElement':
      declarePattern(line, pattern.argument);
      return;
    case 'AssignmentPattern':
      declarePattern(line, pattern.left);
      return;
    default:
      return;
  }
}

/** Every `import(...)` in `node`, nested functions included, calls REPL_IMPORT instead. */
function routeImports(node: unknown, edits: SafeList<Edit>): void {
  if (!isObject(node)) return;
  if (arrayIsArray(node)) {
    for (let i = 0; i < node.length; i++) routeImports(node[i], edits);
    return;
  }
  if (reflectGet(node, 'type') === 'ImportExpression') {
    const start = reflectGet(node, 'start');
    const source = reflectGet(node, 'source');
    const sourceStart = isObject(source) ? reflectGet(source, 'start') : undefined;
    if (typeof start === 'number' && typeof sourceStart === 'number') append(edits, { start, end: sourceStart, text: `${REPL_IMPORT}(` });
  }
  const keys = objectKeys(node);
  for (let i = 0; i < keys.length; i++) {
    const value = reflectGet(node, keys[i]);
    if (isObject(value)) routeImports(value, edits);
  }
}

function lastStatement(body: readonly (Statement | ModuleDeclaration)[]): Statement | ModuleDeclaration | null {
  for (let i = body.length - 1; i >= 0; i--) if (body[i].type !== 'EmptyStatement') return body[i];
  return null;
}

/** Where the line's directive prologue ("use strict") ends: the body after it is the line's own. */
function directivesEnd(body: readonly (Statement | ModuleDeclaration)[]): number {
  let end = 0;
  for (let i = 0; i < body.length; i++) {
    const node = body[i];
    if (node.type !== 'ExpressionStatement' || typeof reflectGet(node, 'directive') !== 'string') break;
    end = node.end;
  }
  return end;
}

/** `source[from, to)` with `edits` (all within it) applied, in source order. */
function applyEdits(source: string, edits: SafeList<Edit>, from: number, to: number): string {
  sortEdits(edits);
  let out = '';
  let at = from;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    out += stringSlice(source, at, edit.start) + edit.text;
    at = edit.end;
  }
  return out + stringSlice(source, at, to);
}

/** Order edits by position, an insertion before a replacement starting where it does, stably. */
function sortEdits(edits: SafeList<Edit>): void {
  for (let i = 1; i < edits.length; i++) {
    const edit = edits[i];
    let j = i - 1;
    while (j >= 0 && (edits[j].start > edit.start || (edits[j].start === edit.start && edits[j].end > edit.end))) {
      edits[j + 1] = edits[j];
      j--;
    }
    edits[j + 1] = edit;
  }
}

function startsWithBrace(code: string): boolean {
  let i = 0;
  while (i < code.length && isWhitespaceCode(charCodeAt(code, i))) i++;
  return i < code.length && charCodeAt(code, i) === 0x7b;
}

function endsWithSemicolon(code: string): boolean {
  let i = code.length - 1;
  while (i >= 0 && isWhitespaceCode(charCodeAt(code, i))) i--;
  return i >= 0 && charCodeAt(code, i) === 0x3b;
}

/** `text` parsed as a line, or null where it does not parse. */
function parsesOrNull(text: string): Program | null {
  try {
    return parse(text, LINE_OPTIONS);
  } catch {
    return null;
  }
}

/** What parsing `text` as a line threw, or null when it parsed. */
function errorOf(text: string): unknown {
  try {
    parse(text, LINE_OPTIONS);
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * Whether more input could complete `code`, which failed to parse with
 * `error` (Node's repl isRecoverableError): the parser had reached the end of
 * the input when it raised the error (acorn's raisedAt is where it was, past
 * the line's final line break only once its next token was the end), or a
 * template, a comment or a string continued by a trailing backslash is still
 * open there.
 */
function recoverable(error: unknown, code: string): boolean {
  if (error === null || !isObject(error)) return false;
  const message = messageOf(error);
  if (startsWithText(message, 'Unterminated template') || startsWithText(message, 'Unterminated comment')) return true;
  if (startsWithText(message, 'Unterminated string constant')) return endsWithContinuation(code);
  const raisedAt = reflectGet(error, 'raisedAt');
  return typeof raisedAt === 'number' && raisedAt >= code.length;
}

function endsWithLineBreak(code: string): boolean {
  return code.length > 0 && charCodeAt(code, code.length - 1) === 0x0a;
}

/** Whether `code` ends with a backslash and a line break: a string continued on the next line. */
function endsWithContinuation(code: string): boolean {
  let end = code.length;
  if (end > 0 && charCodeAt(code, end - 1) === 0x0a) end--;
  if (end > 0 && charCodeAt(code, end - 1) === 0x0d) end--;
  return end > 0 && charCodeAt(code, end - 1) === 0x5c;
}

function startsWithText(text: string, prefix: string): boolean {
  return stringSlice(text, 0, prefix.length) === prefix;
}

function messageOf(error: unknown): string {
  const message = isObject(error) ? reflectGet(error, 'message') : undefined;
  return typeof message === 'string' ? message : stringOf(error);
}

/** acorn's message without the ` (line:column)` it ends with. */
function withoutPosition(message: string): string {
  const end = message.length;
  if (end === 0 || charCodeAt(message, end - 1) !== 0x29) return message;
  let i = end - 2;
  while (i >= 0 && charCodeAt(message, i) !== 0x28) i--;
  return i > 0 && charCodeAt(message, i - 1) === 0x20 ? stringSlice(message, 0, i - 1) : message;
}
