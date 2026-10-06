import type { Command, CommandContext } from '../types.js';
import { getopt, type GetoptSpec } from '../../utils/args.js';
import { concatBytes, readAllInput, writeBytes } from '../../utils/bytes-io.js';
import { basename, resolve } from '../../utils/path.js';
import { strerror } from '../../../../vfs/vfs-error.js';
import { shellEscape } from '../../../../_shared/shell-quote.js';
import { blankLine, compareTexts, diffText, type DiffChange, type DiffOptions, type DiffText } from './diff-analysis.js';

// GNU diffutils 3.12's options, every one, so a bad one is refused as getopt
// refuses it; those this diff does not implement are refused by name.
const DIFF_OPTIONS: GetoptSpec = {
  short: '0123456789abBcC:dD:eEfF:hHiI:lL:nNpPqrsS:tTuU:vwW:x:X:yZ',
  long: Object.fromEntries(([
    ['binary', 'binary', 'none'], ['brief', 'q', 'none'], ['changed-group-format', 'changed-group-format', 'required'],
    ['color', 'color', 'optional'], ['context', 'C', 'optional'], ['ed', 'e', 'none'], ['exclude', 'x', 'required'],
    ['exclude-from', 'X', 'required'], ['expand-tabs', 't', 'none'], ['forward-ed', 'f', 'none'],
    ['from-file', 'from-file', 'required'], ['help', 'help', 'none'], ['horizon-lines', 'horizon-lines', 'required'],
    ['ifdef', 'D', 'required'], ['ignore-all-space', 'w', 'none'], ['ignore-blank-lines', 'B', 'none'],
    ['ignore-case', 'i', 'none'], ['ignore-file-name-case', 'ignore-file-name-case', 'none'],
    ['ignore-matching-lines', 'I', 'required'], ['ignore-space-change', 'b', 'none'], ['ignore-tab-expansion', 'E', 'none'],
    ['ignore-trailing-space', 'Z', 'none'], ['inhibit-hunk-merge', 'inhibit-hunk-merge', 'none'], ['initial-tab', 'T', 'none'],
    ['label', 'L', 'required'], ['left-column', 'left-column', 'none'], ['line-format', 'line-format', 'required'],
    ['minimal', 'd', 'none'], ['new-file', 'N', 'none'], ['new-group-format', 'new-group-format', 'required'],
    ['new-line-format', 'new-line-format', 'required'], ['no-dereference', 'no-dereference', 'none'],
    ['no-ignore-file-name-case', 'no-ignore-file-name-case', 'none'], ['normal', 'normal', 'none'],
    ['old-group-format', 'old-group-format', 'required'], ['old-line-format', 'old-line-format', 'required'],
    ['paginate', 'l', 'none'], ['palette', 'palette', 'required'], ['rcs', 'n', 'none'], ['recursive', 'r', 'none'],
    ['report-identical-files', 's', 'none'], ['sdiff-merge-assist', 'sdiff-merge-assist', 'none'],
    ['show-c-function', 'p', 'none'], ['show-function-line', 'F', 'required'], ['side-by-side', 'y', 'none'],
    ['speed-large-files', 'H', 'none'], ['starting-file', 'S', 'required'], ['strip-trailing-cr', 'strip-trailing-cr', 'none'],
    ['suppress-blank-empty', 'suppress-blank-empty', 'none'], ['suppress-common-lines', 'suppress-common-lines', 'none'],
    ['tabsize', 'tabsize', 'required'], ['text', 'a', 'none'], ['to-file', 'to-file', 'required'],
    ['unchanged-group-format', 'unchanged-group-format', 'required'], ['unchanged-line-format', 'unchanged-line-format', 'required'],
    ['unidirectional-new-file', 'P', 'none'], ['unified', 'U', 'optional'], ['version', 'v', 'none'], ['width', 'W', 'required'],
  ] as const).map(([name, key, argument]) => [name, [key, argument]])),
};

const USAGE = `Usage: diff [OPTION]... FILE1 FILE2
Compare FILES line by line, as GNU diff does; these options are implemented:
  -q, --brief                   report only when files differ
  -s, --report-identical-files  report when two files are the same
  -u, -U NUM, --unified[=NUM]   output NUM (default 3) lines of unified context
      --normal                  output a normal diff (the default)
  -L, --label LABEL             use LABEL instead of file name and timestamp
  -i, --ignore-case             ignore case differences in file contents
  -b, --ignore-space-change     ignore changes in the amount of white space
  -w, --ignore-all-space        ignore all white space
  -B, --ignore-blank-lines      ignore changes where lines are all blank
  -a, --text                    treat all files as text
  -d, --minimal                 try hard to find a smaller set of changes
`;

