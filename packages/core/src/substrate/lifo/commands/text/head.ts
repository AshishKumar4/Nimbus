import type { Command } from '../types.js';
import { asciiBytes, concatBytes, inputChunks, isBrokenPipe, writeBytes } from '../../utils/bytes-io.js';
import { strerror } from '../../../../vfs/vfs-error.js';
import { parseSuffixedCount } from '../../utils/size-units.js';
import { getopt, type GetoptSpec } from '../../utils/args.js';

// GNU head (coreutils 9.7) on bytes: -n [-]N lines, -c [-]N bytes (with
// GNU's suffixes), the obsolete -N, -q, -v, -z. A positive count stops
// reading once it has what it prints, so `yes | head` ends.

type Mode = { unit: 'lines' | 'bytes'; count: number; allBut: boolean };

class HeadUsage extends Error {}

/**
 * A count as GNU head reads one: a leading `-` (on the value as given) means
 * all but the last N; then blanks and a `+` may lead the digits; a count past
 * what fits is the largest (it reads everything anyway).
 */
function parseCount(value: string, unit: 'lines' | 'bytes'): Mode {
  const allBut = value.startsWith('-');
  const count = parseSuffixedCount(allBut ? value.slice(1) : value, 'bkKmMGTPEZYRQ0');
  if (count === null) throw new HeadUsage(`invalid number of ${unit}: \u2018${value}\u2019`);
  return { unit, count: Math.min(count, Number.MAX_SAFE_INTEGER), allBut };
}

/** GNU head's options, its long ones in its table's order. */
const HEAD_OPTIONS: GetoptSpec = {
  short: 'c:n:qvz',
  long: {
    bytes: ['c', 'required'], lines: ['n', 'required'], quiet: ['q', 'none'], silent: ['q', 'none'],
    verbose: ['v', 'none'], 'zero-terminated': ['z', 'none'],
  },
};

const command: Command = async (ctx) => {
  let mode: Mode = { unit: 'lines', count: 10, allBut: false };
  let headers: boolean | null = null;
  let delim = 0x0a;
  const files: string[] = [];
  const usage = async (message: string) => {
    await ctx.stderr.write(`head: ${message}\nTry 'head --help' for more information.\n`);
    return 1;
  };
  try {
    // The obsolete -N[bkm][c|l][q|v], as the first word: N lines, or N bytes with c.
    const obsolete = /^-(\d+)([bkm]?)([cqvlz]*)$/.exec(ctx.args[0] ?? '');
    if (obsolete !== null) {
      const scale = obsolete[2] === 'b' ? 512 : obsolete[2] === 'k' ? 1024 : obsolete[2] === 'm' ? 1048576 : 1;
      mode = { unit: obsolete[3].includes('c') ? 'bytes' : 'lines', count: Number(obsolete[1]) * scale, allBut: false };
      if (obsolete[3].includes('q')) headers = false;
      if (obsolete[3].includes('v')) headers = true;
      if (obsolete[3].includes('z')) delim = 0;
    }
    for (const event of getopt(obsolete === null ? ctx.args : ctx.args.slice(1), HEAD_OPTIONS)) {
      if (event.kind === 'error') return usage(event.message);
      if (event.kind === 'operand') files.push(event.value);
      else if (event.key === 'n' || event.key === 'c') mode = parseCount(event.value ?? '', event.key === 'n' ? 'lines' : 'bytes');
      else if (event.key === 'q') headers = false;
      else if (event.key === 'v') headers = true;
      else if (event.key === 'z') delim = 0;
    }
  } catch (error) {
    // A bad count is one line, without the Try line an option error gets (GNU).
    if (error instanceof HeadUsage) { await ctx.stderr.write(`head: ${error.message}\n`); return 1; }
    throw error;
  }
  if (files.length === 0) files.push('-');
  const label = headers ?? files.length > 1;
  let status = 0;
  let first = true;
  for (const file of files) {
    try {
      // GNU head reads BUFSIZ (8 KiB) at a time: what it leaves unread decides a writer's SIGPIPE.
      // A leading count is a slice head stops on by itself; "all but the last N" needs the end.
      const chunks = inputChunks(ctx, file, { readSize: 8192, slice: !mode.allBut });
      // Open (and fail) before the header, as GNU does. A count of none reads
      // nothing, so standard input is not waited on: a writer that never ends
      // it does not hold `head -n 0`.
      const none = !mode.allBut && mode.count === 0;
      const firstChunk = none && file === '-' ? { done: true as const } : await chunks.next();
      if (label) await writeBytes(ctx.stdout, asciiBytes(`${first ? '' : '\n'}==> ${file === '-' ? 'standard input' : file} <==\n`));
      first = false;
      await copy(firstChunk.done ? null : firstChunk.value, chunks, mode, delim, (bytes) => writeBytes(ctx.stdout, bytes));
    } catch (error) {
      if (isBrokenPipe(error)) throw error;
      await ctx.stderr.write(`head: cannot open '${file}' for reading: ${strerror(error)}\n`);
      status = 1;
    }
  }
  return status;
};

async function copy(
  first: Uint8Array | null,
  rest: AsyncGenerator<Uint8Array>,
  mode: Mode,
  delim: number,
  write: (bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  const all = async function* () {
    if (first !== null) yield first;
    yield* rest;
  };
  if (!mode.allBut) {
    let left = mode.count;
    if (left === 0) return;
    for await (const chunk of all()) {
      if (mode.unit === 'bytes') {
        const take = chunk.subarray(0, left);
        await write(take);
        left -= take.length;
      } else {
        let end = chunk.length;
        for (let at = 0; left > 0; ) {
          const i = chunk.indexOf(delim, at);
          if (i === -1) break;
          left--;
          at = i + 1;
          if (left === 0) end = at;
        }
        await write(chunk.subarray(0, end));
      }
      if (left === 0) {
        await rest.return(undefined);
        return;
      }
    }
    return;
  }
  // All but the last N: everything is read, the tail held back.
  const bytes = concatBytes(await (async () => { const parts: Uint8Array[] = []; for await (const c of all()) parts.push(c); return parts; })());
  if (mode.unit === 'bytes') { await write(bytes.subarray(0, Math.max(0, bytes.length - mode.count))); return; }
  let end = bytes.length;
  if (mode.count === 0) { await write(bytes); return; }
  // Drop the last N lines (a final line without its delimiter is one).
  let scan = end > 0 && bytes[end - 1] === delim ? end - 1 : end;
  for (let dropped = 0; dropped < mode.count; dropped++) {
    const i = scan === 0 ? -1 : bytes.lastIndexOf(delim, scan - 1);
    if (i === -1) { end = 0; break; }
    end = i + 1;
    scan = i;
  }
  await write(bytes.subarray(0, end));
}

export default command;
