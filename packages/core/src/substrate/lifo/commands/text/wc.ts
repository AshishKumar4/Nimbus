import type { Command } from '../types.js';
import { asciiBytes, fsErrorText, inputChunks, utf8SequenceLength, writeBytes } from '../../utils/bytes-io.js';

// GNU wc (coreutils 9.7) in a UTF-8 locale, on bytes: -l counts newlines;
// -w counts runs of non-space characters (a byte that is not valid UTF-8 is
// part of a word); -m counts characters (an invalid byte is none); -c bytes;
// -L the widest line's display width. Columns in that order, each as wide
// as GNU lays them out.

interface Counts { lines: number; words: number; chars: number; bytes: number; width: number }

/** glibc's iswspace in a UTF-8 locale. */
function isSpace(cp: number): boolean {
  return (cp >= 9 && cp <= 13) || cp === 32 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x2006)
    || (cp >= 0x2008 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x205f || cp === 0x3000;
}

/** A character's display width (wcwidth): 0 for controls and combining marks, 2 for wide ones. */
function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x483 && cp <= 0x489) || (cp >= 0x591 && cp <= 0x5bd)
    || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff)
    || (cp >= 0xfe20 && cp <= 0xfe2f) || cp === 0x200b || (cp >= 0x200c && cp <= 0x200f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f)
    || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

class Counter {
  readonly c: Counts = { lines: 0, words: 0, chars: 0, bytes: 0, width: 0 };
  private inWord = false;
  private pos = 0;
  private carry = new Uint8Array(0);

  feed(chunk: Uint8Array, final = false): void {
    const data = this.carry.length === 0 ? chunk : (() => { const d = new Uint8Array(this.carry.length + chunk.length); d.set(this.carry); d.set(chunk, this.carry.length); return d; })();
    this.c.bytes += chunk.length;
    let i = 0;
    while (i < data.length) {
      const b = data[i];
      let len = 1;
      let cp = -1;
      if (b < 0x80) cp = b;
      else {
        // A sequence cut by the chunk's end waits for the rest.
        if (!final && data.length - i < 4 && b >= 0xc2 && b <= 0xf4 && utf8SequenceLength(data, i) === 0 && couldContinue(data, i)) break;
        len = utf8SequenceLength(data, i);
        if (len === 0) len = 1;
        else cp = decode(data, i, len);
      }
      i += len;
      // An invalid byte is no character, but it is part of a word.
      if (cp === -1) { if (!this.inWord) { this.inWord = true; this.c.words++; } continue; }
      this.c.chars++;
      if (cp === 10) {
        this.c.lines++;
        this.endLine();
      } else if (cp === 13 || cp === 12) {
        this.endLine();
      } else if (cp === 9) {
        this.pos += 8 - (this.pos % 8);
      } else {
        this.pos += charWidth(cp);
      }
      if (isSpace(cp)) this.inWord = false;
      else if (!this.inWord) { this.inWord = true; this.c.words++; }
    }
    this.carry = data.slice(i);
  }

  finish(): Counts {
    if (this.carry.length > 0) { const rest = this.carry; this.carry = new Uint8Array(0); this.c.bytes -= rest.length; this.feed(rest, true); }
    this.endLine();
    return this.c;
  }

  private endLine(): void {
    if (this.pos > this.c.width) this.c.width = this.pos;
    this.pos = 0;
  }
}

function couldContinue(data: Uint8Array, i: number): boolean {
  for (let k = i + 1; k < data.length; k++) if ((data[k] & 0xc0) !== 0x80) return false;
  return true;
}

function decode(data: Uint8Array, i: number, len: number): number {
  if (len === 2) return ((data[i] & 0x1f) << 6) | (data[i + 1] & 0x3f);
  if (len === 3) return ((data[i] & 0x0f) << 12) | ((data[i + 1] & 0x3f) << 6) | (data[i + 2] & 0x3f);
  return ((data[i] & 0x07) << 18) | ((data[i + 1] & 0x3f) << 12) | ((data[i + 2] & 0x3f) << 6) | (data[i + 3] & 0x3f);
}