interface Settings {
  style: 'normal' | 'unified';
  /** -B: changes of blank lines alone are not differences. */
  ignoreBlankLines: boolean;
  context: number;
  brief: boolean;
  reportIdentical: boolean;
  text: boolean;
  labels: string[];
  analysis: DiffOptions;
}

/** A name in a diagnostic, as GNU quotes an operand: ‘name’. */
const quote = (name: string) => `\u2018${name}\u2019`;

/** A name in a unified header, as gnulib's c_maybe quoting writes it (c quoting when it has a space). */
function headerName(name: string): string {
  let escaped = '';
  let needsQuotes = name.includes(' ');
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    const simple = ({ '"': '\\"', '\\': '\\\\', '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v' } as Record<string, string>)[ch];
    if (simple) { escaped += simple; needsQuotes = true; }
    else if (code < 0x20 || code === 0x7f) { escaped += `\\${code.toString(8).padStart(3, '0')}`; needsQuotes = true; }
    else escaped += ch;
  }
  return needsQuotes ? `"${escaped}"` : name;
}

/** An mtime as GNU's `%Y-%m-%d %H:%M:%S.%N %z`, in local time. */
function headerTime(mtimeMs: number): string {
  const date = new Date(mtimeMs);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const offset = -date.getTimezoneOffset();
  const zone = `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`;
  const nanos = Math.round((((mtimeMs % 1000) + 1000) % 1000) * 1e6);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(nanos, 9)} ${zone}`;
}

const encoder = new TextEncoder();
const NO_NEWLINE = encoder.encode('\\ No newline at end of file\n');

/** Output assembled from pieces: text, and lines as views of their files' bytes. */
class Output {
  private readonly pieces: Uint8Array[] = [];

  text(text: string): void {
    this.pieces.push(encoder.encode(text));
  }

  /** Line `i` of `text` after `flag`, and GNU's note when it has no newline. */
  line(flag: Uint8Array, text: DiffText, i: number): void {
    this.pieces.push(flag, text.buffer.subarray(text.lineStart[i], text.lineStart[i + 1]));
    if (i === text.lineCount - 1 && text.missingNewline) this.pieces.push(NO_NEWLINE);
  }

  bytes(): Uint8Array {
    return concatBytes(this.pieces);
  }
}

const [LESS, MORE, CONTEXT, MINUS, PLUS] = ['< ', '> ', ' ', '-', '+'].map((flag) => encoder.encode(flag));

/** GNU's normal format: each change its own hunk, `NcM`/`NaM`/`NdM` over `<`, `---`, `>` lines. */
function normalOutput(script: readonly DiffChange[], a: DiffText, b: DiffText, ignorable: (change: DiffChange) => boolean): Uint8Array {
  const out = new Output();
  // print_number_range: a range of one line is that line; of none, the line before.
  const range = (first: number, last: number) => (last > first ? `${first + 1},${last + 1}` : `${last + 1}`);
  for (const change of script) {
    if (ignorable(change)) continue;
    const letter = change.deleted && change.inserted ? 'c' : change.deleted ? 'd' : 'a';
    out.text(`${range(change.line0, change.line0 + change.deleted - 1)}${letter}${range(change.line1, change.line1 + change.inserted - 1)}\n`);
    for (let i = 0; i < change.deleted; i++) out.line(LESS, a, change.line0 + i);
    if (letter === 'c') out.text('---\n');
    for (let i = 0; i < change.inserted; i++) out.line(MORE, b, change.line1 + i);
  }
  return out.bytes();
}

/**
 * GNU's unified format: changes closer than 2×context+1 unchanged lines
 * share a hunk (closer than `context` before an ignorable one), which shows
 * `context` lines around them, unless every change in it is ignorable; the
 * header range of one line is its number, of none the line before and `,0`.
 */
function unifiedOutput(
  script: readonly DiffChange[],
  a: DiffText,
  b: DiffText,
  context: number,
  header: [string, string],
  ignorable: (change: DiffChange) => boolean,
): Uint8Array {
  const out = new Output();
  const range = (first: number, last: number) => {
    const from = first + 1;
    const to = last + 1;
    return to <= from ? (to < from ? `${to},0` : `${to}`) : `${from},${to - from + 1}`;
  };
  out.text(`--- ${header[0]}\n+++ ${header[1]}\n`);
  for (let at = 0; at < script.length;) {
    let end = at;
    while (end + 1 < script.length
      && script[end + 1].line0 - (script[end].line0 + script[end].deleted) < (ignorable(script[end + 1]) ? context : 2 * context + 1)) end++;
    const hunk = script.slice(at, end + 1);
    at = end + 1;
    if (hunk.every(ignorable)) continue;
    const last = hunk[hunk.length - 1];
    const first0 = Math.max(hunk[0].line0 - context, 0);
    const first1 = Math.max(hunk[0].line1 - context, 0);
    const last0 = Math.min(last.line0 + last.deleted - 1 + context, a.lineCount - 1);
    const last1 = Math.min(last.line1 + last.inserted - 1 + context, b.lineCount - 1);
    out.text(`@@ -${range(first0, last0)} +${range(first1, last1)} @@\n`);
    let i = first0;
    let j = first1;
    let next = 0;
    while (i <= last0 || j <= last1) {
      const change = hunk[next];
      if (!change || i < change.line0) {
        out.line(CONTEXT, a, i++);
        j++;
      } else {
        for (let k = 0; k < change.deleted; k++) out.line(MINUS, a, i++);
        for (let k = 0; k < change.inserted; k++) out.line(PLUS, b, j++);
        next++;
      }
    }
  }
  return out.bytes();
}

type Parsed =
  | { readonly operands: readonly [string, string]; readonly settings: Settings }
  | { readonly usage: string }
  | { readonly fatal: string }
  | { readonly help: true };

function parseSettings(args: readonly string[]): Parsed {
  const settings: Settings = {
    style: 'normal', ignoreBlankLines: false, context: 0, brief: false, reportIdentical: false, text: false, labels: [],
    analysis: { ignoreCase: false, whiteSpace: 'none', minimal: false, horizon: 0 },
  };
  const analysis = { ...settings.analysis };
  const operands: string[] = [];
  let ocontext = -1;
  let explicitContext = false;
  let previousDigit = false;
  for (const event of getopt(args, DIFF_OPTIONS)) {
    if (event.kind === 'error') return { usage: event.message };
    if (event.kind === 'operand') { operands.push(event.value); previousDigit = false; continue; }
    const { key, value } = event;
    const digit = /^[0-9]$/.test(key);
    if (digit) ocontext = (previousDigit ? ocontext * 10 : 0) + Number(key);
    previousDigit = digit;
    if (digit) continue;
    switch (key) {
      case 'a': settings.text = true; break;
      case 'b': if (analysis.whiteSpace === 'none') analysis.whiteSpace = 'change'; break;
      case 'w': analysis.whiteSpace = 'all'; break;
      case 'i': analysis.ignoreCase = true; break;
      case 'B': settings.ignoreBlankLines = true; break;
      case 'd': analysis.minimal = true; break;
      case 'q': settings.brief = true; break;
      case 's': settings.reportIdentical = true; break;
      case 'normal': settings.style = 'normal'; break;
      case 'u':
        settings.style = 'unified';
        settings.context = Math.max(settings.context, 3);
        break;
      case 'U': {
        if (value !== undefined && (!/^\s*[+-]?\d+$/.test(value) || Number(value) < 0)) return { usage: `invalid context length ${quote(value)}` };
        settings.style = 'unified';
        settings.context = Math.max(settings.context, value === undefined ? 3 : Number(value));
        explicitContext = true;
        break;
      }
      case 'L':
        if (settings.labels.length === 2) return { fatal: 'too many file label options' };
        settings.labels.push(value!);
        break;
      case 'help': return { help: true };
      default:
        return { fatal: `${key.length === 1 ? `-${key}` : `--${key}`}: option not supported` };
    }
  }
  if (ocontext >= 0 && settings.style === 'unified' && (settings.context < ocontext || (ocontext < settings.context && !explicitContext))) {
    settings.context = ocontext;
  }
  settings.analysis = { ...analysis, horizon: settings.context };
  if (operands.length < 2) return { usage: `missing operand after ${quote(operands[0] ?? 'diff')}` };
  if (operands.length > 2) return { usage: `extra operand ${quote(operands[2])}` };
  return { operands: [operands[0], operands[1]], settings };
}

/** An operand's bytes and its mtime: `-` is standard input; a directory beside a file names that file in it. */
async function readOperand(ctx: CommandContext, operand: string, other: string): Promise<{ bytes: Uint8Array; mtimeMs: number; name: string }> {
  if (operand === '-') return { bytes: await readAllInput(ctx, '-'), mtimeMs: Date.now(), name: operand };
  let name = operand;
  let stat = await ctx.vfs.stat(resolve(ctx.cwd, name));
  if (stat?.type === 'directory' && other !== '-') {
    name = `${operand.replace(/\/+$/, '')}/${basename(other)}`;
    stat = await ctx.vfs.stat(resolve(ctx.cwd, name));
  }
  return { bytes: await readAllInput(ctx, name), mtimeMs: stat?.mtimeMs ?? Date.now(), name };
}

/**
 * diff FILE1 FILE2, as GNU diffutils 3.12's: its edit script (diff-analysis),
 * in the normal or unified format; binary files (a NUL byte) compared whole;
 * status 0 when the files are the same, 1 when they differ, 2 for trouble.
 */
const command: Command = async (ctx) => {
  const parsed = parseSettings(ctx.args);
  if ('help' in parsed) { await ctx.stdout.write(USAGE); return 0; }
  if ('usage' in parsed) {
    await ctx.stderr.write(`diff: ${parsed.usage}\ndiff: Try 'diff --help' for more information.\n`);
    return 2;
  }
  if ('fatal' in parsed) { await ctx.stderr.write(`diff: ${parsed.fatal}\n`); return 2; }
  const { operands: [file1, file2], settings } = parsed;
  if ((await ctx.vfs.stat(resolve(ctx.cwd, file1)))?.type === 'directory' && (await ctx.vfs.stat(resolve(ctx.cwd, file2)))?.type === 'directory') {
    await ctx.stderr.write('diff: comparing directories: option not supported\n');
    return 2;
  }

  const inputs: { bytes: Uint8Array; mtimeMs: number; name: string }[] = [];
  for (const [operand, other] of [[file1, file2], [file2, file1]]) {
    try {
      inputs.push(await readOperand(ctx, operand, other));
    } catch (error) {
      await ctx.stderr.write(`diff: ${shellEscape(operand)}: ${strerror(error)}\n`);
      return 2;
    }
  }
  const [first, second] = inputs;
  const label = (n: 0 | 1) => settings.labels[n] ?? shellEscape(inputs[n].name);
  const same = first.bytes.length === second.bytes.length && first.bytes.every((byte, i) => byte === second.bytes[i]);
  const identical = async () => {
    if (settings.reportIdentical) await ctx.stdout.write(`Files ${label(0)} and ${label(1)} are identical\n`);
    return 0;
  };
  if (same) return await identical();

  // Binary (a NUL byte), or --brief without an option that would make unequal bytes equal: compared whole.
  const ignoring = settings.ignoreBlankLines || settings.analysis.ignoreCase || settings.analysis.whiteSpace !== 'none';
  if ((!settings.text && (first.bytes.includes(0) || second.bytes.includes(0))) || (settings.brief && !ignoring)) {
    await ctx.stdout.write(`${settings.brief ? 'Files' : 'Binary files'} ${label(0)} and ${label(1)} differ\n`);
    return 1;
  }

  const a = diffText(first.bytes);
  const b = diffText(second.bytes);
  const script = compareTexts(a, b, settings.analysis);
  // -B: a change whose every line is blank (white space too, under -b or -w) is no difference.
  const blank = (text: DiffText, line: number) => blankLine(text, line, settings.analysis.whiteSpace);
  const ignorable = (change: DiffChange) => settings.ignoreBlankLines
    && Array.from({ length: change.deleted }, (_, i) => blank(a, change.line0 + i)).every(Boolean)
    && Array.from({ length: change.inserted }, (_, i) => blank(b, change.line1 + i)).every(Boolean);
  if (script.every(ignorable)) return await identical();
  if (settings.brief) {
    await ctx.stdout.write(`Files ${label(0)} and ${label(1)} differ\n`);
    return 1;
  }
  if (settings.style === 'unified') {
    const header = (n: 0 | 1): string => settings.labels[n] ?? `${headerName(inputs[n].name)}\t${headerTime(inputs[n].mtimeMs)}`;
    await writeBytes(ctx.stdout, unifiedOutput(script, a, b, settings.context, [header(0), header(1)], ignorable));
  } else {
    await writeBytes(ctx.stdout, normalOutput(script, a, b, ignorable));
  }
  return 1;
};

export default command;
