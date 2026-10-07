import type { Command, CommandInputStream } from '../types.js';
import type { ProcessView } from '../../../../runtime/process-files.js';
import { resolve } from '../../utils/path.js';
import { concatBytes, inputChunks, readAllInput } from '../../utils/bytes-io.js';
import { globMatch as fnmatch } from '../../utils/glob.js';
import { NOT_WORD, PosixRegexSyntax, WORD, translate, literal } from '../../utils/posix-regex.js';

// GNU grep (3.12) in a UTF-8 locale. Patterns: BRE (default), ERE (-E),
// fixed strings (-F) and Perl-style (-P, as JavaScript's regex). A line is a
// byte string up to '\n' (or NUL under -z); it matches when any pattern does.
// Binary input, unless -a: from a read that holds a NUL on, nothing more is
// printed; a line with an encoding error is not printed; either way, when
// anything was held back, "binary file matches" follows on stderr.

export interface GrepContext {
  args: string[];
  cwd: string;
  vfs: ProcessView;
  stdout: { write(text: string): unknown; writeBytes?(bytes: Uint8Array): unknown };
  stderr: { write(text: string): unknown };
  stdin?: string | CommandInputStream;
}

class GrepUsage extends Error {}

const enc = new TextEncoder();
const utf8 = new TextDecoder('utf-8');
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
/** GNU's read size: a NUL anywhere in what one read brings makes that read binary. */
const BUFFER = 98304;


type Syntax = 'G' | 'E' | 'F' | 'P';

interface Matcher {
  /** Leftmost-longest match at or after `from`, or null. */
  find(line: string, from: number): { start: number; end: number } | null;
}

function compile(patterns: string[], syntax: Syntax, ignoreCase: boolean, word: boolean, whole: boolean, multiline: boolean): Matcher {
  const flags = `u${ignoreCase ? 'i' : ''}${multiline ? 's' : ''}`;
  const sources = patterns.map((p) => {
    let source = syntax === 'F' ? [...p].map((c) => literal(c)).join('') : syntax === 'P' ? p : translate(p, { extended: syntax === 'E' });
    if (whole) source = `^(?:${source})$`;
    else if (word) source = `(?<!${WORD})(?:${source})(?!${WORD})`;
    return source;
  });
  let regexes: RegExp[];
  try {
    regexes = sources.map((source) => new RegExp(source, `${flags}g`));
  } catch (error) {
    throw new PosixRegexSyntax(syntax === 'P' ? (error as Error).message : 'Invalid regular expression');
  }
  // Leftmost, then longest: JavaScript takes the first alternative that
  // matches; POSIX takes the longest, so an alternation is extended.
  const anchored = sources.map((source) => new RegExp(`^(?:${source})$`, flags));
  const alternating = sources.map((source) => source.includes('|'));
  return {
    find(line, from) {
      let best: { start: number; end: number } | null = null;
      regexes.forEach((re, k) => {
        re.lastIndex = from;
        const m = re.exec(line);
        if (m === null) return;
        let end = m.index + m[0].length;
        if (alternating[k] && syntax !== 'P') {
          for (let j = line.length; j > end; j--) {
            if (anchored[k].test(line.slice(m.index, j))) { end = j; break; }
          }
        }
        if (best === null || m.index < best.start || (m.index === best.start && end > best.end)) best = { start: m.index, end };
      });
      return best;
    },
  };
}

interface Options {
  patterns: string[] | null;
  patternFiles: string[];
  syntax: Syntax;
  ignoreCase: boolean;
  invert: boolean;
  word: boolean;
  whole: boolean;
  count: boolean;
  filesWith: boolean;
  filesWithout: boolean;
  max: number;
  onlyMatching: boolean;
  quiet: boolean;
  noMessages: boolean;
  byteOffset: boolean;
  withName: boolean | null;
  label: string;
  lineNumber: boolean;
  initialTab: boolean;
  nullName: boolean;
  after: number;
  before: number;
  contextGiven: boolean;
  groupSeparator: string | null;
  binaryFiles: 'binary' | 'text' | 'without-match';
  directories: 'read' | 'skip' | 'recurse';
  followLinks: boolean;
  include: string[];
  exclude: string[];
  excludeDir: string[];
  nullData: boolean;
  operands: string[];
}

