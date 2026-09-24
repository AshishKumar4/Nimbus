import type { ExecutionFs, ExecutionStat } from "../../../shell/execution-fs.js";
import type { CommandOutputStream } from '../commands/types.js';
import type { BuiltinExecutionContext } from './interpreter.js';
import type { WordPart } from './types.js';
import { expandWord, type ExpandContext } from './expander.js';
import { globMatch } from '../utils/glob.js';
import { resolve } from '../utils/path.js';
import { S_IFCHR, S_IFMT } from '../kernel/vfs/types.js';

/**
 * Implementation of the `test` / `[` shell builtin (POSIX `test`).
 * `bracket` is true for `[`, whose last argument must be `]`.
 */
export async function evaluateTest(
  args: string[],
  vfs: ExecutionFs,
  stderr: CommandOutputStream,
  context?: BuiltinExecutionContext,
  bracket = false,
): Promise<number> {
  let operands = args;
  if (bracket) {
    if (args[args.length - 1] !== ']') {
      (await stderr.write('[: missing ]\n'));
      return 2;
    }
    operands = args.slice(0, -1);
  }
  return (await evaluateTestExpression(literalOperands(operands), vfs, stderr, context, 'test'));
}

/**
 * `[[ ... ]]`, whose operands are expanded only when the expression actually
 * reaches them: `[[ $# = 2 && $2 = x ]]` must not touch `$2` under `set -u`.
 */
export async function evaluateDoubleBracketWords(
  words: WordPart[][],
  expandCtx: ExpandContext,
  vfs: ExecutionFs,
  stderr: CommandOutputStream,
  context?: BuiltinExecutionContext,
): Promise<number> {
  const expanded = new Map<number, TestArg>();
  const operands: Operands = {
    length: words.length,
    literal: (i) => operatorTextOf(words[i]),
    value: async (i) => {
      const cached = expanded.get(i);
      if (cached !== undefined) return cached;
      const word = words[i] ?? [];
      const value = await expandWord(word, expandCtx);
      const arg: TestArg = {
        value,
        canUseAsPattern: hasUnquotedPart(word) && hasPatternSyntax(value),
      };
      expanded.set(i, arg);
      return arg;
    },
  };
  return (await evaluateTestExpression(operands, vfs, stderr, context, 'double-bracket'));
}

type TestMode = 'test' | 'double-bracket';
type TestArg = {
  value: string;
  canUseAsPattern: boolean;
};

/**
 * The words of a conditional expression. `literal` is the operator view — the
 * word as written, which is what decides the shape of the expression — and
 * `value` is the expanded operand, produced on demand.
 */
type Operands = {
  readonly length: number;
  literal(index: number): string | undefined;
  value(index: number): Promise<TestArg>;
};

function literalOperands(args: string[]): Operands {
  return {
    length: args.length,
    literal: (i) => args[i],
    value: async (i) => literalArg(args[i] ?? ''),
  };
}

/** `[[` recognises an operator only when it is written literally. */
function operatorTextOf(word: WordPart[] | undefined): string | undefined {
  if (word === undefined || word.length !== 1) return undefined;
  const part = word[0];
  if (part.quoted !== 'none' || part.commandSubstitution !== undefined) return undefined;
  if (part.text.includes('$')) return undefined;
  return part.text;
}

async function evaluateTestExpression(
  operands: Operands,
  vfs: ExecutionFs,
  stderr: CommandOutputStream,
  context: BuiltinExecutionContext | undefined,
  mode: TestMode,
): Promise<number> {
  if (operands.length === 0) {
    return 1; // false
  }

  try {
    const posix = mode === 'test' && operands.length <= 4
      ? await evaluateByArgCount(operands, 0, operands.length, vfs, context)
      : undefined;
    if (posix !== undefined) return posix ? 0 : 1;
    const result = await parseOr(operands, 0, vfs, context, mode, true);
    if (result.pos !== operands.length) {
      (await stderr.write('test: too many arguments\n'));
      return 2;
    }
    return result.value ? 0 : 1;
  } catch (e) {
    (await stderr.write(`test: ${e instanceof Error ? e.message : String(e)}\n`));
    return 2;
  }
}

/**
 * POSIX decides `test` with four or fewer arguments by their count, so an
 * operand spelled like an operator (`[ "$x" = -n ]`, `[ ! = ! ]`) is still an
 * operand. Returns undefined where POSIX leaves the result unspecified and the
 * general grammar should decide.
 */
