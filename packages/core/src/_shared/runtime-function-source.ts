/**
 * runtime-function-source.ts — the source text a Function constructor call
 * stands for, and when V8 refuses it. Shared by the module a staged call
 * becomes (commonjs-cell.ts) and the interpreter that runs an unstaged one.
 */
import { parse, type FunctionExpression, type Program } from 'acorn';

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

export function isRuntimeFunctionKind(kind: string): kind is RuntimeFunctionKind {
  return Object.hasOwn(RUNTIME_FUNCTION_HEADS, kind);
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
function functionLiteral(text: string, bodyStart: number, emptyBody: boolean): FunctionExpression | string {
  let program: Program;
  try {
    program = parse(text, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
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
export function runtimeFunctionSyntaxError(kind: RuntimeFunctionKind, params: readonly string[], body: string): string | null {
  const head = `(${RUNTIME_FUNCTION_HEADS[kind]} anonymous(`;
  const paramText = parameterList(params);
  const checks: Array<[text: string, bodyStart: number, emptyBody: boolean]> = [
    [`${head}${paramText}\n) {})`, `${head}${paramText}\n) `.length, true],
    [`${head}\n) {\n${body}\n})`, `${head}\n) `.length, false],
    [`${head}${paramText}\n) {\n${body}\n})`, `${head}${paramText}\n) `.length, false],
  ];
  for (let i = 0; i < checks.length; i++) {
    const checked = functionLiteral(checks[i][0], checks[i][1], checks[i][2]);
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
export function parseRuntimeFunction(kind: RuntimeFunctionKind, params: readonly string[], body: string): { readonly node: FunctionExpression; readonly text: string } {
  const head = `(${RUNTIME_FUNCTION_HEADS[kind]} anonymous(`;
  const paramText = parameterList(params);
  const own = functionLiteral(`${head}${paramText}\n) {})`, `${head}${paramText}\n) `.length, true);
  if (typeof own === 'string') throw new SyntaxError(own);
  const text = `${head}${paramText}\n) {\n${body}\n})`;
  const node = functionLiteral(text, `${head}${paramText}\n) `.length, false);
  if (typeof node === 'string') throw new SyntaxError(node);
  return { node, text };
}