const command: Command = async (ctx) => {
  const want = { lines: false, words: false, chars: false, bytes: false, width: false };
  let total: 'auto' | 'always' | 'only' | 'never' = 'auto';
  const files: string[] = [];
  const usage = async (message: string) => {
    await ctx.stderr.write(`wc: ${message}\nTry 'wc --help' for more information.\n`);
    return 1;
  };
  const args = ctx.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { files.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const [name, value] = arg.slice(2).split(/=(.*)/s, 2);
      if (name === 'lines') want.lines = true;
      else if (name === 'words') want.words = true;
      else if (name === 'chars') want.chars = true;
      else if (name === 'bytes') want.bytes = true;
      else if (name === 'max-line-length') want.width = true;
      else if (name === 'total') {
        if (value !== 'auto' && value !== 'always' && value !== 'only' && value !== 'never') return usage(`invalid argument \u2018${value ?? ''}\u2019 for \u2018--total\u2019`);
        total = value;
      } else return usage(`unrecognized option '--${name}'`);
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') { files.push(arg); continue; }
    for (const flag of arg.slice(1)) {
      if (flag === 'l') want.lines = true;
      else if (flag === 'w') want.words = true;
      else if (flag === 'm') want.chars = true;
      else if (flag === 'c') want.bytes = true;
      else if (flag === 'L') want.width = true;
      else return usage(`invalid option -- '${flag}'`);
    }
  }
  if (!want.lines && !want.words && !want.chars && !want.bytes && !want.width) {
    want.lines = want.words = want.bytes = true;
  }
  const columns = (['lines', 'words', 'chars', 'bytes', 'width'] as const).filter((k) => want[k]);
  const operands = files.length === 0 ? [undefined] : files;

  const results: { label: string | undefined; counts: Counts | null; regular: boolean }[] = [];
  let status = 0;
  for (const file of operands) {
    const counter = new Counter();
    try {
      for await (const chunk of inputChunks(ctx, file)) counter.feed(chunk);
      results.push({ label: file, counts: counter.finish(), regular: file !== undefined && file !== '-' });
    } catch (error) {
      await ctx.stderr.write(`wc: ${file}: ${fsErrorText(error)}\n`);
      status = 1;
      results.push({ label: file, counts: null, regular: false });
    }
  }
  const counted = results.filter((r) => r.counts !== null);
  const sum: Counts = { lines: 0, words: 0, chars: 0, bytes: 0, width: 0 };
  for (const r of counted) {
    for (const k of ['lines', 'words', 'chars', 'bytes'] as const) sum[k] += r.counts![k];
    sum.width = Math.max(sum.width, r.counts!.width);
  }

  // GNU's widths: one number for one input needs none; otherwise the digits
  // of the regular files' total size, and 7 once any input is not a regular
  // file (a stream's size is unknown ahead).
  let width = 1;
  if (total === 'only') width = 1;
  else if (!(columns.length === 1 && operands.length === 1)) {
    let minimum = 1;
    let regularBytes = 0;
    for (const r of results) {
      if (r.counts === null) continue;
      if (!r.regular) minimum = 7;
      else regularBytes += r.counts.bytes;
    }
    width = Math.max(String(regularBytes).length, minimum);
  }
  const line = (counts: Counts, label: string | undefined) =>
    asciiBytes(columns.map((k) => String(counts[k]).padStart(width)).join(' ') + (label === undefined ? '' : ` ${label}`) + '\n');

  if (total !== 'only') {
    for (const r of results) if (r.counts !== null) await writeBytes(ctx.stdout, line(r.counts, r.label));
  }
  const printTotal = total === 'always' || total === 'only' || (total === 'auto' && operands.length > 1);
  if (printTotal) await writeBytes(ctx.stdout, line(sum, total === 'only' ? undefined : 'total'));
  return status;
};

export default command;