async function evaluateByArgCount(
  ops: Operands, start: number, count: number, vfs: ExecutionFs,
  context: BuiltinExecutionContext | undefined,
): Promise<boolean | undefined> {
  const at = (i: number) => ops.literal(start + i) ?? '';
  switch (count) {
    case 0:
      return false;
    case 1:
      return at(0).length > 0;
    case 2:
      if (at(0) === '!') return at(1).length === 0;
      if (Object.hasOwn(UNARY_OPERATORS, at(0))) return await evaluateUnary(at(0), at(1), vfs, context);
      throw new Error(`${at(0)}: unary operator expected`);
    case 3: {
      if (at(1) === '-a') return at(0).length > 0 && at(2).length > 0;
      if (at(1) === '-o') return at(0).length > 0 || at(2).length > 0;
      const binary = evaluateBinary(at(1), literalArg(at(0)), literalArg(at(2)), 'test');
      if (binary !== undefined) return binary;
      if (at(0) === '!') {
        const inner = await evaluateByArgCount(ops, start + 1, 2, vfs, context);
        return inner === undefined ? undefined : !inner;
      }
      if (at(0) === '(' && at(2) === ')') return at(1).length > 0;
      throw new Error(`${at(1)}: binary operator expected`);
    }
    case 4:
      if (at(0) === '!') {
        const inner = await evaluateByArgCount(ops, start + 1, 3, vfs, context);
        return inner === undefined ? undefined : !inner;
      }
      if (at(0) === '(' && at(3) === ')') return await evaluateByArgCount(ops, start + 1, 2, vfs, context);
      return undefined;
    default:
      return undefined;
  }
}

interface ExprResult {
  value: boolean;
  pos: number;
}

/**
 * `evaluate` is false once a short-circuit has decided the result: the walk
 * still advances over the remaining operands (their positions are fixed by the
 * literal operators alone) but never expands them.
 */
async function parseOr(
  ops: Operands, pos: number, vfs: ExecutionFs,
  context: BuiltinExecutionContext | undefined, mode: TestMode, evaluate: boolean,
): Promise<ExprResult> {
  let left = await parseAnd(ops, pos, vfs, context, mode, evaluate);

  while (left.pos < ops.length && isOrOperator(ops.literal(left.pos), mode)) {
    const right = await parseAnd(ops, left.pos + 1, vfs, context, mode, evaluate && !left.value);
    left = { value: left.value || right.value, pos: right.pos };
  }

  return left;
}

async function parseAnd(
  ops: Operands, pos: number, vfs: ExecutionFs,
  context: BuiltinExecutionContext | undefined, mode: TestMode, evaluate: boolean,
): Promise<ExprResult> {
  let left = await parsePrimary(ops, pos, vfs, context, mode, evaluate);

  while (left.pos < ops.length && isAndOperator(ops.literal(left.pos), mode)) {
    const right = await parsePrimary(ops, left.pos + 1, vfs, context, mode, evaluate && left.value);
    left = { value: left.value && right.value, pos: right.pos };
  }

  return left;
}

async function parsePrimary(
  ops: Operands, pos: number, vfs: ExecutionFs,
  context: BuiltinExecutionContext | undefined, mode: TestMode, evaluate: boolean,
): Promise<ExprResult> {
  if (pos >= ops.length) {
    return { value: false, pos };
  }

  const arg = ops.literal(pos) ?? '';

  // Negation
  if (arg === '!') {
    const result = await parsePrimary(ops, pos + 1, vfs, context, mode, evaluate);
    return { value: !result.value, pos: result.pos };
  }

  // Parenthesized expression
  if (arg === '(') {
    const result = await parseOr(ops, pos + 1, vfs, context, mode, evaluate);
    if (result.pos >= ops.length || ops.literal(result.pos) !== ')') {
      throw new Error('missing )');
    }
    return { value: result.value, pos: result.pos + 1 };
  }

  // A binary operator in second place wins over a unary reading of the first word.
  const op = pos + 2 < ops.length ? ops.literal(pos + 1) : undefined;
  if (op !== undefined && Object.hasOwn(BINARY_OPERATORS, op)) {
    const value = evaluate
      ? evaluateBinary(op, await ops.value(pos), await ops.value(pos + 2), mode) ?? false
      : false;
    return { value, pos: pos + 3 };
  }

  if (Object.hasOwn(UNARY_OPERATORS, arg) && pos + 1 < ops.length) {
    const value = evaluate
      ? await evaluateUnary(arg, (await ops.value(pos + 1)).value, vfs, context)
      : false;
    return { value, pos: pos + 2 };
  }

  // Single string argument -- true if non-empty
  return { value: evaluate && (await ops.value(pos)).value.length > 0, pos: pos + 1 };
}

const INTEGER_COMPARISONS: Record<string, ((a: number, b: number) => boolean) | undefined> = {
  '-eq': (a, b) => a === b,
  '-ne': (a, b) => a !== b,
  '-lt': (a, b) => a < b,
  '-le': (a, b) => a <= b,
  '-gt': (a, b) => a > b,
  '-ge': (a, b) => a >= b,
};

