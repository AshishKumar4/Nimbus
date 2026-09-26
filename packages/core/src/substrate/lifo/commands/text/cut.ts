import type { Command, CommandContext } from '../types.js';
import { resolve } from '../../utils/path.js';

// GNU cut (coreutils 9.7), bytes in the C locale: -b and -c select bytes,
// -f fields; lists are sorted and overlapping ranges merged; --complement,
// -s, -z, --output-delimiter. Input streams through in bounded chunks.

interface Range { lo: number; hi: number }

type Mode = 'bytes' | 'fields';

const enc = new TextEncoder();
const CHUNK = 65536;

class CutUsage extends Error {}

/** A list: items split on commas or blanks; N, N-M, N-, -M. Sorted, overlaps merged. */
function parseList(text: string, mode: Mode): Range[] {
  const what = mode === 'fields' ? 'fields are numbered from 1' : 'byte/character positions are numbered from 1';
  const ranges: Range[] = [];
  for (const item of text.split(/[,\s]/)) {
    if (item === '') throw new CutUsage(what);
    if (item === '-') throw new CutUsage('invalid range with no endpoint: -');
    const match = /^(\d*)(-?)(\d*)$/.exec(item);
    if (match === null) {
      if (/^[\d-]+$/.test(item)) throw new CutUsage(mode === 'fields' ? 'invalid field range' : 'invalid byte or character range');
      throw new CutUsage(mode === 'fields' ? `invalid field value \u2018${item}\u2019` : `invalid byte/character position \u2018${item}\u2019`);
    }
    const number = (digits: string): number => {
      const value = Number(digits);
      if (!Number.isSafeInteger(value)) {
        throw new CutUsage(mode === 'fields' ? `field number \u2018${digits}\u2019 is too large` : `byte/character offset \u2018${digits}\u2019 is too large`);
      }
      if (value === 0) throw new CutUsage(what);
      return value;
    };
    const lo = match[1] === '' ? 1 : number(match[1]);
    const hi = match[2] === '' ? lo : match[3] === '' ? Infinity : number(match[3]);
    if (hi < lo) throw new CutUsage('invalid decreasing range');
    ranges.push({ lo, hi });
  }
  ranges.sort((a, b) => a.lo - b.lo);
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.lo <= last.hi) last.hi = Math.max(last.hi, range.hi);
    else merged.push({ ...range });
  }
  return merged;
}

/** The positions not in `ranges`. */
function complement(ranges: Range[]): Range[] {
  const out: Range[] = [];
  let next = 1;
  for (const range of ranges) {
    if (range.lo > next) out.push({ lo: next, hi: range.lo - 1 });
    next = range.hi + 1;
  }
  if (next !== Infinity) out.push({ lo: next, hi: Infinity });
  return out;
}

interface CutOptions {
  mode: Mode;
  ranges: Range[];
  delimiter: number;
  outputDelimiter: Uint8Array | null;
  onlyDelimited: boolean;
  terminator: number;
}

/** One record (without its terminator) as cut prints it, or null to print nothing. */
function cutRecord(record: Uint8Array, o: CutOptions): Uint8Array[] | null {
  const parts: Uint8Array[] = [];
  if (o.mode === 'bytes') {
    for (const range of o.ranges) {
      if (range.lo > record.length) break;
      if (parts.length > 0 && o.outputDelimiter !== null) parts.push(o.outputDelimiter);
      parts.push(record.subarray(range.lo - 1, Math.min(range.hi, record.length)));
    }
    return parts;
  }
  if (!record.includes(o.delimiter)) return o.onlyDelimited ? null : [record];
  const separator = o.outputDelimiter ?? Uint8Array.of(o.delimiter);
  let field = 1;
  let start = 0;
  let wrote = false;
  let range = 0;
  for (let i = 0; i <= record.length; i++) {
    if (i < record.length && record[i] !== o.delimiter) continue;
    while (range < o.ranges.length && o.ranges[range].hi < field) range++;
    if (range === o.ranges.length) break;
    if (o.ranges[range].lo <= field) {
      if (wrote) parts.push(separator);
      parts.push(record.subarray(start, i));
      wrote = true;
    }
    field++;
    start = i + 1;
  }
  return parts;
}

async function* chunksOf(ctx: CommandContext, file: string | undefined): AsyncGenerator<Uint8Array> {
  if (file === undefined || file === '-') {
    const stdin = ctx.stdin;
    if (stdin === undefined) return;
    if (stdin.readBytes) {
      for (let chunk = await stdin.readBytes(CHUNK); chunk !== null && chunk.length > 0; chunk = await stdin.readBytes(CHUNK)) yield chunk;
      return;
    }
    for (let text = await stdin.read(); text !== null; text = await stdin.read()) yield enc.encode(text);
    return;
  }
  const path = resolve(ctx.cwd, file);
  for (let offset = 0; ; ) {
    const chunk = await ctx.vfs.readRange(path, offset, CHUNK);
    if (chunk.length === 0) return;
    yield chunk;
    offset += chunk.length;
  }
}

