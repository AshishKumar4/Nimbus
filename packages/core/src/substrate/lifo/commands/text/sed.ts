import type { Command, CommandInputStream, CommandOutputStream } from '../types.js';
import { resolve } from '../../utils/path.js';
import { decodeLossless, encodeLossless, fsErrorText, readAllInput, writeBytes } from '../../utils/bytes-io.js';
import { PosixRegexSyntax, translate } from '../../utils/posix-regex.js';
import type { ProcessView } from '../../../../runtime/process-files.js';

// GNU sed 4.9, on bytes (text is held losslessly, bytes-io.ts: an invalid
// byte goes out as it came in). Every command but `e` (a sed script here
// does not start processes): { } = a b c d D F g G h H i l n N p P q Q r R
// s t T v w W x y z : #, with GNU's addresses (N, $, /re/ and \cREc with
// I and M, first~step, 0,/re/, addr,+N, addr,~N, !), s flags g p N i I m M w,
// replacement case conversion (\L \U \l \u \E), and -n -e -f -E/-r -s
// -i[SUFFIX] -z -l N.

type SedVfs = {
  stat(path: string): unknown;
  readFile(path: string): Uint8Array | Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): void | Promise<void>;
};

export type SedExecutionContext = {
  args: string[];
  cwd: string;
  vfs: SedVfs;
  stdout: CommandOutputStream;
  stderr: CommandOutputStream;
  stdin?: string | CommandInputStream;
};

class SedScriptError extends Error {}

// ── script ──

type Address =
  | { kind: 'line'; n: number }
  | { kind: 'last' }
  | { kind: 'step'; first: number; step: number }
  | { kind: 'regex'; re: RegExp | null }
  | { kind: 'zero' };

type EndAddress = Address | { kind: 'plus'; n: number } | { kind: 'multiple'; n: number };

interface Replacement {
  parts: ({ text: string } | { group: number } | { caseOp: 'L' | 'U' | 'E' | 'l' | 'u' })[];
}

type Cmd = {
  a1?: Address;
  a2?: EndAddress;
  negate: boolean;
  /** Range state. */
  active: boolean;
  endLine: number;
} & (
  | { name: '{'; end: number }
  | { name: '}' }
  | { name: '=' | 'd' | 'D' | 'F' | 'g' | 'G' | 'h' | 'H' | 'n' | 'N' | 'p' | 'P' | 'x' | 'z' }
  | { name: 'a' | 'i' | 'c'; text: string }
  | { name: 'b' | 't' | 'T'; label: string; target: number }
  | { name: ':'; label: string }
  | { name: 'l'; width: number | null }
  | { name: 'q' | 'Q'; code: number }
  | { name: 'r' | 'R' | 'w' | 'W'; file: string }
  | { name: 's'; re: RegExp | null; flags: string; replacement: Replacement; global: boolean; nth: number; print: number; write: string | null }
  | { name: 'y'; map: Map<string, string> }
);

class Parser {
  i = 0;
  readonly cmds: Cmd[] = [];

  constructor(private readonly src: string, private readonly extended: boolean, private readonly where: string) {}

  fail(message: string): never {
    throw new SedScriptError(`${this.where}, char ${Math.min(this.i, this.src.length)}: ${message}`);
  }

  private peek(): string | undefined { return this.src[this.i]; }
  private next(): string | undefined { return this.src[this.i++]; }
  private skipBlanks(): void { while (this.peek() === ' ' || this.peek() === '\t') this.i++; }
  private skipSpace(): void { while (this.peek() !== undefined && /\s/.test(this.peek()!)) this.i++; }

  parse(): Cmd[] {
    for (;;) {
      this.skipSpace();
      while (this.peek() === ';') { this.i++; this.skipSpace(); }
      if (this.peek() === undefined) break;
      if (this.peek() === '#') {
        while (this.peek() !== undefined && this.peek() !== '\n') this.i++;
        continue;
      }
      this.command();
    }
    return this.cmds;
  }

  private number(): number {
    const m = /^\d+/.exec(this.src.slice(this.i));
    this.i += m![0].length;
    return Number(m![0]);
  }

