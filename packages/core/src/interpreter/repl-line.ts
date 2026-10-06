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
 * kept on the global object instead:
 *   - `var`, anywhere outside a function, and `let`, `const` and `class` at
 *     the top level assign a global of their name (`let x = 1` runs
 *     `x = 1`; a `var` without an initializer keeps the value it has);
 *   - a function declaration is assigned to its global name too, a top-level
 *     one before the line runs, as a script's are;
 *   - the line's last statement, when it is an expression, is its value.
 * Unlike a script's lexical declarations, a `const` stays assignable and a
 * declared name is a property of the global object.
 *
 * Runs in the interpreter's bundle, so it calls only the built-ins the launch
 * captured at its start (intrinsics.ts), as the rest of the interpreter does.
 */
import { parse, type ModuleDeclaration, type Options, type Program, type Statement, type VariableDeclaration } from 'acorn';
import {
  SyntaxError, append, charCodeAt, isWhitespaceCode, newSafeList, reflectGet, stringOf, stringSlice, type SafeList,
} from './intrinsics.js';
import { own } from './parser-realm.js';
import { isObject } from './runtime.js';

const LINE_OPTIONS: Options = own({ ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true });

/** A replacement of `[start, end)` by `text`; edits are made in source order and never overlap. */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * The body of the async function a REPL line runs as, called with the global
 * object as `this`; it returns `{ value }` when the line ends in an
 * expression statement. Null when the line is incomplete (more lines may
 * finish it, as Node's REPL reads them: an open bracket, a string continued
 * by a trailing backslash, an unterminated template or comment). Throws the
 * SyntaxError of a line no more input can complete.
 */
export function replLineBody(code: string): string | null {
  // An object literal reads as one, not as a block (repl.js defaultEval).
  let source = code;
  if (startsWithBrace(code) && !endsWithSemicolon(code)) {
    const wrapped = `(${code})`;
    try {
      parse(wrapped, LINE_OPTIONS);
      source = wrapped;
    } catch {
      // A block after all.
    }
  }
  let program: Program;
  try {
    program = parse(source, LINE_OPTIONS);
  } catch (error) {
    if (recoverable(error, code) || (startsWithBrace(code) && recoverable(errorOf(() => parse(`(${code}`, LINE_OPTIONS)), `(${code}`))) {
      return null;
    }
    throw new SyntaxError(withoutPosition(messageOf(error)));
  }
  const edits = newSafeList<Edit>();
  const prologue = newSafeList<string>();
  const body = program.body;
  for (let i = 0; i < body.length; i++) statement(body[i], true, edits, prologue);
  const last = lastStatement(body);
  if (last !== null && last.type === 'ExpressionStatement') {
    // `return ` before the statement, `{ value: (` before its expression: a
    // parenthesized statement keeps its parentheses around both.
    append(edits, { start: last.start, end: last.start, text: 'return ' });
    append(edits, { start: last.expression.start, end: last.expression.start, text: '{ value: (' });
    append(edits, { start: last.expression.end, end: last.expression.end, text: ') }' });
  }
  let head = '';
  for (let i = 0; i < prologue.length; i++) head += prologue[i];
  return head + applyEdits(source, edits);
}

