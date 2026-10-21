/**
 * Byte input and output for the text commands. GNU's tools read and write
 * bytes: a byte that is not valid UTF-8 passes through unchanged. Decoding
 * with TextDecoder would turn it into U+FFFD, three different bytes.
 */
import { concatBytes as concatParts, enc } from '../../../_shared/bytes.js';
import { readToEnd, type ProcessView } from '../../../runtime/process-files.js';
import { isVfsError, syscallError } from '../../../vfs/vfs-error.js';
import type { CommandInputStream, CommandOutputStream } from '../commands/types.js';
import { operandPath } from './path.js';
import { direntTypeOfStat } from '../../../vfs/dirent-type.js';
import { fitsWholeRead } from '../../../runtime/sqlite-runtime-fs-bridge.js';
import { LosslessDecoder, decodeLossless, encodeLossless, firstLosslessByte } from './lossless-text.js';

export { decodeLossless, encodeLossless, joinLossless, utf8SequenceLength } from './lossless-text.js';

export interface ByteInputContext {
  cwd: string;
  vfs: ProcessView;
  stdin?: string | CommandInputStream;
}

export interface ByteOutput {
  write(text: string): unknown;
  writeBytes?(bytes: Uint8Array): unknown;
}

const CHUNK = 65536;

export interface InputChunkOptions {
  /**
   * How much one read asks of a pipe: a reader that stops early leaves the
   * rest unread, as the GNU tool it mirrors would (head reads 8 KiB).
   */
  readSize?: number;
  /**
   * How much one read of a file asks: what a reader that judges each read
   * as a whole (grep's binary test, GNU's 96 KiB) needs it to be.
   */
  fileReadSize?: number;
  /**
   * The reader takes a leading slice and stops on its own (head with a
   * count), or writes to a pipe whose reader can stop it (cat). Only then is
   * a character device streamed for as long as it is asked. Any other reader
   * wants the operand to its end, which the device itself answers: /dev/null
   * is empty, and an endless device (/dev/zero) refuses a whole read.
   */
  slice?: boolean;
}

/** An operand's bytes in bounded chunks; `-` or undefined is standard input. */
export async function* inputChunks(
  ctx: ByteInputContext,
  operand: string | undefined,
  { readSize = CHUNK, fileReadSize = CHUNK, slice = false }: InputChunkOptions = {},
): AsyncGenerator<Uint8Array> {
  if (operand === undefined || operand === '-') {
    const stdin = ctx.stdin;
    if (stdin === undefined) return;
    if (typeof stdin === 'string') {
      const bytes = encodeLossless(stdin);
      for (let i = 0; i < bytes.length; i += CHUNK) yield bytes.subarray(i, i + CHUNK);
      return;
    }
    if (stdin.readBytes) {
      for (let chunk = await stdin.readBytes(readSize); chunk !== null && chunk.length > 0; chunk = await stdin.readBytes(readSize)) yield chunk;
      return;
    }
    for (let text = await stdin.read(); text !== null; text = await stdin.read()) yield encodeLossless(text);
    return;
  }
  const path = operandPath(ctx.cwd, operand);
  // A file one read holds is read whole, in one call, as the one file the
  // name leads to; a larger one, or a device, through one description from
  // its first byte to a read that answers none (its end), closed however the
  // reader stops: either way the bytes are one file's, whatever the name
  // names after.
  const whole = await wholeRead(ctx, path, fileReadSize);
  if (whole !== null) {
    if (whole.length > 0) yield whole;
    return;
  }
  yield* descriptionChunks(ctx, path, fileReadSize, slice);
}

/** The file at `path` through one description from its first byte to its end, closed however the reader stops. */
async function* descriptionChunks(ctx: ByteInputContext, path: string, fileReadSize: number, slice: boolean): AsyncGenerator<Uint8Array> {
  const file = await ctx.vfs.open(path, { read: true });
  try {
    if (file.stat.type === 'directory') throw syscallError('EISDIR', 'read', path);
    if (direntTypeOfStat(file.stat) === 'character' && !slice) {
      // A reader that wants the operand to its end asks the device for all of
      // it, which the device answers: /dev/null is empty, and an endless
      // device (/dev/zero) refuses.
      const bytes = await ctx.vfs.readFile(path);
      if (bytes.length > 0) yield bytes;
      return;
    }
    yield* readToEnd(file, fileReadSize);
  } finally {
    await file.close();
  }
}

/** All of an operand's bytes. */
export async function readAllInput(ctx: ByteInputContext, operand: string | undefined): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of inputChunks(ctx, operand)) parts.push(chunk);
  return concatBytes(parts);
}

