import type { Command, CommandOutputStream } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { getMimeType, isBinaryMime } from '../../utils/mime.js';

type SedVfs = {
  stat(path: string): object;
  readFileString(path: string): string;
  writeFile(path: string, content: string | Uint8Array): void;
};

type SedInput = {
  readAll(): Promise<string>;
};

export type SedExecutionContext = {
  args: string[];
  cwd: string;
  vfs: SedVfs;
  stdout: CommandOutputStream;
  stderr: CommandOutputStream;
  stdin?: SedInput;
};

interface SedExpr {
  type: 's' | 'd' | 'p';
  pattern?: RegExp;
  replacement?: string;
  global?: boolean;
  print?: boolean;
}

type SedCommandOptions = {
  inPlace: boolean;
  quiet: boolean;
  expressions: string[];
  files: string[];
};

function parseSedExpr(expr: string): SedExpr | null {
  if (expr === 'd') {
    return { type: 'd' };
  }
  if (expr === 'p') {
    return { type: 'p' };
  }
  // s/pattern/replacement/flags
  if (expr.startsWith('s')) {
    const delim = expr[1];
    if (!delim) return null;
    const parts: string[] = [];
    let current = '';
    let escaped = false;
    for (let i = 2; i < expr.length; i++) {
      if (escaped) {
        current += expr[i];
        escaped = false;
      } else if (expr[i] === '\\') {
        escaped = true;
        current += '\\';
      } else if (expr[i] === delim) {
        parts.push(current);
        current = '';
      } else {
        current += expr[i];
      }
    }
    parts.push(current); // remaining flags part
    if (parts.length < 2) return null;

    const patternStr = parts[0];
    const replacement = parts[1] ?? '';
    const flagStr = parts[2] || '';
    const globalFlag = flagStr.includes('g');
    const caseInsensitive = flagStr.includes('i');
    const print = flagStr.includes('p');

    let regex: RegExp;
    try {
      let flags = '';
      if (globalFlag) flags += 'g';
      if (caseInsensitive) flags += 'i';
      regex = new RegExp(toJavascriptPattern(patternStr ?? ''), flags);
    } catch {
      return null;
    }

    return { type: 's', pattern: regex, replacement, global: globalFlag, print };
  }
  return null;
}

function toJavascriptPattern(pattern: string): string {
  let result = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === '\\' && (next === '(' || next === ')')) {
      result += next;
      i++;
      continue;
    }
    result += char;
  }
  return result;
}

function isDigit(value: string): boolean {
  const code = value.charCodeAt(0);
  return code >= 48 && code <= 57;
}

export async function runSed(ctx: SedExecutionContext): Promise<number> {
  const options = parseSedArgs(ctx.args);

  if (options.expressions.length === 0) {
    ctx.stderr.write('sed: missing expression\n');
    return 1;
  }

  const parsedExprs: SedExpr[] = [];
  for (const expr of options.expressions) {
    const parsed = parseSedExpr(expr);
    if (!parsed) {
      ctx.stderr.write(`sed: invalid expression: ${expr}\n`);
      return 1;
    }
    parsedExprs.push(parsed);
  }

  function processText(text: string): string {
    const lines = text.replace(/\n$/, '').split('\n');
    const output: string[] = [];

    for (let line of lines) {
      let deleted = false;
      for (const expr of parsedExprs) {
        if (expr.type === 's' && expr.pattern && expr.replacement !== undefined) {
          let changed = false;
          expr.pattern.lastIndex = 0;
          line = line.replace(expr.pattern, (...match) => {
            changed = true;
            return expandReplacement(expr.replacement ?? '', match.slice(1, -2), String(match[0]));
          });
          if (changed && expr.print) {
            output.push(line);
          }
        } else if (expr.type === 'd') {
          deleted = true;
          break;
        } else if (expr.type === 'p') {
          output.push(line);
        }
      }
      if (!deleted && !options.quiet) {
        output.push(line);
      }
    }

    return output.join('\n') + '\n';
  }

  if (options.files.length === 0) {
    if (ctx.stdin) {
      const text = await ctx.stdin.readAll();
      ctx.stdout.write(processText(text));
    } else {
      ctx.stderr.write('sed: missing file operand\n');
      return 1;
    }
    return 0;
  }

  let exitCode = 0;
  for (const file of options.files) {
    const path = resolve(ctx.cwd, file);
    try {
      ctx.vfs.stat(path);
      if (isBinaryMime(getMimeType(path))) {
        ctx.stderr.write(`sed: ${file}: binary file, skipping\n`);
        continue;
      }
      const content = ctx.vfs.readFileString(path);
      const result = processText(content);
      if (options.inPlace) {
        ctx.vfs.writeFile(path, result);
      } else {
        ctx.stdout.write(result);
      }
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`sed: ${file}: ${e.message}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
  }

  return exitCode;
}

function parseSedArgs(args: string[]): SedCommandOptions {
  const options: SedCommandOptions = {
    inPlace: false,
    quiet: false,
    expressions: [],
    files: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';

    if (arg === '-i') {
      options.inPlace = true;
      continue;
    }
    if (arg === '-n' || arg === '--quiet' || arg === '--silent') {
      options.quiet = true;
      continue;
    }
    if (arg === '-e') {
      options.expressions.push(args[++i] ?? '');
      continue;
    }
    if (arg.startsWith('-') && arg.length > 2 && parseSedShortCluster(options, arg, args, i)) {
      if (clusterNeedsNextArg(arg)) i++;
      continue;
    }
    if (options.expressions.length === 0 && !arg.startsWith('-')) {
      options.expressions.push(arg);
      continue;
    }

    options.files.push(arg);
  }

  return options;
}

function parseSedShortCluster(options: SedCommandOptions, arg: string, args: string[], index: number): boolean {
  for (let j = 1; j < arg.length; j++) {
    const flag = arg[j];
    if (flag === 'n') {
      options.quiet = true;
      continue;
    }
    if (flag === 'i') {
      options.inPlace = true;
      continue;
    }
    if (flag === 'e') {
      const rest = arg.slice(j + 1);
      options.expressions.push(rest || args[index + 1] || '');
      return true;
    }
    return false;
  }
  return true;
}

function clusterNeedsNextArg(arg: string): boolean {
  const eIndex = arg.indexOf('e');
  return eIndex !== -1 && eIndex === arg.length - 1;
}

function expandReplacement(
  replacement: string,
  captures: readonly string[],
  matched: string,
): string {
  let result = '';
  for (let i = 0; i < replacement.length; i++) {
    const char = replacement[i];
    const next = replacement[i + 1];
    if (char === '\\' && next !== undefined) {
      if (isDigit(next)) {
        result += String(captures[Number(next) - 1] ?? '');
        i++;
        continue;
      }
      result += next;
      i++;
      continue;
    }
    if (char === '&') {
      result += matched;
      continue;
    }
    result += char;
  }
  return result;
}

const command: Command = async (ctx) => runSed(ctx);

export default command;
