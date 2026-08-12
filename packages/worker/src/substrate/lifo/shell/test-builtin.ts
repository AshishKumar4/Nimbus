import type { VFS } from '../kernel/vfs/index.js';
import type { CommandOutputStream } from '../commands/types.js';
import type { BuiltinExecutionContext } from './interpreter.js';
import type { WordPart } from './types.js';
import { expandWord, type ExpandContext } from './expander.js';
import { globMatch } from '../utils/glob.js';

/**
 * Implementation of the `test` / `[` shell builtin.
 * Evaluates conditional expressions.
 */
export async function evaluateTest(
  args: string[],
  vfs: VFS,
  stderr: CommandOutputStream,
  context?: BuiltinExecutionContext,
): Promise<number> {
  // `[` requires a closing `]`
  const operands = args.length > 0 && args[args.length - 1] === ']' ? args.slice(0, -1) : args;
  return evaluateTestExpression(literalOperands(operands), vfs, stderr, context, 'test');
}

/**
 * `[[ ... ]]`, whose operands are expanded only when the expression actually
 * reaches them: `[[ $# = 2 && $2 = x ]]` must not touch `$2` under `set -u`.
 */
export async function evaluateDoubleBracketWords(
  words: WordPart[][],
  expandCtx: ExpandContext,
  vfs: VFS,
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
  return evaluateTestExpression(operands, vfs, stderr, context, 'double-bracket');
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
  vfs: VFS,
  stderr: CommandOutputStream,
  context: BuiltinExecutionContext | undefined,
  mode: TestMode,
): Promise<number> {
  if (operands.length === 0) {
    return 1; // false
  }

  try {
    const result = await parseOr(operands, 0, vfs, context, mode, true);
    if (result.pos !== operands.length) {
      stderr.write('test: too many arguments\n');
      return 2;
    }
    return result.value ? 0 : 1;
  } catch (e) {
    stderr.write(`test: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
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
  ops: Operands, pos: number, vfs: VFS,
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
  ops: Operands, pos: number, vfs: VFS,
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
  ops: Operands, pos: number, vfs: VFS,
  context: BuiltinExecutionContext | undefined, mode: TestMode, evaluate: boolean,
): Promise<ExprResult> {
  if (pos >= ops.length) {
    return { value: false, pos };
  }

  const arg = ops.literal(pos) ?? '';
  const valueAt = async (index: number): Promise<string> =>
    (evaluate ? (await ops.value(index)).value : '');

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

  // Unary string tests
  if (arg === '-z' && pos + 1 < ops.length) {
    return { value: (await valueAt(pos + 1)).length === 0, pos: pos + 2 };
  }
  if (arg === '-n' && pos + 1 < ops.length) {
    return { value: (await valueAt(pos + 1)).length > 0, pos: pos + 2 };
  }
  if (arg === '-t' && pos + 1 < ops.length) {
    return {
      value: context?.isFdTerminal(toInt(await valueAt(pos + 1))) ?? false,
      pos: pos + 2,
    };
  }

  // Unary file tests
  if (arg.startsWith('-') && arg.length === 2 && pos + 1 < ops.length && isFileTestFlag(arg[1])) {
    const fileResult = evaluate
      ? evaluateFileTest(arg[1], await valueAt(pos + 1), vfs)
      : false;
    return { value: fileResult, pos: pos + 2 };
  }

  // Binary operators: check if there's an operator at pos+1
  if (pos + 2 <= ops.length) {
    const op = ops.literal(pos + 1);
    if (op !== undefined) {
      // String comparisons
      if (op === '=' || op === '==' || op === '!=') {
        const equal = evaluate
          ? stringCompare(await ops.value(pos), await ops.value(pos + 2), mode)
          : false;
        return { value: op === '!=' ? !equal : equal, pos: pos + 3 };
      }
      if (op === '<') {
        return { value: (await valueAt(pos)) < (await valueAt(pos + 2)), pos: pos + 3 };
      }
      if (op === '>') {
        return { value: (await valueAt(pos)) > (await valueAt(pos + 2)), pos: pos + 3 };
      }

      // Integer comparisons
      const integerCompare = INTEGER_COMPARISONS[op];
      if (integerCompare !== undefined) {
        const value = evaluate
          && integerCompare(toInt(await valueAt(pos)), toInt(await valueAt(pos + 2)));
        return { value, pos: pos + 3 };
      }
    }
  }

  // Single string argument -- true if non-empty
  return { value: (await valueAt(pos)).length > 0, pos: pos + 1 };
}

const INTEGER_COMPARISONS: Record<string, ((a: number, b: number) => boolean) | undefined> = {
  '-eq': (a, b) => a === b,
  '-ne': (a, b) => a !== b,
  '-lt': (a, b) => a < b,
  '-le': (a, b) => a <= b,
  '-gt': (a, b) => a > b,
  '-ge': (a, b) => a >= b,
};

const FILE_TEST_FLAGS = 'efdsrwx';

function isFileTestFlag(flag: string): boolean {
  return FILE_TEST_FLAGS.includes(flag);
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

function evaluateFileTest(flag: string, path: string, vfs: VFS): boolean {
  switch (flag) {
    case 'e':
      return statOf(vfs, path) !== null;
    case 'f':
      return statOf(vfs, path)?.type === 'file';
    case 'd':
      return statOf(vfs, path)?.type === 'directory';
    case 's': {
      const stat = statOf(vfs, path);
      return stat !== null && stat.type === 'file' && stat.size > 0;
    }
    default: {
      const mode = flag === 'r' ? 0o4 : flag === 'w' ? 0o2 : 0o1;
      try {
        vfs.access(path, mode);
        return true;
      } catch {
        return false;
      }
    }
  }
}

function statOf(vfs: VFS, path: string): { type: string; size: number } | null {
  try {
    return vfs.stat(path);
  } catch {
    return null;
  }
}

function toInt(s: string): number {
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}