  private address(): Address | undefined {
    const c = this.peek();
    if (c === undefined) return undefined;
    if (/\d/.test(c)) {
      const n = this.number();
      if (this.peek() === '~') {
        this.i++;
        const step = /\d/.test(this.peek() ?? '') ? this.number() : 0;
        return { kind: 'step', first: n, step };
      }
      return n === 0 ? { kind: 'zero' } : { kind: 'line', n };
    }
    if (c === '$') { this.i++; return { kind: 'last' }; }
    if (c === '/' || c === '\\') {
      this.i++;
      let delim = '/';
      if (c === '\\') {
        delim = this.next() ?? '';
        if (delim === '' || delim === '\n' || delim === '\\') this.fail('unexpected `,\'');
      }
      const source = this.delimited(delim, 'unterminated address regex');
      let flags = '';
      for (;;) {
        if (this.peek() === 'I') { flags += 'i'; this.i++; }
        else if (this.peek() === 'M') { flags += 'm'; this.i++; }
        else break;
      }
      return { kind: 'regex', re: this.regex(source, flags) };
    }
    return undefined;
  }

  /** Text up to an unescaped `delim`; `\delim` becomes `delim`, `\n` a newline when delim isn't n. */
  private delimited(delim: string, unterminated: string, regex = true): string {
    let out = '';
    for (;;) {
      const c = this.next();
      if (c === undefined) this.fail(unterminated);
      if (c === delim) return out;
      if (c === '\n' && regex) this.fail(unterminated);
      if (c === '\\') {
        const n = this.next();
        if (n === undefined) this.fail(unterminated);
        // An escaped delimiter is the plain character (in an ERE, `|` is alternation again, as in GNU).
        if (n === delim) out += delim;
        else if (n === '\n') out += regex ? '\\n' : '\n';
        else out += '\\' + n;
        continue;
      }
      // A bracket expression is read whole: the delimiter inside it is literal.
      if (c === '[' && regex) {
        out += c;
        let j = this.i;
        if (this.src[j] === '^') j++;
        if (this.src[j] === ']') j++;
        while (j < this.src.length && this.src[j] !== ']') {
          if (this.src[j] === '[' && /[:.=]/.test(this.src[j + 1] ?? '')) {
            const close = this.src.indexOf(this.src[j + 1] + ']', j + 2);
            j = close === -1 ? this.src.length : close + 2;
          } else j++;
        }
        if (j >= this.src.length) { out += this.src.slice(this.i); this.i = this.src.length; continue; }
        out += this.src.slice(this.i, j + 1);
        this.i = j + 1;
        continue;
      }
      out += c;
    }
  }

  private regex(source: string, flags: string): RegExp | null {
    if (source === '') return null;
    try {
      return new RegExp(translate(source, { extended: this.extended, sed: true }), `u${flags}`);
    } catch (error) {
      if (error instanceof PosixRegexSyntax) this.fail(error.message);
      this.fail('Invalid regular expression');
    }
  }

  private endOfCommand(): void {
    this.skipBlanks();
    const c = this.peek();
    if (c === undefined || c === '\n' || c === ';') { if (c !== undefined) this.i++; return; }
    if (c === '}' || c === '#') return;
    this.i++;
    this.fail(`extra characters after command`);
  }

  private labelText(): string {
    this.skipBlanks();
    let out = '';
    while (this.peek() !== undefined && this.peek() !== '\n' && this.peek() !== ';') out += this.next();
    if (this.peek() !== undefined) this.i++;
    return out.replace(/[ \t]+$/, '');
  }

  private filename(): string {
    this.skipBlanks();
    let out = '';
    while (this.peek() !== undefined && this.peek() !== '\n') out += this.next();
    if (this.peek() === '\n') this.i++;
    return out;
  }

  /** a/i/c text: the one-line form `a text`, or `a\` followed by lines ending in `\`. */
  private text(): string {
    this.skipBlanks();
    if (this.peek() === '\\') {
      this.i++;
      this.skipBlanks();
      if (this.peek() === '\n') this.i++;
    }
    let out = '';
    for (;;) {
      const c = this.next();
      if (c === undefined || c === '\n') break;
      if (c === '\\') {
        const n = this.next();
        if (n === undefined) break;
        out += n;
        continue;
      }
      out += c;
    }
    return out;
  }

