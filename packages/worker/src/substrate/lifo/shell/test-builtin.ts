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
export function evaluateTest(
  args: string[],
  vfs: VFS,
  stderr: CommandOutputStream,
  context?: BuiltinExecutionContext,
): number {
  return evaluateTestExpression(toLiteralArgs(args), vfs, stderr, context, 'test');
}

export async function evaluateDoubleBracketWords(
  words: WordPart[][],
  expandCtx: ExpandContext,
  vfs: VFS,
  stderr: CommandOutputStream,
  context?: BuiltinExecutionContext,
): Promise<number> {
  const args: TestArg[] = [];
  for (const word of words) {
    const value = await expandWord(word, expandCtx);
    args.push({
      value,
      canUseAsPattern: hasUnquotedPart(word) && hasPatternSyntax(value),
    });
  }
  return evaluateTestExpression(args, vfs, stderr, context, 'double-bracket');
}

type TestMode = 'test' | 'double-bracket';
type TestArg = {
  value: string;
  canUseAsPattern: boolean;
};

function evaluateTestExpression(
  args: TestArg[],
  vfs: VFS,
  stderr: CommandOutputStream,
  context: BuiltinExecutionContext | undefined,
  mode: TestMode,
): number {
  // `[` requires closing `]`
  if (mode === 'test' && args.length > 0 && args[args.length - 1]?.value === ']') {
    args = args.slice(0, -1);
  }
  if (args.length === 0) {
    return 1; // false
  }

  try {
    const result = parseExpr(args, 0, vfs, context, mode);
    if (result.pos !== args.length) {
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

function parseExpr(args: TestArg[], pos: number, vfs: VFS, context: BuiltinExecutionContext | undefined, mode: TestMode): ExprResult {
  return parseOr(args, pos, vfs, context, mode);
}

function parseOr(args: TestArg[], pos: number, vfs: VFS, context: BuiltinExecutionContext | undefined, mode: TestMode): ExprResult {
  let left = parseAnd(args, pos, vfs, context, mode);

  while (left.pos < args.length && isOrOperator(args[left.pos]?.value, mode)) {
    const right = parseAnd(args, left.pos + 1, vfs, context, mode);
    left = { value: left.value || right.value, pos: right.pos };
  }

  return left;
}

function parseAnd(args: TestArg[], pos: number, vfs: VFS, context: BuiltinExecutionContext | undefined, mode: TestMode): ExprResult {
  let left = parsePrimary(args, pos, vfs, context, mode);

  while (left.pos < args.length && isAndOperator(args[left.pos]?.value, mode)) {
    const right = parsePrimary(args, left.pos + 1, vfs, context, mode);
    left = { value: left.value && right.value, pos: right.pos };
  }

  return left;
}

function parsePrimary(args: TestArg[], pos: number, vfs: VFS, context: BuiltinExecutionContext | undefined, mode: TestMode): ExprResult {
  if (pos >= args.length) {
    return { value: false, pos };
  }

  const arg = args[pos]?.value ?? '';

  // Negation
  if (arg === '!') {
    const result = parsePrimary(args, pos + 1, vfs, context, mode);
    return { value: !result.value, pos: result.pos };
  }

  // Parenthesized expression
  if (arg === '(') {
    const result = parseExpr(args, pos + 1, vfs, context, mode);
    if (result.pos >= args.length || args[result.pos]?.value !== ')') {
      throw new Error('missing )');
    }
    return { value: result.value, pos: result.pos + 1 };
  }

  // Unary string tests
  if (arg === '-z' && pos + 1 < args.length) {
    return { value: (args[pos + 1]?.value ?? '').length === 0, pos: pos + 2 };
  }
  if (arg === '-n' && pos + 1 < args.length) {
    return { value: (args[pos + 1]?.value ?? '').length > 0, pos: pos + 2 };
  }
  if (arg === '-t' && pos + 1 < args.length) {
    return { value: context?.isFdTerminal(toInt(args[pos + 1]?.value ?? '')) ?? false, pos: pos + 2 };
  }

  // Unary file tests
  if (arg.startsWith('-') && arg.length === 2 && pos + 1 < args.length) {
    const flag = arg[1];
    const filePath = args[pos + 1]?.value ?? '';
    const fileResult = evaluateFileTest(flag, filePath, vfs);
    if (fileResult !== null) {
      return { value: fileResult, pos: pos + 2 };
    }
  }

  // Binary operators: check if there's an operator at pos+1
  if (pos + 2 <= args.length) {
    const op = args[pos + 1]?.value;
    if (op !== undefined) {
      // String comparisons
      if (op === '=' || op === '==') {
        return { value: stringCompare(args[pos] ?? literalArg(''), args[pos + 2] ?? literalArg(''), mode), pos: pos + 3 };
      }
      if (op === '!=') {
        return { value: !stringCompare(args[pos] ?? literalArg(''), args[pos + 2] ?? literalArg(''), mode), pos: pos + 3 };
      }
      if (op === '<') {
        return { value: (args[pos]?.value ?? '') < (args[pos + 2]?.value ?? ''), pos: pos + 3 };
      }
      if (op === '>') {
        return { value: (args[pos]?.value ?? '') > (args[pos + 2]?.value ?? ''), pos: pos + 3 };
      }

      // Integer comparisons
      if (op === '-eq') {
        return { value: toInt(args[pos]?.value ?? '') === toInt(args[pos + 2]?.value ?? ''), pos: pos + 3 };
      }
      if (op === '-ne') {
        return { value: toInt(args[pos]?.value ?? '') !== toInt(args[pos + 2]?.value ?? ''), pos: pos + 3 };
      }
      if (op === '-lt') {
        return { value: toInt(args[pos]?.value ?? '') < toInt(args[pos + 2]?.value ?? ''), pos: pos + 3 };
      }
      if (op === '-le') {
        return { value: toInt(args[pos]?.value ?? '') <= toInt(args[pos + 2]?.value ?? ''), pos: pos + 3 };
      }
      if (op === '-gt') {
        return { value: toInt(args[pos]?.value ?? '') > toInt(args[pos + 2]?.value ?? ''), pos: pos + 3 };
      }
      if (op === '-ge') {
        return { value: toInt(args[pos]?.value ?? '') >= toInt(args[pos + 2]?.value ?? ''), pos: pos + 3 };
      }
    }
  }

  // Single string argument -- true if non-empty
  return { value: arg.length > 0, pos: pos + 1 };
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

function toLiteralArgs(args: string[]): TestArg[] {
  return args.map(literalArg);
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

function evaluateFileTest(flag: string, path: string, vfs: VFS): boolean | null {
  switch (flag) {
    case 'e': {
      return vfs.exists(path);
    }
    case 'f': {
      if (!vfs.exists(path)) return false;
      try {
        const stat = vfs.stat(path);
        return stat.type === 'file';
      } catch {
        return false;
      }
    }
    case 'd': {
      if (!vfs.exists(path)) return false;
      try {
        const stat = vfs.stat(path);
        return stat.type === 'directory';
      } catch {
        return false;
      }
    }
    case 's': {
      if (!vfs.exists(path)) return false;
      try {
        const stat = vfs.stat(path);
        return stat.type === 'file' && stat.size > 0;
      } catch {
        return false;
      }
    }
    case 'r':
    case 'w':
    case 'x': {
      // In VFS, all files are readable/writable/executable if they exist
      return vfs.exists(path);
    }
    default:
      return null;
  }
}

function toInt(s: string): number {
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}
