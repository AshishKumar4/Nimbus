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

type SedAddress =
  | { kind: 'line'; value: number }
  | { kind: 'last' }
  // An empty `//` address repeats the last regular expression that execution
  // actually evaluated — parse order is irrelevant.
  | { kind: 'empty' }
  | { kind: 'regex'; regex: RegExp };

type SedRange = { kind: 'range'; start: SedAddress; end: SedAddress };

interface SedCommand {
  address?: SedAddress | SedRange;
  negate: boolean;
  type: 's' | 'd' | 'p';
  pattern?: RegExp;
  emptyPattern?: boolean;
  replacement?: string;
  global?: boolean;
  insensitive?: boolean;
  print?: boolean;
}

class SedParseError extends Error {
  constructor(readonly expr: string) {
    super(`invalid expression: ${expr}`);
  }
}

type SedScriptCursor = { expr: string; i: number };

type SedRegexRecord = { source?: string; flags?: string };

type SedLogicalLine = { text: string; terminated: boolean };

type SedEvalContext = {
  line: string;
  lineNumber: number;
  isLast: boolean;
  lastRegex: SedRegexRecord;
};

// GNU keeps already-written output when an empty pattern has nothing to
// repeat yet, so the error carries the output emitted before it fired.
class SedRuntimeError extends Error {
  constructor(readonly partialOutput = '') {
    super('no previous regular expression');
  }
}

function toLogicalLines(text: string): SedLogicalLine[] {
  if (text === '') return [];
  const terminated = text.endsWith('\n');
  const parts = (terminated ? text.slice(0, -1) : text).split('\n');
  return parts.map((part, index) => ({
    text: part ?? '',
    terminated: terminated || index < parts.length - 1,
  }));
}

type SedCommandOptions = {
  inPlace: boolean;
  quiet: boolean;
  expressions: string[];
  files: string[];
};

function parseSedScript(expr: string): SedCommand[] {
  const cur: SedScriptCursor = { expr, i: 0 };
  const commands: SedCommand[] = [];

  for (;;) {
    skipBlanks(cur);
    const ch = peek(cur);
    if (ch === undefined) break;
    if (ch === ';' || ch === '\n') {
      cur.i++;
      continue;
    }
    if (ch === '#') {
      skipComment(cur);
      continue;
    }

    commands.push(parseSedCommand(cur));
  }
  return commands;
}

function parseSedCommand(cur: SedScriptCursor): SedCommand {
  let address: SedAddress | SedRange | undefined;
  const start = tryParseSedAddress(cur);
  if (start) {
    skipBlanks(cur);
    if (peek(cur) === ',') {
      cur.i++;
      skipBlanks(cur);
      const end = tryParseSedAddress(cur);
      if (!end) throw new SedParseError(cur.expr);
      address = { kind: 'range', start, end };
    } else {
      address = start;
    }
  }

  skipBlanks(cur);
  let negate = false;
  if (peek(cur) === '!') {
    negate = true;
    cur.i++;
    skipBlanks(cur);
  }
  if (!address && negate) throw new SedParseError(cur.expr);
  if (peek(cur) === '!') throw new SedParseError(cur.expr);

  const op = peek(cur);
  if (op === 'd') {
    cur.i++;
    ensureCommandEnd(cur);
    return { address, negate, type: 'd' };
  }
  if (op === 'p') {
    cur.i++;
    ensureCommandEnd(cur);
    return { address, negate, type: 'p' };
  }
  if (op === 's') {
    return { address, negate, ...parseSubstitution(cur) };
  }
  throw new SedParseError(cur.expr);
}

function tryParseSedAddress(cur: SedScriptCursor): SedAddress | undefined {
  const ch = peek(cur);
  if (ch === undefined) return undefined;
  if (isDigit(ch)) {
    const start = cur.i;
    while (isDigit(peek(cur))) cur.i++;
    const value = Number(cur.expr.slice(start, cur.i));
    if (value === 0) throw new SedParseError(cur.expr);
    return { kind: 'line', value };
  }
  if (ch === '$') {
    cur.i++;
    return { kind: 'last' };
  }
  if (ch === '/') {
    return parseDelimitedRegex(cur);
  }
  return undefined;
}

function parseDelimitedRegex(cur: SedScriptCursor): SedAddress {
  cur.i++;
  let raw = '';
  let closed = false;
  while (cur.i < cur.expr.length) {
    const ch = peek(cur);
    if (ch === '\\') {
      // An escaped newline continues the pattern; everything else is literal.
      const next = cur.expr[cur.i + 1];
      if (next === undefined) break;
      raw += ch + next;
      cur.i += 2;
      continue;
    }
    if (ch === '\n') throw new SedParseError(cur.expr);
    if (ch === '/') {
      cur.i++;
      closed = true;
      break;
    }
    raw += ch;
    cur.i++;
  }
  if (!closed) throw new SedParseError(cur.expr);

  const source = toJavascriptPattern(raw);
  if (source === '') return { kind: 'empty' };
  try {
    return { kind: 'regex', regex: new RegExp(source) };
  } catch {
    throw new SedParseError(cur.expr);
  }
}