  private command(): void {
    const start = this.i;
    const a1 = this.address();
    let a2: EndAddress | undefined;
    if (a1 !== undefined) {
      this.skipBlanks();
      if (this.peek() === ',') {
        this.i++;
        this.skipBlanks();
        const c = this.peek();
        if (c === '+' || c === '~') {
          this.i++;
          if (!/\d/.test(this.peek() ?? '')) this.fail('expected newer version of sed');
          const n = this.number();
          a2 = c === '+' ? { kind: 'plus', n } : { kind: 'multiple', n };
        } else {
          a2 = this.address();
          if (a2 === undefined) this.fail('unexpected `,\'');
          if (a2.kind === 'zero') this.fail('invalid usage of line address 0');
        }
      }
    }
    this.skipBlanks();
    let negate = false;
    if (this.peek() === '!') {
      negate = true;
      this.i++;
      this.skipBlanks();
      if (this.peek() === '!') { this.i++; this.fail("multiple `!'s"); }
    }
    const name = this.next();
    if (name === undefined) this.fail('missing command');
    if (a1?.kind === 'zero' && (a2 === undefined || a2.kind !== 'regex')) this.fail('invalid usage of line address 0');
    const base = { a1, a2, negate, active: false, endLine: 0 };
    const push = (cmd: Record<string, unknown>) => this.cmds.push({ ...base, ...cmd } as Cmd);
    const noAddr = (what: string) => { if (a1 !== undefined) { this.i = start + 1; this.fail(`${what} doesn't want any addresses`); } };
    switch (name) {
      case '{':
        push({ name: '{', end: -1 });
        return;
      case '}':
        noAddr('}');
        push({ name: '}', at: this.i, where: this.where });
        this.endOfCommand();
        return;
      case '=': case 'd': case 'D': case 'F': case 'g': case 'G': case 'h': case 'H':
      case 'n': case 'N': case 'p': case 'P': case 'x': case 'z':
        push({ name });
        this.endOfCommand();
        return;
      case 'a': case 'i': case 'c':
        push({ name, text: this.text() });
        return;
      case ':': {
        noAddr(':');
        const label = this.labelText();
        if (label === '') this.fail('":" lacks a label');
        push({ name, label });
        return;
      }
      case 'b': case 't': case 'T':
        push({ name, label: this.labelText(), target: -1 });
        return;
      case 'l': case 'L': {
        this.skipBlanks();
        const width = /\d/.test(this.peek() ?? '') ? this.number() : null;
        push({ name: 'l', width });
        this.endOfCommand();
        return;
      }
      case 'q': case 'Q': {
        this.skipBlanks();
        const code = /\d/.test(this.peek() ?? '') ? this.number() : 0;
        push({ name, code });
        this.endOfCommand();
        return;
      }
      case 'r': case 'R': case 'w': case 'W':
        push({ name, file: this.filename() });
        return;
      case 's': {
        const delim = this.next();
        if (delim === undefined || delim === '\n' || delim === '\\') this.fail('unterminated `s\' command');
        const pattern = this.delimited(delim, 'unterminated `s\' command');
        const replacement = this.replacement(delim);
        let flags = '', global = false, nth = 1, print = 0, write: string | null = null, nthSet = false;
        for (;;) {
          this.skipBlanks();
          const f = this.peek();
          if (f === 'g') { global = true; this.i++; }
          else if (f === 'p') { print++; this.i++; }
          else if (f === 'i' || f === 'I') { flags += 'i'; this.i++; }
          else if (f === 'm' || f === 'M') { flags += 'm'; this.i++; }
          else if (f === 'e') { this.i++; this.fail('e command is not supported'); }
          else if (f !== undefined && /\d/.test(f)) {
            if (nthSet) this.fail('multiple number options to `s\' command');
            nth = this.number();
            nthSet = true;
            if (nth === 0) this.fail('number option to `s\' command may not be zero');
          } else if (f === 'w') { this.i++; write = this.filename(); break; }
          else break;
        }
        if (write === null) {
          this.skipBlanks();
          const c = this.peek();
          if (c !== undefined && c !== '\n' && c !== ';' && c !== '}' && c !== '#') { this.i++; this.fail('unknown option to `s\''); }
          this.endOfCommand();
        }
        push({ name: 's', re: this.regex(pattern, flags), flags, replacement, global, nth, print, write });
        return;
      }
      case 'y': {
        const delim = this.next();
        if (delim === undefined || delim === '\n' || delim === '\\') this.fail('unterminated `y\' command');
        const unescape = (s: string) => [...s.replace(/\\(.)/gsu, (_, c: string) => (c === 'n' ? '\n' : c === '\\' ? '\\' : c))];
        const from = unescape(this.delimited(delim, 'unterminated `y\' command', false));
        const to = unescape(this.delimited(delim, 'unterminated `y\' command', false));
        if (from.length !== to.length) this.fail('strings for `y\' command are different lengths');
        const map = new Map<string, string>();
        from.forEach((c, k) => map.set(c, to[k]));
        push({ name: 'y', map });
        this.endOfCommand();
        return;
      }
      case 'v':
        this.labelText();
        return;
      case 'e':
        this.fail('e command is not supported');
        // falls through
      default:
        this.fail(`unknown command: \`${name}'`);
    }
  }

