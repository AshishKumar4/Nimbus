import type { Command, CommandContext, CommandInputStream } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError, isCharacterDevice } from '../../kernel/vfs/index.js';
import { encode } from '../../utils/encoding.js';
import { SinkWriter } from '../../../../_shared/byte-stream.js';

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

const SIZE_SUFFIXES: ReadonlyMap<string, number> = new Map([
  ['c', 1], ['w', 2], ['b', 512],
  ['kB', 1000], ['K', 1024], ['k', 1024], ['KiB', 1024],
  ['MB', 1000 ** 2], ['M', 1024 ** 2], ['m', 1024 ** 2], ['MiB', 1024 ** 2],
  ['GB', 1000 ** 3], ['G', 1024 ** 3], ['g', 1024 ** 3], ['GiB', 1024 ** 3],
]);

const command: Command = async (ctx) => {
  const parsed = parseOptions(ctx.args);
  if (!parsed.ok) {
    ctx.stderr.write(`dd: ${parsed.error}\n`);
    return 1;
  }
  const options = parsed.options;

  try {
    const copied = options.input && options.input !== '-' && options.input !== '/dev/stdin'
      ? copyFromFile(ctx, options)
      : await copyFromStdin(ctx, options);
    if (options.status !== 'none') writeStatus(ctx, options, copied);
    return 0;
  } catch (error) {
    ctx.stderr.write(`dd: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

function copyFromFile(ctx: CommandContext, options: DdOptions): number {
  const path = resolve(ctx.cwd, options.input!);
  const limit = inputLimit(ctx, options, path);
  const sink = openOutput(ctx, options);
  const start = options.skip * options.inputBlockSize;

  let copied = 0;
  while (copied < limit) {
    if (ctx.signal.aborted) break;
    const want = Math.min(options.inputBlockSize, limit - copied);
    const block = readInput(ctx, path, start + copied, want, options.input!);
    if (block.length === 0) break;
    sink.write(block);
    copied += block.length;
  }
  sink.end();
  return copied;
}

async function copyFromStdin(ctx: CommandContext, options: DdOptions): Promise<number> {
  const stdin = options.input === '/dev/tty' ? ctx.terminalStdin : ctx.stdin;
  if (!stdin) throw new Error('standard input: Bad file descriptor');

  const limit = options.count === undefined
    ? Number.POSITIVE_INFINITY
    : options.count * options.inputBlockSize;
  const sink = openOutput(ctx, options);

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
    sink.write(bytes);
    copied += bytes.length;
  }
  sink.end();
  return copied;
}

async function readStdinChunk(stdin: CommandInputStream, want: number): Promise<Uint8Array | string | null> {
  if (stdin.readBytes) return stdin.readBytes(want);
  return stdin.read();
}

/**
 * How many bytes this invocation is allowed to read.
 *
 * `count` is the explicit answer. Without it dd copies to EOF, which a regular
 * file's size supplies — but a character device never reaches EOF, so an
 * unbounded copy from one cannot be satisfied and is rejected rather than
 * silently producing whatever a single read returned.
 */
function inputLimit(ctx: CommandContext, options: DdOptions, path: string): number {
  if (options.count !== undefined) return options.count * options.inputBlockSize;

  const stat = ctx.vfs.stat(path);
  if (isCharacterDevice(stat.mode)) {
    throw new Error(`${options.input}: character device has no end — pass count= to bound the copy`);
  }
  return Math.max(0, stat.size - options.skip * options.inputBlockSize);
}

function readInput(
  ctx: CommandContext,
  path: string,
  offset: number,
  length: number,
  label: string,
): Uint8Array {
  try {
    return ctx.vfs.readRange(path, offset, length);
  } catch (error) {
    if (error instanceof VFSError) throw new Error(`${label}: ${error.message}`);
    throw error;
  }
}

/** A byte destination that tracks its own write offset, like an open fd. */
interface DdSink {
  write(bytes: Uint8Array): void;
  end(): void;
}

function openOutput(ctx: CommandContext, options: DdOptions): DdSink {
  const target = options.output;
  if (!target || target === '-' || target === '/dev/stdout') return streamSink(ctx.stdout);
  if (target === '/dev/stderr') return streamSink(ctx.stderr);

  const path = resolve(ctx.cwd, target);
  const start = options.seek * options.outputBlockSize;
  // dd truncates its output file unless conv=notrunc; seeking still keeps
  // whatever precedes the seek point.
  if (!options.notrunc) {
    if (ctx.vfs.exists(path)) ctx.vfs.truncate(path, start);
    else ctx.vfs.writeFile(path, new Uint8Array(start));
  }

  let offset = start;
  return {
    write: (bytes) => {
      ctx.vfs.writeRange(path, offset, bytes);
      offset += bytes.length;
    },
    end: () => { /* nothing buffered */ },
  };
}

function streamSink(stream: CommandContext['stdout']): DdSink {
  const writer = new SinkWriter(stream);
  return { write: (bytes) => writer.write(bytes), end: () => writer.end() };
}

function writeStatus(ctx: CommandContext, options: DdOptions, copied: number): void {
  const inBlocks = Math.floor(copied / options.inputBlockSize);
  const inPartial = copied % options.inputBlockSize === 0 ? 0 : 1;
  const outBlocks = Math.floor(copied / options.outputBlockSize);
  const outPartial = copied % options.outputBlockSize === 0 ? 0 : 1;
  ctx.stderr.write(
    `${inBlocks}+${inPartial} records in\n` +
    `${outBlocks}+${outPartial} records out\n` +
    `${copied} bytes copied\n`,
  );
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

/** `1024`, `1K`, `2MiB`, `3x4` — GNU dd's size grammar. */
function parseSize(value: string): number | null {
  let total: number | null = null;
  for (const factor of value.split('x')) {
    const match = /^(\d+)([a-zA-Z]*)$/.exec(factor);
    if (!match) return null;
    const digits = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(digits)) return null;
    let scale = 1;
    if (match[2]) {
      const suffix = SIZE_SUFFIXES.get(match[2]);
      if (suffix === undefined) return null;
      scale = suffix;
    }
    total = (total ?? 1) * digits * scale;
  }
  return total;
}

export default command;