const BINARY_OPERATORS: Record<string, true> = {
  '=': true, '==': true, '!=': true, '<': true, '>': true,
  '-eq': true, '-ne': true, '-lt': true, '-le': true, '-gt': true, '-ge': true,
};

// POSIX unary primaries; -h and -L are the same symlink test.
const UNARY_OPERATORS: Record<string, true> = {
  '-b': true, '-c': true, '-d': true, '-e': true, '-f': true, '-g': true, '-h': true, '-k': true, '-L': true,
  '-n': true, '-p': true, '-r': true, '-s': true, '-S': true, '-t': true, '-u': true, '-w': true, '-x': true, '-z': true,
};

/** Undefined when `op` is not a binary comparison. */
function evaluateBinary(op: string, left: TestArg, right: TestArg, mode: TestMode): boolean | undefined {
  switch (op) {
    case '=':
    case '==':
      return stringCompare(left, right, mode);
    case '!=':
      return !stringCompare(left, right, mode);
    case '<':
      return left.value < right.value;
    case '>':
      return left.value > right.value;
  }
  const integerCompare = Object.hasOwn(INTEGER_COMPARISONS, op) ? INTEGER_COMPARISONS[op] : undefined;
  return integerCompare?.(toInt(left.value), toInt(right.value));
}

async function evaluateUnary(
  op: string, operand: string, vfs: ExecutionFs, context: BuiltinExecutionContext | undefined,
): Promise<boolean> {
  switch (op) {
    case '-z':
      return operand.length === 0;
    case '-n':
      return operand.length > 0;
    case '-t':
      return context?.isFdTerminal(toInt(operand)) ?? false;
    default:
      return await evaluateFileTest(op[1], operand, vfs, context?.cwd);
  }
}

function isOrOperator(value: string | undefined, mode: TestMode): boolean {
  return value === '-o' || (mode === 'double-bracket' && value === '||');
}

function isAndOperator(value: string | undefined, mode: TestMode): boolean {
  return value === '-a' || (mode === 'double-bracket' && value === '&&');
}

function stringCompare(left: TestArg, right: TestArg, mode: TestMode): boolean {
  if (mode === 'double-bracket' && right.canUseAsPattern) {
    return globMatch(right.value, left.value);
  }
  return left.value === right.value;
}

function literalArg(value: string): TestArg {
  return { value, canUseAsPattern: false };
}

function hasUnquotedPart(word: WordPart[]): boolean {
  return word.some((part) => part.quoted === 'none');
}

function hasPatternSyntax(value: string): boolean {
  return value.includes('*') || value.includes('?') || value.includes('[');
}

/**
 * File tests resolve their operand against the working directory, the way
 * every other command does. Handing the VFS a bare `config.json` asked it
 * about a path at the root, so `[ -f config.json ]` was false for a file
 * sitting right there — silently taking the wrong branch rather than failing.
 */
async function evaluateFileTest(flag: string, operand: string, vfs: ExecutionFs, cwd?: string): Promise<boolean> {
  const path = cwd === undefined ? operand : resolve(cwd, operand);
  if (flag === 'h' || flag === 'L') {
    return (await statOf(vfs, path, false))?.type === 'symlink';
  }
  if (flag === 'r' || flag === 'w' || flag === 'x') {
    try {
      (await vfs.access(path, flag === 'r' ? 0o4 : flag === 'w' ? 0o2 : 0o1));
      return true;
    } catch {
      return false;
    }
  }
  const stat = await statOf(vfs, path, true);
  if (stat === null) return false;
  switch (flag) {
    case 'e':
      return true;
    case 'f':
      return stat.type === 'file';
    case 'd':
      return stat.type === 'directory';
    case 's':
      return stat.type === 'file' && stat.size > 0;
    case 'b':
    case 'c':
    case 'p':
    case 'S':
      return (stat.mode & S_IFMT) === SPECIAL_FILE_FORMATS[flag];
    default:
      return (stat.mode & MODE_BITS[flag]) !== 0;
  }
}

const SPECIAL_FILE_FORMATS: Record<string, number> = { b: 0o060000, c: S_IFCHR, p: 0o010000, S: 0o140000 };
const MODE_BITS: Record<string, number> = { u: 0o4000, g: 0o2000, k: 0o1000 };

async function statOf(vfs: ExecutionFs, path: string, followSymlinks: boolean): Promise<ExecutionStat | null> {
  try {
    return followSymlinks ? await vfs.stat(path) : await vfs.lstat(path);
  } catch {
    return null;
  }
}

function toInt(s: string): number {
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}