  private replacement(delim: string): Replacement {
    const parts: Replacement['parts'] = [];
    let text = '';
    const flush = () => { if (text !== '') { parts.push({ text }); text = ''; } };
    for (;;) {
      const c = this.next();
      if (c === undefined) this.fail('unterminated `s\' command');
      if (c === delim) break;
      if (c === '&') { flush(); parts.push({ group: 0 }); continue; }
      if (c === '\\') {
        const n = this.next();
        if (n === undefined) this.fail('unterminated `s\' command');
        if (/\d/.test(n)) { flush(); parts.push({ group: Number(n) }); continue; }
        if ('LUElu'.includes(n)) { flush(); parts.push({ caseOp: n as 'L' | 'U' | 'E' | 'l' | 'u' }); continue; }
        if (n === 'n') { text += '\n'; continue; }
        if (n === 't') { text += '\t'; continue; }
        if (n === '\n') { text += '\n'; continue; }
        text += n;
        continue;
      }
      text += c;
    }
    flush();
    return { parts };
  }
}


// ── execution ──

interface Input { name: string; lines: string[]; terminated: boolean }

interface Line { text: string; terminated: boolean; file: string }

/** Lines of several files in order, opening each only when the one before is used up. */
class LineSource {
  private lines: Line[] = [];
  private head = 0;
  private fileIndex = 0;

  constructor(private readonly names: readonly string[], private readonly open: (name: string) => Promise<Input | null>) {}

  private async load(): Promise<boolean> {
    while (this.fileIndex < this.names.length) {
      const input = await this.open(this.names[this.fileIndex++]);
      if (input === null || input.lines.length === 0) continue;
      this.lines = input.lines.map((text, k) => ({ text, terminated: k < input.lines.length - 1 || input.terminated, file: input.name }));
      this.head = 0;
      return true;
    }
    return false;
  }

  async next(): Promise<Line | null> {
    if (this.head >= this.lines.length && !(await this.load())) return null;
    return this.lines[this.head++];
  }

  /** Whether no line follows: opens the next file to find out. */
  async atEnd(): Promise<boolean> {
    return this.head >= this.lines.length && !(await this.load());
  }

  unshift(line: Line): void {
    if (this.head > 0) this.lines[--this.head] = line;
    else { this.lines.unshift(line); }
  }
}

function splitLines(text: string, delim: string): { lines: string[]; terminated: boolean } {
  if (text === '') return { lines: [], terminated: true };
  const lines = text.split(delim);
  const terminated = lines[lines.length - 1] === '';
  if (terminated) lines.pop();
  return { lines, terminated };
}