/** Rewrite the declarations of one statement, outside any function; `top` when it is the line's own. */
function statement(node: Statement | ModuleDeclaration, top: boolean, edits: SafeList<Edit>, prologue: SafeList<string>): void {
  switch (node.type) {
    case 'VariableDeclaration':
      if (node.kind === 'var' || top) declaration(node, edits, null);
      return;
    case 'FunctionDeclaration': {
      const name = node.id.name;
      // A top-level function is global before the line runs; one in a block
      // once the block is entered, where it is hoisted (Annex B).
      if (top) append(prologue, `this.${name} = ${name}; `);
      else append(edits, { start: node.start, end: node.start, text: `this.${name} = ${name}; ` });
      return;
    }
    case 'ClassDeclaration':
      if (top) {
        const name = node.id.name;
        append(edits, { start: node.start, end: node.start, text: `${name} = ` });
        append(edits, { start: node.end, end: node.end, text: ';' });
      }
      return;
    case 'BlockStatement':
      for (let i = 0; i < node.body.length; i++) statement(node.body[i], false, edits, prologue);
      return;
    case 'IfStatement':
      statement(node.consequent, false, edits, prologue);
      if (node.alternate) statement(node.alternate, false, edits, prologue);
      return;
    case 'LabeledStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'WithStatement':
      statement(node.body, false, edits, prologue);
      return;
    case 'ForStatement':
      if (node.init && node.init.type === 'VariableDeclaration' && node.init.kind === 'var') declaration(node.init, edits, 'init');
      statement(node.body, false, edits, prologue);
      return;
    case 'ForInStatement':
    case 'ForOfStatement':
      if (node.left.type === 'VariableDeclaration' && node.left.kind === 'var') declaration(node.left, edits, 'each');
      statement(node.body, false, edits, prologue);
      return;
    case 'TryStatement':
      statement(node.block, false, edits, prologue);
      if (node.handler) statement(node.handler.body, false, edits, prologue);
      if (node.finalizer) statement(node.finalizer, false, edits, prologue);
      return;
    case 'SwitchStatement':
      for (let i = 0; i < node.cases.length; i++) {
        const consequent = node.cases[i].consequent;
        for (let j = 0; j < consequent.length; j++) statement(consequent[j], false, edits, prologue);
      }
      return;
    default:
      return;
  }
}

/**
 * A declaration as assignments to the names it declares: a statement as
 * `void ((a = 1), (b = undefined))`, a `for` initializer as the bare
 * assignments, a `for-in`/`for-of` head as its pattern.
 */
function declaration(node: VariableDeclaration, edits: SafeList<Edit>, head: 'init' | 'each' | null): void {
  const declarators = node.declarations;
  const first = declarators[0];
  if (head === 'each') {
    append(edits, { start: node.start, end: first.start, text: '' });
    return;
  }
  const statementForm = head === null;
  append(edits, { start: node.start, end: first.start, text: statementForm ? 'void (' : '' });
  for (let i = 0; i < declarators.length; i++) {
    const declarator = declarators[i];
    let open = '(';
    let close = ')';
    if (declarator.init === null || declarator.init === undefined) {
      if (declarator.id.type === 'Identifier' && node.kind === 'var') {
        // `var x;` declares x and keeps the value it has. (An identifier
        // needs no escaping inside the quotes.)
        const name = declarator.id.name;
        open = `("${name}" in this || (this.${name} = undefined), `;
        close = ')';
      } else {
        close = ' = undefined)';
      }
    }
    if (i > 0) append(edits, { start: declarators[i - 1].end, end: declarator.start, text: ', ' });
    append(edits, { start: declarator.start, end: declarator.start, text: open });
    append(edits, { start: declarator.end, end: declarator.end, text: close });
  }
  if (statementForm) append(edits, { start: declarators[declarators.length - 1].end, end: declarators[declarators.length - 1].end, text: ')' });
}

function lastStatement(body: readonly (Statement | ModuleDeclaration)[]): Statement | ModuleDeclaration | null {
  for (let i = body.length - 1; i >= 0; i--) if (body[i].type !== 'EmptyStatement') return body[i];
  return null;
}

/** `source` with `edits` (in source order, never overlapping) applied. */
function applyEdits(source: string, edits: SafeList<Edit>): string {
  sortEdits(edits);
  let out = '';
  let at = 0;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    out += stringSlice(source, at, edit.start) + edit.text;
    at = edit.end;
  }
  return out + stringSlice(source, at);
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

/** What `parse` threw, or null when it parsed. */
function errorOf(parseIt: () => unknown): unknown {
  try {
    parseIt();
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * Whether more input could complete `code`, which failed to parse with
 * `error` (Node's repl.js isRecoverableError): the parser reached the end of
 * the input, or a template, a comment or a string continued by a trailing
 * backslash is still open there.
 */
function recoverable(error: unknown, code: string): boolean {
  if (error === null || !isObject(error)) return false;
  const message = messageOf(error);
  if (startsWithText(message, 'Unterminated template') || startsWithText(message, 'Unterminated comment')) return true;
  if (startsWithText(message, 'Unterminated string constant')) return endsWithContinuation(code);
  const position = reflectGet(error, 'pos');
  return typeof position === 'number' && position >= code.length;
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