function parseSubstitution(cur: SedScriptCursor): Pick<SedCommand, 'type' | 'pattern' | 'emptyPattern' | 'replacement' | 'global' | 'insensitive' | 'print'> {
  cur.i++;
  const delim = peek(cur);
  if (delim === undefined) throw new SedParseError(cur.expr);
  cur.i++;

  const readPart = (): string => {
    let part = '';
    let escaped = false;
    while (cur.i < cur.expr.length) {
      const ch = peek(cur);
      if (escaped) {
        part += ch;
        escaped = false;
        cur.i++;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        part += '\\';
        cur.i++;
        continue;
      }
      if (ch === delim) {
        cur.i++;
        return part;
      }
      part += ch;
      cur.i++;
    }
    throw new SedParseError(cur.expr);
  };

  const patternStr = readPart();
  const replacement = readPart();

  // GNU's in_nonblank(): blanks may sit between flags; a flag run ends only
  // at `;`, a newline, a comment, or the end of the script.
  let flagStr = '';
  for (;;) {
    skipBlanks(cur);
    const ch = peek(cur);
    if (ch === undefined || ch === ';' || ch === '\n' || ch === '#') break;
    flagStr += ch;
    cur.i++;
  }

  for (const flag of flagStr) {
    if (flag !== 'g' && flag !== 'i' && flag !== 'p') throw new SedParseError(cur.expr);
  }

  const global = flagStr.includes('g');
  const insensitive = flagStr.includes('i');
  if (patternStr === '') {
    // Match modifiers belong to the repeated expression; only action flags
    // may accompany an empty pattern.
    if (insensitive) throw new SedParseError(cur.expr);
    return { type: 's', emptyPattern: true, replacement, global, insensitive, print: flagStr.includes('p') };
  }
  try {
    let flags = '';
    if (global) flags += 'g';
    if (insensitive) flags += 'i';
    const pattern = new RegExp(toJavascriptPattern(patternStr), flags);
    return { type: 's', pattern, replacement, global, insensitive, print: flagStr.includes('p') };
  } catch {
    throw new SedParseError(cur.expr);
  }
}

// Blanks may surround an address or an operation, but a command ends only at
// `;`, a newline, a comment, or the end of the script — never at a following
// command letter, which GNU sed reports as extra characters.
function ensureCommandEnd(cur: SedScriptCursor): void {
  skipBlanks(cur);
  const ch = peek(cur);
  if (ch === undefined || ch === ';' || ch === '\n' || ch === '#') return;
  throw new SedParseError(cur.expr);
}

function skipComment(cur: SedScriptCursor): void {
  const nl = cur.expr.indexOf('\n', cur.i);
  cur.i = nl === -1 ? cur.expr.length : nl + 1;
}

function skipBlanks(cur: SedScriptCursor): void {
  while (isBlank(peek(cur))) cur.i++;
}

function peek(cur: SedScriptCursor): string | undefined {
  return cur.expr[cur.i];
}

function isBlank(value: string | undefined): boolean {
  return value === ' ' || value === '\t';
}

function isDigit(value: string | undefined): boolean {
  if (value === undefined) return false;
  const code = value.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function toJavascriptPattern(pattern: string): string {
  let result = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === '\\' && (next === '(' || next === ')' || next === '/')) {
      result += next;
      i++;
      continue;
    }
    result += char;
  }
  return result;
}

