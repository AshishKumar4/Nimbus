/**
 * runtime-function-source.ts — the source text a Function constructor call
 * stands for, and when V8 refuses it. Shared by the module a staged call
 * becomes (commonjs-cell.ts) and the interpreter that runs an unstaged one.
 *
 * The interpreter runs this after a program may have replaced built-ins, so
 * nothing here names one: the caller's SourceRealm supplies what it needs
 * (the interpreter's, from the launch's start; commonjs-cell's, its own).
 */
import { parse, type FunctionExpression, type ModuleDeclaration, type Options, type Program, type Statement } from 'acorn';

/** The constructors whose text a program can hand in at runtime. */
export const RUNTIME_FUNCTION_HEADS = {
  function: 'function',
  async: 'async function',
  generator: 'function*',
  asyncGenerator: 'async function*',
} as const;
export type RuntimeFunctionKind = keyof typeof RUNTIME_FUNCTION_HEADS;

/**
 * The parameters joined with commas, as the constructor joins them. Built
 * with a loop: the interpreter calls this at runtime, after the program may
 * have replaced Array.prototype.join.
 */
function parameterList(params: readonly string[]): string {
  let text = '';
  for (let i = 0; i < params.length; i++) text += i === 0 ? params[i] : `,${params[i]}`;
  return text;
}

/** The built-ins this module's checks use, as the caller has them. */
export interface SourceRealm {
  readonly SyntaxError: new (message: string) => Error;
  /** The message of what the parser threw. */
  messageOf(error: unknown): string;
  /**
   * The parser's options for a script (`ecmaVersion: 'latest'`, `sourceType:
   * 'script'`). acorn reads one option of the object directly, so the
   * interpreter's inherits nothing.
   */
  readonly scriptOptions: Options;
}

/** The function literal V8 builds for `new <Kind>Function(...params, body)`. */
export function runtimeFunctionSource(kind: RuntimeFunctionKind, params: readonly string[], body: string): string {
  return `${RUNTIME_FUNCTION_HEADS[kind]} anonymous(${parameterList(params)}\n) {\n${body}\n}`;
}

/**
 * The function literal `text` holds, checked as V8 checks a constructor's
 * source: exactly one function literal spanning the text, its body starting
 * at `bodyStart` (and empty, for the parameters' own check). Otherwise the
 * message V8 refuses it with.
 */
function functionLiteral(text: string, bodyStart: number, emptyBody: boolean, realm: SourceRealm): FunctionExpression | string {
  let program: Program;
  try {
    program = parse(text, realm.scriptOptions);
  } catch (e) {
    return realm.messageOf(e);
  }
  const statement = program.body[0];
  const fn = program.body.length === 1 && statement.type === 'ExpressionStatement' ? statement.expression : null;
  if (
    !fn || fn.type !== 'FunctionExpression' || fn.start !== 1 || fn.end !== text.length - 1
    || fn.body.start !== bodyStart || (emptyBody && fn.body.body.length !== 0)
  ) {
    return emptyBody ? 'Arg string terminates parameters early' : 'Single function literal required';
  }
  return fn;
}

/**
 * Why V8's constructor would refuse these arguments, or null when it would
 * build the function. V8 parses the parameters alone and requires them to end
 * where the list ends ("Arg string terminates parameters early"), the body
 * alone, and then the whole source, which must be exactly one function
 * literal ("Single function literal required"). Splicing unchecked text into
 * `(<head> anonymous(<params>\n) {\n<body>\n})` would otherwise let a body
 * such as `}, globalThis.x = 1, function () {` run code at module
 * evaluation that the constructor never would.
 */
export function runtimeFunctionSyntaxError(kind: RuntimeFunctionKind, params: readonly string[], body: string, realm: SourceRealm): string | null {
  const head = `(${RUNTIME_FUNCTION_HEADS[kind]} anonymous(`;
  const paramText = parameterList(params);
  const checks: Array<[text: string, bodyStart: number, emptyBody: boolean]> = [
    [`${head}${paramText}\n) {})`, `${head}${paramText}\n) `.length, true],
    [`${head}\n) {\n${body}\n})`, `${head}\n) `.length, false],
    [`${head}${paramText}\n) {\n${body}\n})`, `${head}${paramText}\n) `.length, false],
  ];
  for (let i = 0; i < checks.length; i++) {
    const checked = functionLiteral(checks[i][0], checks[i][1], checks[i][2], realm);
    if (typeof checked === 'string') return checked;
  }
  return null;
}

/**
 * The function literal a constructor call builds, parsed with the checks of
 * runtimeFunctionSyntaxError but the body parsed once: the parameters alone,
 * then the whole literal. V8's body-alone parse refuses nothing those two
 * accept, since with the parameters complete on their own the literal's
 * body is parsed as the body alone would be, in the parameters' context.
 * Throws the SyntaxError V8 would. `text` is what `node`'s offsets index.
 */
export function parseRuntimeFunction(
  kind: RuntimeFunctionKind, params: readonly string[], body: string, realm: SourceRealm,
): { readonly node: FunctionExpression; readonly text: string } {
  const head = `(${RUNTIME_FUNCTION_HEADS[kind]} anonymous(`;
  const paramText = parameterList(params);
  const own = functionLiteral(`${head}${paramText}\n) {})`, `${head}${paramText}\n) `.length, true, realm);
  if (typeof own === 'string') throw new realm.SyntaxError(own);
  const text = `${head}${paramText}\n) {\n${body}\n})`;
  const node = functionLiteral(text, `${head}${paramText}\n) `.length, false, realm);
  if (typeof node === 'string') throw new realm.SyntaxError(node);
  return { node, text };
}

/** Where a script's directive prologue ends and its one expression lies, in its text. */
export interface ScriptExpression {
  /** The end of the directive prologue (`'use strict';`), 0 when there is none. */
  readonly prologueEnd: number;
  readonly start: number;
  readonly end: number;
}

/**
 * The one expression a script is, after its directive prologue, for
 * vm.runInThisContext: node-shims hands the runtime-code service code it
 * cannot compile at request time, and the service runs it as a function
 * returning that expression's value (the script's completion value), its
 * directives the function's own. jiti's module wrapper
 * (`(function (exports, require, ...) { ... });`, Nuxt's config loader) and
 * vite-node's (`'use strict';(...) => { ... }`) are such scripts. A script
 * of directives alone (`"hello"`) completes with its last one's string: that
 * is the expression, and those before it the prologue. Throws the
 * SyntaxError V8 would for code that does not parse; null for a script of
 * another shape, whose completion value no function can stand in for.
 */
export function scriptExpression(code: string, realm: SourceRealm): ScriptExpression | null {
  let program: Program;
  try {
    program = parse(code, realm.scriptOptions);
  } catch (e) {
    throw new realm.SyntaxError(realm.messageOf(e));
  }
  const body = program.body;
  let first = 0;
  while (first < body.length && isDirective(body[first])) first++;
  if (first === body.length && first > 0) first--;
  if (first !== body.length - 1) return null;
  const statement = body[first];
  if (statement.type !== 'ExpressionStatement') return null;
  return { prologueEnd: first === 0 ? 0 : body[first - 1].end, start: statement.expression.start, end: statement.expression.end };
}

function isDirective(statement: Statement | ModuleDeclaration): boolean {
  return statement.type === 'ExpressionStatement' && typeof statement.directive === 'string';
}

/** The body of the function that returns an expression's value, after a script's directive prologue. */
export function expressionFunctionBody(prologue: string, expression: string): string {
  return `${prologue}\nreturn (\n${expression}\n);`;
}