/** `l`'s rendering of the pattern space: escapes, octal bytes, wrapped at `width`. */
function unambiguous(ps: string, width: number): string {
  const bytes = encodeLossless(ps);
  const ESC: Record<number, string> = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r', 92: '\\\\' };
  let out = '';
  let col = 0;
  for (const b of bytes) {
    const piece = ESC[b] ?? (b >= 32 && b < 127 ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, '0')}`);
    if (width > 1 && col + piece.length > width - 1) { out += '\\\n'; col = 0; }
    out += piece;
    col += piece.length;
  }
  return out + '$\n';
}

function applyCase(text: string, state: { mode: 'L' | 'U' | 'E'; once: 'l' | 'u' | null }): string {
  let out = state.mode === 'L' ? text.toLowerCase() : state.mode === 'U' ? text.toUpperCase() : text;
  if (state.once !== null && out !== '') {
    const [first, ...rest] = [...out];
    out = (state.once === 'l' ? first.toLowerCase() : first.toUpperCase()) + rest.join('');
    state.once = null;
  }
  return out;
}

function expand(replacement: Replacement, m: RegExpExecArray): string {
  const state: { mode: 'L' | 'U' | 'E'; once: 'l' | 'u' | null } = { mode: 'E', once: null };
  let out = '';
  for (const part of replacement.parts) {
    if ('caseOp' in part) {
      if (part.caseOp === 'l' || part.caseOp === 'u') state.once = part.caseOp;
      else { state.mode = part.caseOp; state.once = null; }
    } else if ('group' in part) out += applyCase(m[part.group] ?? '', state);
    else out += applyCase(part.text, state);
  }
  return out;
}

export async function runSed(ctx: SedExecutionContext): Promise<number> {
  let quiet = false, extended = false, separate = false, zero = false;
  let inPlace: string | null = null;
  let lineWidth = 70;
  const scripts: { text: string; label: string }[] = [];
  const files: string[] = [];
  let expressionCount = 0;
  const usageError = async (message: string) => {
    await ctx.stderr.write(`sed: ${message}\n`);
    return 1;
  };
  const args = ctx.args;
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') { files.push(...args.slice(i + 1)); break; }
      if (arg.startsWith('--')) {
        const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
        if (name === 'quiet' || name === 'silent') quiet = true;
        else if (name === 'regexp-extended') extended = true;
        else if (name === 'separate') separate = true;
        else if (name === 'null-data' || name === 'zero-terminated') zero = true;
        else if (name === 'in-place') { inPlace = inline ?? ''; separate = true; }
        else if (name === 'expression') scripts.push({ text: inline ?? args[++i] ?? '', label: `-e expression #${++expressionCount}` });
        else if (name === 'file') {
          const file = inline ?? args[++i] ?? '';
          scripts.push({ text: decodeLossless(await ctx.vfs.readFile(resolve(ctx.cwd, file))).replace(/\n$/, ''), label: `file ${file} line 1` });
        } else if (name === 'line-length') lineWidth = Number(inline ?? args[++i]);
        else if (['posix', 'debug', 'follow-symlinks', 'unbuffered', 'binary', 'sandbox'].includes(name)) { /* no effect here */ }
        else return usageError(`unrecognized option '--${name}'`);
        continue;
      }
      if (!arg.startsWith('-') || arg === '-') { files.push(arg); continue; }
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (flag === 'e' || flag === 'f' || flag === 'l') {
          let value: string | undefined = arg.slice(j + 1);
          if (value === '') value = args[++i];
          if (value === undefined) return usageError(`option requires an argument -- '${flag}'`);
          if (flag === 'e') scripts.push({ text: value, label: `-e expression #${++expressionCount}` });
          else if (flag === 'f') scripts.push({ text: decodeLossless(await ctx.vfs.readFile(resolve(ctx.cwd, value))).replace(/\n$/, ''), label: `file ${value} line 1` });
          else lineWidth = Number(value);
          break;
        }
        if (flag === 'i') { inPlace = arg.slice(j + 1); separate = true; break; }
        if (flag === 'n') quiet = true;
        else if (flag === 'E' || flag === 'r') extended = true;
        else if (flag === 's') separate = true;
        else if (flag === 'z') zero = true;
        else if (flag === 'u' || flag === 'b') { /* no effect here */ }
        else return usageError(`invalid option -- '${flag}'`);
      }
    }
  } catch (error) {
    await ctx.stderr.write(`sed: couldn't open file: ${fsErrorText(error)}\n`);
    return 1;
  }
  if (scripts.length === 0) {
    const first = files.shift();
    if (first === undefined) {
      await ctx.stderr.write('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n');
      return 1;
    }
    scripts.push({ text: first, label: '-e expression #1' });
  }
  if (inPlace !== null && files.length === 0) return usageError('no input files');

  // One program from every -e/-f, each parsed with its own label for errors.
  const cmds: Cmd[] = [];
  let quietFromScript = false;
  try {
    for (const [k, script] of scripts.entries()) {
      if (k === 0 && /^#n(\n|$)/.test(script.text)) quietFromScript = true;
      cmds.push(...new Parser(script.text, extended, script.label).parse());
    }
    // Block ends and labels are resolved over the whole program.
    fixBlocks(cmds, scripts[scripts.length - 1].label);
    try {
      link(cmds);
    } catch (error) {
      // A missing label is GNU's panic, status 4.
      if (error instanceof SedScriptError) { await usageError(error.message); return 4; }
      throw error;
    }
  } catch (error) {
    if (error instanceof SedScriptError) return usageError(error.message);
    throw error;
  }
  if (quietFromScript) quiet = true;

  const delim = zero ? '\0' : '\n';
  let status = 0;
  const readInput = async (file: string): Promise<Input | null> => {
    try {
      const bytes = file === '-'
        ? await readAllInput({ cwd: ctx.cwd, vfs: ctx.vfs as unknown as ProcessView, stdin: ctx.stdin }, '-')
        : await ctx.vfs.readFile(resolve(ctx.cwd, file));
      const { lines, terminated } = splitLines(decodeLossless(bytes), delim);
      return { name: file, lines, terminated };
    } catch (error) {
      await ctx.stderr.write(`sed: can't read ${file}: ${fsErrorText(error)}\n`);
      status = 2;
      return null;
    }
  };

  // Files `w` writes to are truncated when the program starts.
  const writeFiles = new Map<string, { chunks: string[]; missing: boolean }>();
  for (const cmd of cmds) {
    const file = cmd.name === 'w' || cmd.name === 'W' ? cmd.file : cmd.name === 's' ? cmd.write : null;
    if (file && file !== '/dev/stdout' && file !== '/dev/stderr') writeFiles.set(file, { chunks: [], missing: false });
  }
  const rCursors = new Map<string, { lines: string[]; at: number }>();
  let lastRegex: RegExp | null = null;
  const useRegex = (re: RegExp | null): RegExp => {
    if (re !== null) { lastRegex = re; return re; }
    if (lastRegex === null) throw new SedScriptError('no previous regular expression');
    return lastRegex;
  };

  // One stream over every file, or with -s/-i one per file. A file opens only
  // when the one before it is used up: knowing whether a line is `$` is what
  // opens the next, so at most one file's text is held.
  const names = files.length > 0 ? files : ['-'];
  const groups: string[][] = separate ? names.map((name) => [name]) : [names];

  let quitCode: number | null = null;
  let hold = '';
  let lineNo = 0;
  for (const group of groups) {
    if (quitCode !== null) break;
    const stream = new LineSource(group, readInput);
    const out: string[] = [];
    const target = inPlace !== null ? group[0] : null;
    // A line read without its newline is written without one; anything
    // written after it puts the newline back first (GNU's output_missing_newline).
    let missingNewline = false;
    const emit = (text: string) => {
      if (text === '') return;
      if (missingNewline) { out.push('\n'); missingNewline = false; }
      out.push(text);
    };
    const flushOut = async () => {
      if (target !== null) return;
      if (out.length > 0) { await writeBytes(ctx.stdout, encodeLossless(out.join(''))); out.length = 0; }
    };
    for (const cmd of cmds) { cmd.active = false; cmd.endLine = 0; }
    // With -s or -i each file numbers its own lines.
    if (separate) lineNo = 0;

    try {
      for (;;) {
        if (quitCode !== null) break;
        const read = await stream.next();
        if (read === null) break;
        let current: Line = read;
        lineNo++;
        let last = await stream.atEnd();
        let ps = current.text;
        let substituted = false;
        const append: string[] = [];
        let autoprint = !quiet;
        const isLast = () => last;
        /** A line to a `w` file, under the same missing-newline rule as standard output. */
        const writeLine = (file: string, text: string, whole: boolean) => {
          if (file === '/dev/stdout') { if (whole) emitLine(text); else emit(text + delim); return; }
          const w = writeFiles.get(file);
          if (!w) return;
          if (w.missing) { w.chunks.push('\n'); w.missing = false; }
          const terminated = !whole || current.terminated;
          w.chunks.push(text + (terminated ? delim : ''));
          w.missing = !terminated;
        };
        /** The pattern space as a line of output: its newline only if the input line had one. */
        const emitLine = (text: string) => {
          emit(text + (current.terminated ? delim : ''));
          if (!current.terminated) missingNewline = true;
        };
        const selected = (cmd: Cmd): boolean => {
          const matches = (a: Address): boolean => {
            switch (a.kind) {
              case 'line': return lineNo === a.n;
              case 'last': return isLast();
              case 'step': return a.step <= 0 ? lineNo === a.first : lineNo >= a.first && (lineNo - a.first) % a.step === 0;
              case 'regex': { const re = useRegex(a.re); re.lastIndex = 0; return re.test(ps); }
              case 'zero': return false;
            }
          };
          let hit: boolean;
          if (cmd.a1 === undefined) hit = true;
          else if (cmd.a2 === undefined) hit = matches(cmd.a1);
          else if (cmd.active) {
            hit = true;
            const end = cmd.a2;
            if (end.kind === 'line' || end.kind === 'plus' || end.kind === 'multiple') {
              if (lineNo >= cmd.endLine) cmd.active = false;
            } else if (matches(end as Address)) cmd.active = false;
          } else if (cmd.a1.kind === 'zero') {
            // 0,/re/: the range is open from before line 1, so its end can match line 1.
            hit = cmd.endLine === 0 && lineNo === 1;
            if (hit) { cmd.endLine = 1; cmd.active = !matches(cmd.a2 as Address); }
          } else if (matches(cmd.a1)) {
            hit = true;
            const end = cmd.a2;
            if (end.kind === 'line') {
              cmd.endLine = end.n;
              cmd.active = end.n > lineNo;
            } else if (end.kind === 'plus') {
              cmd.endLine = lineNo + end.n;
              cmd.active = end.n > 0;
            } else if (end.kind === 'multiple') {
              cmd.endLine = end.n <= 0 ? lineNo : Math.ceil(lineNo / end.n) * end.n;
              cmd.active = cmd.endLine > lineNo;
            } else if (end.kind === 'last') {
              cmd.active = !isLast();
            } else {
              cmd.active = true;
            }
          } else hit = false;
          return hit !== cmd.negate;
        };

        let pc = 0;
        let restart = false;
        cycle: while (pc < cmds.length) {
          const cmd = cmds[pc];
          if (!selected(cmd)) {
            pc = cmd.name === '{' ? cmd.end : pc + 1;
            continue;
          }
          pc++;
          switch (cmd.name) {
            case '{': case '}': case ':': break;
            case '=': emit(`${lineNo}\n`); break;
            case 'a': append.push(cmd.text + '\n'); break;
            case 'i': emit(cmd.text + '\n'); break;
            case 'c':
              // A range changes to the text once, at its end.
              if (cmd.a2 === undefined || !cmd.active) emit(cmd.text + '\n');
              autoprint = false;
              break cycle;
            case 'd': autoprint = false; break cycle;
            case 'D': {
              const k = ps.indexOf('\n');
              if (k === -1) { autoprint = false; break cycle; }
              ps = ps.slice(k + 1);
              autoprint = false;
              restart = true;
              break cycle;
            }
            case 'F': emit(`${current.file === '-' ? '-' : current.file}\n`); break;
            case 'g': ps = hold; break;
            case 'G': ps += '\n' + hold; break;
            case 'h': hold = ps; break;
            case 'H': hold += '\n' + ps; break;
            case 'x': [ps, hold] = [hold, ps]; break;
            case 'z': ps = ''; break;
            case 'l': emit(unambiguous(ps, cmd.width ?? lineWidth)); break;
            case 'n':
              if (isLast()) { break cycle; }
              if (!quiet) emitLine(ps);
              emit(append.splice(0).join(''));
              current = (await stream.next())!;
              last = await stream.atEnd();
              lineNo++;
              ps = current.text;
              break;
            case 'N':
              if (isLast()) { break cycle; }
              emit(append.splice(0).join(''));
              current = (await stream.next())!;
              last = await stream.atEnd();
              lineNo++;
              ps += '\n' + current.text;
              break;
            case 'p': emitLine(ps); break;
            case 'P': { const k = ps.indexOf('\n'); if (k === -1) emitLine(ps); else emit(ps.slice(0, k) + delim); break; }
            case 'q': quitCode = cmd.code; break cycle;
            case 'Q': quitCode = cmd.code; autoprint = false; break cycle;
            case 'r': {
              try { append.push(decodeLossless(await ctx.vfs.readFile(resolve(ctx.cwd, cmd.file)))); } catch { /* an unreadable file adds nothing */ }
              break;
            }
            case 'R': {
              let cursor = rCursors.get(cmd.file);
              if (!cursor) {
                let lines: string[] = [];
                try { lines = splitLines(decodeLossless(await ctx.vfs.readFile(resolve(ctx.cwd, cmd.file))), '\n').lines; } catch { /* nothing to read */ }
                rCursors.set(cmd.file, cursor = { lines, at: 0 });
              }
              if (cursor.at < cursor.lines.length) append.push(cursor.lines[cursor.at++] + '\n');
              break;
            }
            case 'w': case 'W': {
              const text = cmd.name === 'W' ? (ps.includes('\n') ? ps.slice(0, ps.indexOf('\n')) : ps) : ps;
              if (cmd.file === '/dev/stderr') await ctx.stderr.write(text + delim);
              else writeLine(cmd.file, text, cmd.name === 'w' || !ps.includes('\n'));
              break;
            }
            case 'y': ps = [...ps].map((c) => cmd.map.get(c) ?? c).join(''); break;
            case 'b': pc = cmd.target; break;
            case 't': if (substituted) { substituted = false; pc = cmd.target; } break;
            case 'T': if (!substituted) pc = cmd.target; else substituted = false; break;
            case 's': {
              const re = new RegExp(useRegex(cmd.re).source, `g${useRegex(cmd.re).flags.replace('g', '')}`);
              let result = '';
              let at = 0;
              let count = 0;
              let replaced = false;
              re.lastIndex = 0;
              let previousEnd = -1;
              for (let m = re.exec(ps); m !== null; m = re.exec(ps)) {
                // An empty match right where the last match ended is not a match (POSIX, GNU).
                if (m[0] === '' && m.index === previousEnd) {
                  const cp = ps.codePointAt(re.lastIndex);
                  re.lastIndex += cp !== undefined && cp > 0xffff ? 2 : 1;
                  if (re.lastIndex > ps.length) break;
                  continue;
                }
                previousEnd = m.index + m[0].length;
                count++;
                if (count >= cmd.nth && (count === cmd.nth || cmd.global)) {
                  result += ps.slice(at, m.index) + expand(cmd.replacement, m);
                  at = m.index + m[0].length;
                  replaced = true;
                  if (!cmd.global) break;
                }
                if (m[0] === '') {
                  // An empty match moves on by one character (a whole surrogate pair).
                  const cp = ps.codePointAt(re.lastIndex);
                  re.lastIndex += cp !== undefined && cp > 0xffff ? 2 : 1;
                  if (re.lastIndex > ps.length) break;
                }
              }
              if (replaced) {
                ps = result + ps.slice(at);
                substituted = true;
                for (let k = 0; k < cmd.print; k++) emitLine(ps);
                if (cmd.write !== null) {
                  if (cmd.write === '/dev/stderr') await ctx.stderr.write(ps + delim);
                  else writeLine(cmd.write, ps, true);
                }
              }
              break;
            }
          }
        }
        if (autoprint) emitLine(ps);
        emit(append.join(''));
        if (restart) {
          // D: the rest of the pattern space starts the next cycle, no line read.
          stream.unshift({ text: ps, terminated: current.terminated, file: current.file });
          lineNo--;
        }
        // Each cycle's output leaves when it is decided.
        await flushOut();
      }
    } catch (error) {
      if (error instanceof SedScriptError) {
        await flushOut();
        await ctx.stderr.write(`sed: ${error.message}\n`);
        return 1;
      }
      throw error;
    }
    if (target !== null && target !== undefined) {
      const path = resolve(ctx.cwd, target);
      if (inPlace) {
        const base = target.slice(target.lastIndexOf('/') + 1);
        const backup = inPlace.includes('*') ? inPlace.replaceAll('*', base) : target + inPlace;
        try { await ctx.vfs.writeFile(resolve(ctx.cwd, backup.includes('/') ? backup : target.slice(0, target.lastIndexOf('/') + 1) + backup), await ctx.vfs.readFile(path)); }
        catch (error) { await ctx.stderr.write(`sed: couldn't open file ${backup}: ${fsErrorText(error)}\n`); return 4; }
      }
      await ctx.vfs.writeFile(path, encodeLossless(out.join('')));
      out.length = 0;
    }
    await flushOut();
  }
  for (const [file, w] of writeFiles) {
    try { await ctx.vfs.writeFile(resolve(ctx.cwd, file), encodeLossless(w.chunks.join(''))); }
    catch (error) { await ctx.stderr.write(`sed: couldn't open file ${file}: ${fsErrorText(error)}\n`); status = 4; }
  }
  return quitCode ?? status;
}