const LONG: Readonly<Record<string, { arg: 'none' | 'required' | 'optional' }>> = {
  'extended-regexp': { arg: 'none' }, 'fixed-strings': { arg: 'none' }, 'basic-regexp': { arg: 'none' }, 'perl-regexp': { arg: 'none' },
  regexp: { arg: 'required' }, file: { arg: 'required' }, 'ignore-case': { arg: 'none' }, 'no-ignore-case': { arg: 'none' },
  'word-regexp': { arg: 'none' }, 'line-regexp': { arg: 'none' }, 'null-data': { arg: 'none' }, 'no-messages': { arg: 'none' },
  'invert-match': { arg: 'none' }, version: { arg: 'none' }, help: { arg: 'none' }, 'max-count': { arg: 'required' },
  'byte-offset': { arg: 'none' }, 'line-number': { arg: 'none' }, 'no-line-number': { arg: 'none' }, 'line-buffered': { arg: 'none' },
  'with-filename': { arg: 'none' }, 'no-filename': { arg: 'none' }, label: { arg: 'required' }, 'only-matching': { arg: 'none' },
  quiet: { arg: 'none' }, silent: { arg: 'none' }, 'binary-files': { arg: 'required' }, text: { arg: 'none' },
  directories: { arg: 'required' }, devices: { arg: 'required' }, recursive: { arg: 'none' }, 'dereference-recursive': { arg: 'none' },
  include: { arg: 'required' }, exclude: { arg: 'required' }, 'exclude-from': { arg: 'required' }, 'exclude-dir': { arg: 'required' },
  'files-without-match': { arg: 'none' }, 'files-with-matches': { arg: 'none' }, count: { arg: 'none' }, 'initial-tab': { arg: 'none' },
  null: { arg: 'none' }, 'before-context': { arg: 'required' }, 'after-context': { arg: 'required' }, context: { arg: 'required' },
  'group-separator': { arg: 'required' }, 'no-group-separator': { arg: 'none' }, color: { arg: 'optional' }, colour: { arg: 'optional' },
  binary: { arg: 'none' },
};
const SHORT_WITH_ARG = new Set(['e', 'f', 'm', 'A', 'B', 'C', 'd', 'D']);

function contextCount(value: string): number {
  if (!/^\d+$/.test(value)) throw new GrepUsage(`${value}: invalid context length argument`);
  return Number(value);
}