/** The parts as one: a single part is itself, uncopied; more are the shared concatenation (_shared/bytes.ts). */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  return parts.length === 1 ? parts[0] : concatParts(parts);
}

/** Write bytes as they are, to a sink that takes bytes; a text-only sink gets their lossless decoding. */
export async function writeBytes(out: ByteOutput, bytes: Uint8Array): Promise<void> {
  if (bytes.length === 0) return;
  if (out.writeBytes) await out.writeBytes(bytes);
  else await out.write(decodeLossless(bytes));
}

/**
 * Write lossless text (decodeLossless's): as text, unless it carries a byte
 * (U+DC80..U+DCFF) a sink's UTF-8 would not keep, when it goes as its bytes.
 * Not async: plain text is the sink's own write, with no extra await.
 */
export function writeLossless(out: CommandOutputStream, text: string): void | Promise<void> {
  return firstLosslessByte(text) === -1 ? out.write(text) : writeBytes(out, encodeLossless(text));
}

/**
 * An output the shell captures as text (exec's stdout and stderr, `$( )`):
 * the bytes of every command writing to it decoded as one stream, as its
 * reader would read them, and `end`ed when the capture is read.
 */
export function textCapture(append: (text: string) => void): { readonly stream: CommandOutputStream & { writeBytes(bytes: Uint8Array): void }; end(): void } {
  const decoder = new LosslessDecoder();
  return {
    stream: {
      writeBytes: (bytes) => { append(decoder.decode(bytes)); },
      // Text after bytes that left a character unfinished: those bytes decode alone first. No text is no write.
      write: (text) => { if (text !== '') append(decoder.end() + text); },
    },
    end: () => { append(decoder.end()); },
  };
}


/** A write to a pipe whose reader has gone: the writer ends there, silently, as SIGPIPE ends it. */
export function isBrokenPipe(error: unknown): boolean {
  return (error as { code?: string })?.code === 'EPIPE';
}

/** The errors of a write the store or a device refused: out of room, too large, or lost. */
const REFUSED_WRITE_CODES = new Set(['ENOSPC', 'EDQUOT', 'EFBIG', 'EIO']);

/** Whether `error` is a write the store or a device refused (not a broken pipe: that is SIGPIPE's). */
export function isRefusedWrite(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && REFUSED_WRITE_CODES.has(error.code);
}

/** Records split on `delim`: each without its delimiter; `terminated` says whether the last had one. */
export function splitRecords(bytes: Uint8Array, delim: number): { records: Uint8Array[]; terminated: boolean } {
  const records: Uint8Array[] = [];
  let start = 0;
  for (let i = bytes.indexOf(delim); i !== -1; i = bytes.indexOf(delim, start)) {
    records.push(bytes.subarray(start, i));
    start = i + 1;
  }
  const terminated = start === bytes.length;
  if (!terminated) records.push(bytes.subarray(start));
  return { records, terminated };
}

/** A blank, as GNU's field splitting (sort -k, uniq -f) means one: space or tab. */
export function isBlank(byte: number): boolean {
  return byte === 0x20 || byte === 0x09;
}

/** Where the field starting at `at` in `line` ends: past its leading blanks, then past its non-blanks. */
export function skipBlankField(line: Uint8Array, at: number): number {
  while (at < line.length && isBlank(line[at])) at++;
  while (at < line.length && !isBlank(line[at])) at++;
  return at;
}

/** An ASCII byte in upper case; any other byte as it is (GNU's -f and -i fold no other). */
export function asciiUpper(byte: number): number {
  return byte >= 0x61 && byte <= 0x7a ? byte - 32 : byte;
}

export function asciiBytes(text: string): Uint8Array {
  return enc.encode(text);
}

/**
 * The file at `path` read whole when one read holds it (fitsWholeRead); null
 * when it is larger, or a device. The stat only chooses whether to try: a
 * refusal that throws costs a deep stack's capture, as a stat does not, and
 * a file that grew past the stat is refused by the read itself (EFBIG).
 */
async function wholeRead(ctx: ByteInputContext, path: string, fileReadSize: number): Promise<Uint8Array | null> {
  const seen = await ctx.vfs.stat(path);
  if (seen !== null && !fitsWholeRead(seen, fileReadSize)) return null;
  try {
    return await ctx.vfs.readFile(path, { maxBytes: fileReadSize });
  } catch (error) {
    if (!isVfsError(error) || error.code !== 'EFBIG') throw error;
    return null;
  }
}