export async function runSed(ctx: SedExecutionContext): Promise<number> {
  const options = parseSedArgs(ctx.args);

  if (options.expressions.length === 0) {
    ctx.stderr.write('sed: missing expression\n');
    return 1;
  }

  // Execution state: the last regular expression any address or substitution
  // actually evaluated, shared by `//` and empty s patterns across -e chunks.
  const lastRegex: SedRegexRecord = {};
  const commands: SedCommand[] = [];
  for (const expr of options.expressions) {
    try {
      commands.push(...parseSedScript(expr));
    } catch (e) {
      if (e instanceof SedParseError) {
        ctx.stderr.write(`sed: invalid expression: ${expr}\n`);
        return 1;
      }
      throw e;
    }
  }

  // Each input line carries whether its source ended it with a newline; a
  // file boundary starts the next logical line either way (GNU manual §6.1).
  function processText(input: readonly SedLogicalLine[]): string {
    if (input.length === 0) return '';
    const lastLine = input.length - 1;
    const work = commands.map((command) => ({ command, range: { open: false } }));
    const output: string[] = [];
    let pendingNewline = false;

    const emit = (text: string, index: number): void => {
      const source = input[index];
      if (source !== undefined && !source.terminated) {
        // Footnote 8: the missing newline waits until more output follows.
        if (pendingNewline) output.push('\n');
        output.push(text);
        pendingNewline = true;
        return;
      }
      if (pendingNewline) {
        output.push('\n');
        pendingNewline = false;
      }
      output.push(`${text}\n`);
    };

    const evalCtx: SedEvalContext = { line: '', lineNumber: 0, isLast: false, lastRegex };

    try {
    for (let li = 0; li < input.length; li++) {
      let line = input[li]?.text ?? '';
      evalCtx.lineNumber = li + 1;
      evalCtx.isLast = li === lastLine;
      let deleted = false;

      for (const entry of work) {
        // Later addresses see the pattern space as earlier commands left it.
        evalCtx.line = line;
        if (!selects(entry.command, entry.range, evalCtx)) continue;
        const command = entry.command;
        if (command.type === 'p') {
          emit(line, li);
        } else if (command.type === 'd') {
          deleted = true;
          break;
        } else if (command.type === 's' && command.replacement !== undefined) {
          let regex: RegExp | undefined = command.pattern;
          if (command.emptyPattern) {
            if (!lastRegex.source) throw new SedRuntimeError();
            // Match flags come from the repeated expression; only action
            // flags such as g come from this substitution.
            let flags = lastRegex.flags ?? '';
            if (command.global && !flags.includes('g')) flags += 'g';
            regex = new RegExp(lastRegex.source, flags);
          }
          if (!regex) continue;
          let changed = false;
          regex.lastIndex = 0;
          line = line.replace(regex, (...match) => {
            changed = true;
            return expandReplacement(command.replacement ?? '', match.slice(1, -2), String(match[0]));
          });
          if (!command.emptyPattern) {
            lastRegex.source = regex.source;
            // Only match modifiers repeat with an empty pattern; g is an
            // action flag of the substitution that used the expression.
            lastRegex.flags = command.insensitive ? 'i' : '';
          }
          if (changed && command.print) emit(line, li);
        }
      }

      if (!deleted && !options.quiet) emit(line, li);
    }
    } catch (e) {
      // Output already emitted stays written; only the failing cycle is lost.
      if (e instanceof SedRuntimeError) throw new SedRuntimeError(output.join(''));
      throw e;
    }

    return output.join('');
  }

  try {
    if (options.files.length === 0) {
      if (ctx.stdin) {
        const text = await ctx.stdin.readAll();
        ctx.stdout.write(processText(toLogicalLines(text)));
      } else {
        ctx.stderr.write('sed: missing file operand\n');
        return 1;
      }
      return 0;
    }

    let exitCode = 0;
    const stream: string[] = [];
    for (const file of options.files) {
      const path = resolve(ctx.cwd, file);
      try {
        ctx.vfs.stat(path);
        if (isBinaryMime(getMimeType(path))) {
          ctx.stderr.write(`sed: ${file}: binary file, skipping\n`);
          continue;
        }
        const content = ctx.vfs.readFileString(path);
        if (options.inPlace) {
          ctx.vfs.writeFile(path, processText(toLogicalLines(content)));
        } else {
          stream.push(content);
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
    if (!options.inPlace) {
      const lines = stream.flatMap((text) => toLogicalLines(text));
      ctx.stdout.write(processText(lines));
    }

    return exitCode;
  } catch (e) {
    if (e instanceof SedRuntimeError) {
      // In-place runs write files, not stdout: partial output stays unwritten.
      if (!options.inPlace) ctx.stdout.write(e.partialOutput);
      ctx.stderr.write(`sed: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

function selects(command: SedCommand, range: { open: boolean }, ctx: SedEvalContext): boolean {
  const address = command.address;
  let selected: boolean;
  if (!address) {
    selected = true;
  } else if (address.kind === 'range') {
    selected = rangeSelects(address, range, ctx);
  } else {
    selected = addressSelects(address, ctx);
  }
  return command.negate ? !selected : selected;
}

function addressSelects(address: SedAddress, ctx: SedEvalContext): boolean {
  switch (address.kind) {
    case 'line':
      return ctx.lineNumber === address.value;
    case 'last':
      return ctx.isLast;
    case 'empty': {
      // `//` reads the record without writing it; nothing may establish one.
      if (!ctx.lastRegex.source) throw new SedRuntimeError();
      return new RegExp(ctx.lastRegex.source, ctx.lastRegex.flags ?? '').test(ctx.line);
    }
    case 'regex': {
      const matched = address.regex.test(ctx.line);
      ctx.lastRegex.source = address.regex.source;
      ctx.lastRegex.flags = address.regex.flags;
      return matched;
    }
  }
}

function rangeSelects(
  range: SedRange,
  state: { open: boolean },
  ctx: SedEvalContext,
): boolean {
  if (!state.open) {
    if (!addressSelects(range.start, ctx)) return false;
    // A numeric end at or before the start line leaves the range one line wide.
    state.open = !(range.end.kind === 'line' && range.end.value <= ctx.lineNumber);
    return true;
  }
  // A regular-expression end is first tested on the line after the range opens.
  const closes = range.end.kind === 'line'
    ? ctx.lineNumber >= range.end.value
    : range.end.kind === 'last'
      ? ctx.isLast
      : addressSelects(range.end, ctx);
  if (closes) state.open = false;
  return true;
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