function parseArgs(args: string[]): Options {
  const o: Options = {
    patterns: null, patternFiles: [], syntax: 'G', ignoreCase: false, invert: false, word: false, whole: false,
    count: false, filesWith: false, filesWithout: false, max: Infinity, onlyMatching: false, quiet: false,
    noMessages: false, byteOffset: false, withName: null, label: '(standard input)', lineNumber: false,
    initialTab: false, nullName: false, after: 0, before: 0, contextGiven: false, groupSeparator: '--',
    binaryFiles: 'binary', directories: 'read', followLinks: false, include: [], exclude: [], excludeDir: [],
    nullData: false, operands: [],
  };
  let digits = '';
  const apply = (name: string, value: string | undefined): void => {
    switch (name) {
      case 'E': case 'extended-regexp': o.syntax = 'E'; break;
      case 'F': case 'fixed-strings': o.syntax = 'F'; break;
      case 'G': case 'basic-regexp': o.syntax = 'G'; break;
      case 'P': case 'perl-regexp': o.syntax = 'P'; break;
      case 'e': case 'regexp': (o.patterns ??= []).push(...value!.split('\n')); break;
      case 'f': case 'file': o.patternFiles.push(value!); (o.patterns ??= []); break;
      case 'i': case 'y': case 'ignore-case': o.ignoreCase = true; break;
      case 'no-ignore-case': o.ignoreCase = false; break;
      case 'w': case 'word-regexp': o.word = true; break;
      case 'x': case 'line-regexp': o.whole = true; break;
      case 'z': case 'null-data': o.nullData = true; break;
      case 's': case 'no-messages': o.noMessages = true; break;
      case 'v': case 'invert-match': o.invert = true; break;
      case 'm': case 'max-count': {
        if (!/^-?\d+$/.test(value!)) throw new GrepUsage(`invalid max count`);
        const n = Number(value);
        o.max = n < 0 ? Infinity : n;
        break;
      }
      case 'b': case 'byte-offset': o.byteOffset = true; break;
      case 'n': case 'line-number': o.lineNumber = true; break;
      case 'no-line-number': o.lineNumber = false; break;
      case 'H': case 'with-filename': o.withName = true; break;
      case 'h': case 'no-filename': o.withName = false; break;
      case 'label': o.label = value!; break;
      case 'o': case 'only-matching': o.onlyMatching = true; break;
      case 'q': case 'quiet': case 'silent': o.quiet = true; break;
      case 'binary-files':
        if (value !== 'binary' && value !== 'text' && value !== 'without-match') throw new GrepUsage('unknown binary-files type');
        o.binaryFiles = value;
        break;
      case 'a': case 'text': o.binaryFiles = 'text'; break;
      case 'I': o.binaryFiles = 'without-match'; break;
      case 'd': case 'directories':
        if (value !== 'read' && value !== 'skip' && value !== 'recurse') throw new GrepUsage(`invalid argument '${value}' for '--directories'`);
        o.directories = value;
        break;
      case 'D': case 'devices': break;
      case 'r': case 'recursive': o.directories = 'recurse'; o.followLinks = false; break;
      case 'R': case 'dereference-recursive': o.directories = 'recurse'; o.followLinks = true; break;
      case 'include': o.include.push(value!); break;
      case 'exclude': o.exclude.push(value!); break;
      case 'exclude-dir': o.excludeDir.push(value!); break;
      case 'L': case 'files-without-match': o.filesWithout = true; o.filesWith = false; break;
      case 'l': case 'files-with-matches': o.filesWith = true; o.filesWithout = false; break;
      case 'c': case 'count': o.count = true; break;
      case 'T': case 'initial-tab': o.initialTab = true; break;
      case 'Z': case 'null': o.nullName = true; break;
      case 'A': case 'after-context': o.after = contextCount(value!); o.contextGiven = true; break;
      case 'B': case 'before-context': o.before = contextCount(value!); o.contextGiven = true; break;
      case 'C': case 'context': o.after = o.before = contextCount(value!); o.contextGiven = true; break;
      case 'group-separator': o.groupSeparator = value!; break;
      case 'no-group-separator': o.groupSeparator = null; break;
      case 'U': case 'binary': case 'line-buffered': case 'color': case 'colour': break;
      case 'V': case 'version': case 'help': break;
      default: throw new GrepUsage(`invalid option -- '${name}'`);
    }
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { o.operands.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const given = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const names = Object.keys(LONG).filter((name) => name === given || name.startsWith(given));
      const name = names.includes(given) ? given : names.length === 1 ? names[0] : undefined;
      if (name === undefined) {
        throw new GrepUsage(names.length > 1 ? `option '--${given}' is ambiguous` : `unrecognized option '--${given}'`);
      }
      let value = eq === -1 ? undefined : arg.slice(eq + 1);
      if (LONG[name].arg === 'required' && value === undefined) {
        value = args[++i];
        if (value === undefined) throw new GrepUsage(`option '--${name}' requires an argument`);
      }
      if (LONG[name].arg === 'none' && value !== undefined) throw new GrepUsage(`option '--${name}' doesn't allow an argument`);
      apply(name, value);
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') { o.operands.push(arg); continue; }
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j];
      if (/\d/.test(flag)) {
        // -NUM is -C NUM.
        digits = '';
        while (j < arg.length && /\d/.test(arg[j])) digits += arg[j++];
        j--;
        o.after = o.before = Number(digits);
        o.contextGiven = true;
        continue;
      }
      if (SHORT_WITH_ARG.has(flag)) {
        let value: string | undefined = arg.slice(j + 1);
        if (value === '') value = args[++i];
        if (value === undefined) throw new GrepUsage(`option requires an argument -- '${flag}'`);
        apply(flag, value);
        break;
      }
      apply(flag, undefined);
    }
  }
  return o;
}

