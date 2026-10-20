import type { Command, CommandContext, CommandInputStream } from '../types.js';
import { operandPath } from '../../utils/path.js';

import { encode } from '../../utils/encoding.js';
import { SinkWriter } from '../../../../_shared/byte-stream.js';
import { isVfsError } from '../../../../vfs/vfs-error.js';
import { isCharacterDevice } from '../../../../vfs/vfs.js';
import { readToEnd, withOpenFiles, type OpenFile, type ProcessFile } from '../../../../runtime/process-files.js';
import { parseSuffixedCount } from '../../utils/size-units.js';

/**
 * dd — copy blocks between a source and a destination.
 *
 * The copy runs block by block through the VFS's positional read/write, so
 * `bs`/`count` mean what they say at any size and a 25 MB transfer never
 * becomes a 25 MB buffer. The previous implementation read the whole input as
 * a JS string and sliced it, which meant `bs`/`count` silently produced
 * whatever the source's single whole-file read happened to return.
 */

interface DdOptions {
  inputBlockSize: number;
  outputBlockSize: number;
  count?: number;
  skip: number;
  seek: number;
  input?: string;
  output?: string;
  status: 'default' | 'none';
  notrunc: boolean;
}

const command: Command = async (ctx) => {
  const parsed = parseOptions(ctx.args);
  if (!parsed.ok) {
    await ctx.stderr.write(`dd: ${parsed.error}\n`);
    return 1;
  }
  const options = parsed.options;

  try {
    // The files dd opens, if= before of= as dd opens them, are synced and
    // closed however the copy ends; a sync or a close that fails is dd's failure.
    const closing: Error[] = [];
    const copied = await withOpenFiles(ctx.vfs, async (open) => {
      const input = options.input && options.input !== '-' && options.input !== '/dev/stdin'
        ? { name: options.input, file: await openInput(ctx, options, options.input, open) }
        : null;
      const sink = await openOutput(ctx, options, open);
      try {
        return input === null ? await copyFromStdin(ctx, options, sink) : await copyFromFile(ctx, options, input.name, input.file, sink);
      } finally {
        await sink.end();
      }
    }, async (file, error) => {
      closing.push(new Error(`${file.path}: ${error instanceof Error ? error.message : String(error)}`));
    });
    if (closing.length > 0) throw closing[0];
    if (options.status !== 'none') await writeStatus(ctx, options, copied);
    return 0;
  } catch (error) {
    await ctx.stderr.write(`dd: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

/** The input, opened once, as dd's if= is: its blocks are the file the open found. */
async function openInput(ctx: CommandContext, options: DdOptions, input: string, open: OpenFile): Promise<ProcessFile> {
  const file = await labelled(input, () => open(operandPath(ctx.cwd, input), { read: true }));
  if (options.count === undefined && isCharacterDevice(file.stat.mode)) {
    throw new Error(`${input}: character device has no end — pass count= to bound the copy`);
  }
  return file;
}

/** `file`'s blocks from skip=, to its end or count=. */
async function copyFromFile(ctx: CommandContext, options: DdOptions, input: string, file: ProcessFile, sink: DdSink): Promise<number> {
  const limit = options.count === undefined ? Number.POSITIVE_INFINITY : options.count * options.inputBlockSize;
  let copied = 0;
  const blocks = readToEnd(file, options.inputBlockSize, { from: options.skip * options.inputBlockSize, limit });
  for (;;) {
    if (ctx.signal.aborted) break;
    const next = await labelled(input, () => blocks.next());
    if (next.done) break;
    await sink.write(next.value);
    copied += next.value.length;
  }
  return copied;
}

async function copyFromStdin(ctx: CommandContext, options: DdOptions, sink: DdSink): Promise<number> {
  const stdin = options.input === '/dev/tty' ? ctx.terminalStdin : ctx.stdin;
  if (!stdin) throw new Error('standard input: Bad file descriptor');

  const limit = options.count === undefined
    ? Number.POSITIVE_INFINITY
    : options.count * options.inputBlockSize;

  let copied = 0;
  let skipRemaining = options.skip * options.inputBlockSize;
  while (copied < limit) {
    const want = Math.min(options.inputBlockSize, limit - copied);
    const chunk = await readStdinChunk(stdin, skipRemaining > 0 ? skipRemaining : want);
    if (chunk === null) break;
    if (skipRemaining > 0) {
      skipRemaining -= chunk.length;
      continue;
    }
    const bytes = typeof chunk === 'string' ? encode(chunk) : chunk;
    await sink.write(bytes);
    copied += bytes.length;
  }
  return copied;
}

async function readStdinChunk(stdin: CommandInputStream, want: number): Promise<Uint8Array | string | null> {
  if (stdin.readBytes) return (await stdin.readBytes(want));
  return (await stdin.read());
}

/** `run`'s VFS failure as dd reports one: the operand's name, then the error. */
async function labelled<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isVfsError(error)) throw new Error(`${label}: ${error.message}`);
    throw error;
  }
}

/** Where dd writes: a stream, or the output file's open description at its own offset. */
interface DdSink {
  write(bytes: Uint8Array): void | Promise<void>;
  end(): void | Promise<void>;
}

async function openOutput(ctx: CommandContext, options: DdOptions, open: OpenFile): Promise<DdSink> {
  const target = options.output;
  if (!target || target === '-' || target === '/dev/stdout') return streamSink(ctx.stdout);
  if (target === '/dev/stderr') return streamSink(ctx.stderr);

  const path = operandPath(ctx.cwd, target);
  const start = options.seek * options.outputBlockSize;
  // The output is opened once, as dd's of= is, and written at its own offset.
  // dd truncates it unless conv=notrunc; seeking still keeps whatever
  // precedes the seek point.
  const file = await labelled(target, () => open(path, { write: true, create: true }));
  // The file dd opened, whatever its name names now.
  if (!options.notrunc) await labelled(target, () => file.truncate(start));
  let offset = start;
  return {
    write: async (bytes) => {
      await labelled(target, () => file.write(bytes, offset));
      offset += bytes.length;
    },
    // Synced and closed with every file dd opened (withOpenFiles).
    end: () => undefined,
  };
}

function streamSink(stream: CommandContext['stdout']): DdSink {
  const writer = new SinkWriter(stream);
  return { write: async (bytes) => (await writer.write(bytes)), end: () => writer.end() };
}

async function writeStatus(ctx: CommandContext, options: DdOptions, copied: number): Promise<void> {
  const inBlocks = Math.floor(copied / options.inputBlockSize);
  const inPartial = copied % options.inputBlockSize === 0 ? 0 : 1;
  const outBlocks = Math.floor(copied / options.outputBlockSize);
  const outPartial = copied % options.outputBlockSize === 0 ? 0 : 1;
  await ctx.stderr.write(`${inBlocks}+${inPartial} records in\n` +
  `${outBlocks}+${outPartial} records out\n` +
  `${copied} bytes copied\n`,);
}

function parseOptions(args: string[]): { ok: true; options: DdOptions } | { ok: false; error: string } {
  const options: DdOptions = {
    inputBlockSize: 512,
    outputBlockSize: 512,
    skip: 0,
    seek: 0,
    status: 'default',
    notrunc: false,
  };

  for (const arg of args) {
    const separator = arg.indexOf('=');
    if (separator <= 0) return { ok: false, error: `unrecognized operand '${arg}'` };
    const name = arg.slice(0, separator);
    const value = arg.slice(separator + 1);

    switch (name) {
      case 'bs': {
        const size = parseSize(value);
        if (size === null || size <= 0) return { ok: false, error: `invalid block size '${value}'` };
        options.inputBlockSize = size;
        options.outputBlockSize = size;
        break;
      }
      case 'ibs': {
        const size = parseSize(value);
        if (size === null || size <= 0) return { ok: false, error: `invalid block size '${value}'` };
        options.inputBlockSize = size;
        break;
      }
      case 'obs': {
        const size = parseSize(value);
        if (size === null || size <= 0) return { ok: false, error: `invalid block size '${value}'` };
        options.outputBlockSize = size;
        break;
      }
      case 'count': {
        const count = parseSize(value);
        if (count === null) return { ok: false, error: `invalid count '${value}'` };
        options.count = count;
        break;
      }
      case 'skip':
      case 'iseek': {
        const skip = parseSize(value);
        if (skip === null) return { ok: false, error: `invalid skip '${value}'` };
        options.skip = skip;
        break;
      }
      case 'seek':
      case 'oseek': {
        const seek = parseSize(value);
        if (seek === null) return { ok: false, error: `invalid seek '${value}'` };
        options.seek = seek;
        break;
      }
      case 'if':
        options.input = value;
        break;
      case 'of':
        options.output = value;
        break;
      case 'conv': {
        for (const flag of value.split(',')) {
          if (flag === 'notrunc') options.notrunc = true;
          else return { ok: false, error: `unsupported conversion '${flag}'` };
        }
        break;
      }
      case 'status':
        if (value === 'none') options.status = 'none';
        else if (value !== 'noxfer' && value !== 'progress') {
          return { ok: false, error: `unsupported status '${value}'` };
        }
        break;
      default:
        return { ok: false, error: `unrecognized operand '${name}'` };
    }
  }

  return { ok: true, options };
}

/**
 * `1024`, `1K`, `2MiB`, `3x4`: GNU dd's size grammar, factors joined by `x`,
 * each a count with dd's suffixes (`c` bytes, `w` words, `b` blocks, ...) or
 * digits followed by a bare `B`.
 */
function parseSize(value: string): number | null {
  let total = 1;
  for (const factor of value.split('x')) {
    const count = parseSuffixedCount(/[0-9]B$/.test(factor) ? factor.slice(0, -1) : factor, 'bcEGkKMPQRTwYZ0');
    if (count === null) return null;
    total *= count;
  }
  return Number.isSafeInteger(total) ? total : null;
}

export default command;