/** Resolve every b/t/T to its label's index (no label: the end of the script). */
function link(cmds: Cmd[]): void {
  const labels = new Map<string, number>();
  cmds.forEach((cmd, k) => { if (cmd.name === ':') labels.set(cmd.label, k); });
  for (const cmd of cmds) {
    if (cmd.name !== 'b' && cmd.name !== 't' && cmd.name !== 'T') continue;
    if (cmd.label === '') { cmd.target = cmds.length; continue; }
    const target = labels.get(cmd.label);
    if (target === undefined) throw new SedScriptError(`can't find label for jump to \`${cmd.label}'`);
    cmd.target = target;
  }
}

/** Each `{`'s end, the index just past its matching `}`, over the whole program. */
function fixBlocks(cmds: Cmd[], label: string): void {
  const open: number[] = [];
  cmds.forEach((cmd, k) => {
    if (cmd.name === '{') open.push(k);
    else if (cmd.name === '}') {
      const o = open.pop();
      if (o === undefined) {
        const at = cmd as unknown as { at: number; where: string };
        throw new SedScriptError(`${at.where}, char ${at.at}: unexpected \`}'`);
      }
      (cmds[o] as { end: number }).end = k + 1;
    }
  });
  if (open.length > 0) throw new SedScriptError(`${label}, char 0: unmatched \`{'`);
}

const command: Command = async (ctx) => (await runSed(ctx));

export default command;