interface Source {
  /** Byte chunks of the input, in order. */
  chunks: AsyncIterable<Uint8Array>;
  name: string;
}

function hasEncodingError(bytes: Uint8Array): boolean {
  try { utf8Strict.decode(bytes); return false; } catch { return true; }
}

export async function runGrep(ctx: GrepContext): Promise<number> {
  let o: Options;
  try {
    o = parseArgs(ctx.args);
  } catch (error) {
    if (!(error instanceof GrepUsage)) throw error;
    await ctx.stderr.write(`grep: ${error.message}\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n`);
    return 2;
  }
  if (o.patterns === null) {
    const first = o.operands.shift();
    if (first === undefined) {
      await ctx.stderr.write("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n");
      return 2;
    }
    o.patterns = first.split('\n');
  }
  for (const file of o.patternFiles) {
    try {
      let bytes: Uint8Array;
      if (file === '-') {
        bytes = await readAllInput(ctx, '-');
      } else {
        bytes = await ctx.vfs.readFile(resolve(ctx.cwd, file));
      }
      const text = utf8.decode(bytes);
      if (text !== '') o.patterns.push(...text.replace(/\n$/, '').split('\n'));
    } catch (error) {
      await ctx.stderr.write(`grep: ${file}: ${errorText(error)}\n`);
      return 2;
    }
  }

  let matcher: Matcher;
  try {
    matcher = compile(o.patterns, o.syntax, o.ignoreCase, o.word, o.whole, o.nullData);
  } catch (error) {
    if (!(error instanceof PosixRegexSyntax)) throw error;
    await ctx.stderr.write(`grep: ${error.message}\n`);
    return 2;
  }
  const noPatterns = o.patterns.length === 0;
  // GNU: -v with the one empty pattern can select nothing, so no file is
  // read: nothing prints but -L's names.
  const selectsNothing = noPatterns || (o.invert && o.patterns.length === 1 && o.patterns[0] === '' && !o.word && !o.whole);

  const eol = o.nullData ? 0 : 0x0a;
  const recursive = o.directories === 'recurse';
  const noOperands = o.operands.length === 0;
  if (noOperands) o.operands.push(recursive ? '.' : '-');
  const showName = o.withName ?? (o.operands.length > 1 || recursive);
  const out: Uint8Array[] = [];
  let outBytes = 0;
  const flush = async (): Promise<void> => {
    if (out.length === 0) return;
    const bytes = concatBytes(out);
    out.length = 0;
    outBytes = 0;
    if (ctx.stdout.writeBytes) await ctx.stdout.writeBytes(bytes);
    else await ctx.stdout.write(utf8.decode(bytes));
  };
  const emit = (bytes: Uint8Array | string): void => {
    const b = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
    out.push(b);
    outBytes += b.length;
  };
  let selectedAny = false;
  let error = false;
  let stop = false;

  const errorMessage = async (text: string): Promise<void> => {
    error = true;
    if (!o.noMessages) await ctx.stderr.write(`grep: ${text}\n`);
  };

  const searchSource = async (source: Source): Promise<void> => {
    const name = source.name;
    const selects = (line: string): boolean => (noPatterns ? false : matcher.find(line, 0) !== null) !== o.invert;
    const listing = o.filesWith || o.filesWithout;
    let selected = 0;
    let lineNo = 0;
    let offset = 0;
    let binary = false;
    let lastPrinted = 0;
    let afterLeft = 0;
    let anyPrinted = false;
    const before: { bytes: Uint8Array; no: number; at: number }[] = [];
    const nameBytes = enc.encode(name);

    const head = (no: number, at: number, sep: string): void => {
      if (showName) { emit(nameBytes); emit(o.nullName ? '\0' : sep); }
      // -T right-aligns each number in at least two columns.
      const number = (n: number) => (o.initialTab ? String(n).padStart(2) : String(n));
      if (o.lineNumber) emit(`${number(no)}${sep}`);
      if (o.byteOffset) emit(`${number(at)}${sep}`);
      if (o.initialTab && (showName || o.lineNumber || o.byteOffset)) emit('\t');
    };
    const printLine = (bytes: Uint8Array, no: number, at: number, sep: string): void => {
      if (o.contextGiven && o.groupSeparator !== null && anyPrinted && no > lastPrinted + 1) emit(`${o.groupSeparator}\n`);
      head(no, at, sep);
      emit(bytes);
      emit(Uint8Array.of(eol));
      lastPrinted = no;
      anyPrinted = true;
    };
    /** A line about to be printed that binary input holds back. */
    const binaryGate = (bytes: Uint8Array): boolean => {
      if (o.binaryFiles === 'text') return false;
      if (!binary && !hasEncodingError(bytes)) return false;
      suppressed = true;
      return true;
    };

    let carry = new Uint8Array(0);
    let done = false;
    const handle = async (record: Uint8Array): Promise<void> => {
      lineNo++;
      const at = offset;
      offset += record.length + 1;
      if (done) return;
      const line = utf8.decode(record);
      const isSelected = selected < o.max && selects(line);
      if (isSelected) {
        selected++;
        selectedAny = true;
        if (o.quiet) { stop = true; done = true; return; }
        if (listing) { done = true; return; }
        if (o.count) { if (selected >= o.max) done = true; return; }
        // Under -o only the matches print, so only they are checked.
        if (!(o.onlyMatching && !binary) && binaryGate(record)) {
          // After a NUL nothing more prints: the answer is known.
          if (binary) done = true;
          else afterLeft = o.after;
          if (selected >= o.max && afterLeft === 0) done = true;
          return;
        }
        for (const b of before) if (!binaryGate(b.bytes)) printLine(b.bytes, b.no, b.at, '-');
        before.length = 0;
        if (o.onlyMatching) {
          if (!o.invert) {
            for (let from = 0; from <= line.length;) {
              const m = matcher.find(line, from);
              if (m === null) break;
              if (m.end === m.start) { from = m.start + 1; continue; }
              const text = line.slice(m.start, m.end);
              // A match over an encoding error (decoded as U+FFFD) is held back.
              if (o.binaryFiles !== 'text' && text.includes('\uFFFD') && hasEncodingError(record)) {
                suppressed = true;
                from = m.end;
                continue;
              }
              if (o.contextGiven && o.groupSeparator !== null && anyPrinted && lineNo > lastPrinted + 1) emit(`${o.groupSeparator}\n`);
              head(lineNo, at + enc.encode(line.slice(0, m.start)).length, ':');
              emit(text);
              emit(Uint8Array.of(eol));
              lastPrinted = lineNo;
              anyPrinted = true;
              from = m.end;
            }
          }
        } else {
          printLine(record, lineNo, at, ':');
        }
        afterLeft = o.after;
        if (selected >= o.max && o.after === 0) done = true;
        return;
      }
      if (listing || o.count || o.quiet) return;
      if (afterLeft > 0) {
        afterLeft--;
        if (!o.onlyMatching && !binaryGate(record)) printLine(record, lineNo, at, '-');
        if (selected >= o.max && afterLeft === 0) done = true;
        return;
      }
      if (selected >= o.max) { done = true; return; }
      if (o.before > 0 && !o.onlyMatching) {
        before.push({ bytes: record, no: lineNo, at });
        if (before.length > o.before) before.shift();
      }
      if (outBytes > BUFFER) await flush();
    };
    let suppressed = false;

    if (o.max === 0) return;
    if (selectsNothing && !noPatterns) {
      if (o.filesWithout) { emit(nameBytes); emit(o.nullName ? '\0' : '\n'); await flush(); }
      return;
    }
    for await (const chunk of source.chunks) {
      if (!o.nullData && chunk.includes(0)) {
        binary = true;
        if (o.binaryFiles === 'without-match' && lineNo === 0) return;
      }
      const data = carry.length === 0 ? chunk : concatBytes([carry, chunk]);
      let start = 0;
      for (let i = data.indexOf(eol); i !== -1; i = data.indexOf(eol, start)) {
        await handle(data.subarray(start, i));
        start = i + 1;
        if (done || stop) break;
      }
      if (done || stop) break;
      carry = data.slice(start);
    }
    if (!done && !stop && carry.length > 0) await handle(carry);
    await flush();
    if (suppressed) await ctx.stderr.write(`grep: ${name}: binary file matches\n`);
    if (o.count) {
      if (showName) { emit(nameBytes); emit(o.nullName ? '\0' : ':'); }
      emit(`${selected}\n`);
    }
    if (o.filesWith && selected > 0) { emit(nameBytes); emit(o.nullName ? '\0' : '\n'); }
    if (o.filesWithout && selected === 0) { emit(nameBytes); emit(o.nullName ? '\0' : '\n'); }
    await flush();
  };

  const excluded = (path: string, patterns: string[]): boolean => {
    const base = path.slice(path.lastIndexOf('/') + 1);
    return patterns.some((glob) => fnmatch(glob, base) || fnmatch(glob, path));
  };
  const included = (path: string): boolean => {
    if (excluded(path, o.exclude)) return false;
    if (o.include.length === 0) return true;
    const base = path.slice(path.lastIndexOf('/') + 1);
    return o.include.some((glob) => fnmatch(glob, base));
  };

  const walk = async (display: string, path: string, commandLine: boolean): Promise<void> => {
    if (stop) return;
    let stat;
    try {
      stat = await ctx.vfs.stat(path, { follow: commandLine || o.followLinks });
    } catch (e) {
      return errorMessage(`${display}: ${errorText(e)}`);
    }
    if (stat === null) return errorMessage(`${display}: No such file or directory`);
    if (stat.type === 'symlink') return;
    if (stat.type === 'directory') {
      if (!commandLine && excluded(display, o.excludeDir)) return;
      if (o.directories === 'skip') return;
      if (o.directories === 'read') return errorMessage(`${display}: Is a directory`);
      let entries;
      try {
        entries = [...await ctx.vfs.readdir(path)].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      } catch (e) {
        return errorMessage(`${display}: ${errorText(e)}`);
      }
      for (const entry of entries) {
        const childDisplay = display === '' ? entry.name : display.endsWith('/') ? display + entry.name : `${display}/${entry.name}`;
        await walk(childDisplay, `${path}/${entry.name}`, false);
        if (stop) return;
      }
      return;
    }
    if (!commandLine && !included(display)) return;
    if (commandLine && o.exclude.length > 0 && excluded(display, o.exclude)) return;
    try {
      // Streamed, a character device too: -q and -m stop reading (`grep -qz '^$' /dev/zero`).
      await searchSource({ chunks: inputChunks(ctx, path, { fileReadSize: BUFFER, slice: true }), name: display });
    } catch (e) {
      if ((e as { code?: string })?.code === 'EPIPE') throw e;
      await errorMessage(`${display}: ${errorText(e)}`);
    }
  };

  for (const operand of o.operands) {
    if (stop) break;
    if (operand === '-') {
      await searchSource({ chunks: inputChunks(ctx, '-', { readSize: BUFFER }), name: o.label });
      continue;
    }
    // `grep -r PAT` with no operand names what it finds without a "./".
    const display = noOperands && recursive ? '' : operand;
    await walk(display, resolve(ctx.cwd, operand), true);
  }
  await flush();
  if (o.quiet && selectedAny) return 0;
  if (error) return 2;
  return selectedAny ? 0 : 1;
}

function errorText(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === 'ENOENT') return 'No such file or directory';
  if (code === 'EACCES' || code === 'EPERM') return 'Permission denied';
  if (code === 'EISDIR') return 'Is a directory';
  if (code === 'ENOTDIR') return 'Not a directory';
  return error instanceof Error ? error.message : String(error);
}

const command: Command = async (ctx) => runGrep({
  args: ctx.args, cwd: ctx.cwd, vfs: ctx.vfs, stdout: ctx.stdout, stderr: ctx.stderr, stdin: ctx.stdin,
});

export default command;