const command: Command = async (ctx) => {
  let mode: Mode | null = null;
  let list = '';
  let delimiterText: string | null = null;
  let outputDelimiter: Uint8Array | null = null;
  let onlyDelimited = false;
  let complemented = false;
  let terminator = 0x0a;
  const files: string[] = [];
  const usage = async (message: string): Promise<number> => {
    await ctx.stderr.write(`cut: ${message}\nTry 'cut --help' for more information.\n`);
    return 1;
  };

  const setList = (next: Mode, value: string): string | undefined => {
    if (mode !== null) return 'only one list may be specified';
    mode = next;
    list = value;
    return undefined;
  };
  const args = ctx.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { files.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const takes = ['bytes', 'characters', 'fields', 'delimiter', 'output-delimiter'].includes(name);
      let value: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);
      if (takes && value === undefined) value = args[++i];
      if (takes && value === undefined) return usage(`option '--${name}' requires an argument`);
      let error: string | undefined;
      if (name === 'bytes' || name === 'characters') error = setList('bytes', value!);
      else if (name === 'fields') error = setList('fields', value!);
      else if (name === 'delimiter') delimiterText = value!;
      else if (name === 'output-delimiter') outputDelimiter = enc.encode(value!);
      else if (name === 'only-delimited') onlyDelimited = true;
      else if (name === 'complement') complemented = true;
      else if (name === 'zero-terminated') terminator = 0;
      else return usage(`unrecognized option '--${name}'`);
      if (error !== undefined) return usage(error);
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') { files.push(arg); continue; }
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j];
      if ('bcfd'.includes(flag)) {
        let value: string | undefined = arg.slice(j + 1);
        if (value === '') value = args[++i];
        if (value === undefined) return usage(`option requires an argument -- '${flag}'`);
        const error = flag === 'd' ? (delimiterText = value, undefined) : setList(flag === 'f' ? 'fields' : 'bytes', value);
        if (error !== undefined) return usage(error);
        break;
      }
      if (flag === 's') onlyDelimited = true;
      else if (flag === 'z') terminator = 0;
      else if (flag !== 'n') return usage(`invalid option -- '${flag}'`);
    }
  }

  if (mode === null) return usage('you must specify a list of bytes, characters, or fields');
  if (delimiterText !== null && mode !== 'fields') return usage('an input delimiter may be specified only when operating on fields');
  if (onlyDelimited && mode !== 'fields') return usage('suppressing non-delimited lines makes sense\n\tonly when operating on fields');
  let delimiter = 0x09;
  if (delimiterText !== null) {
    const bytes = enc.encode(delimiterText);
    if (bytes.length > 1) return usage('the delimiter must be a single character');
    delimiter = bytes.length === 0 ? 0 : bytes[0];
  }
  let ranges: Range[];
  try {
    ranges = parseList(list, mode);
  } catch (error) {
    if (error instanceof CutUsage) return usage(error.message);
    throw error;
  }
  const options: CutOptions = {
    mode, ranges: complemented ? complement(ranges) : ranges, delimiter, outputDelimiter, onlyDelimited, terminator,
  };

  const end = Uint8Array.of(terminator);
  const write = async (parts: Uint8Array[]): Promise<void> => {
    const total = parts.reduce((n, part) => n + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    if (ctx.stdout.writeBytes) await ctx.stdout.writeBytes(out);
    else await ctx.stdout.write(new TextDecoder().decode(out));
  };
  let status = 0;
  for (const file of files.length > 0 ? files : [undefined]) {
    let carry: Uint8Array = new Uint8Array(0);
    try {
      for await (const chunk of chunksOf(ctx, file)) {
        const data = carry.length === 0 ? chunk : new Uint8Array(carry.length + chunk.length);
        if (carry.length > 0) { data.set(carry); data.set(chunk, carry.length); }
        const out: Uint8Array[] = [];
        let start = 0;
        for (let i = data.indexOf(terminator); i !== -1; i = data.indexOf(terminator, start)) {
          const parts = cutRecord(data.subarray(start, i), options);
          if (parts !== null) out.push(...parts, end);
          start = i + 1;
        }
        carry = data.slice(start);
        if (out.length > 0) await write(out);
      }
      // A last record without its terminator gets one, as GNU prints it.
      if (carry.length > 0) {
        const parts = cutRecord(carry, options);
        if (parts !== null) await write([...parts, end]);
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === undefined || code === 'EPIPE') throw error;
      const reason = code === 'ENOENT' ? 'No such file or directory' : code === 'EACCES' ? 'Permission denied' : code === 'EISDIR' ? 'Is a directory' : (error as Error).message;
      await ctx.stderr.write(`cut: ${file}: ${reason}\n`);
      status = 1;
    }
  }
  return status;
};

export default command;
