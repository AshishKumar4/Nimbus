import type { Command } from '../types.js';
import { concatBytes, inputChunks, writeBytes, asciiBytes } from '../../utils/bytes-io.js';
import { strerror } from '../../../../vfs/vfs-error.js';
import { parseSuffixedCount } from '../../utils/size-units.js';

// GNU tail (coreutils 9.7) on bytes: -n [+]N lines, -c [+]N bytes, -N, -q,
// -v, -z. Output is the input's own bytes: nothing is added or re-encoded.

type Mode = { unit: 'lines' | 'bytes'; count: number; fromStart: boolean };

class TailUsage extends Error {}

/** A count as GNU tail reads one: `+N` counts from the start, `-N` (or N) back from the end, with head's suffixes. */
function parseCount(value: string, unit: 'lines' | 'bytes'): Mode {
  const count = parseSuffixedCount(value.startsWith('-') ? value.slice(1) : value, 'bkKmMGTPEZYRQ0');
  if (count === null) throw new TailUsage(`invalid number of ${unit}: \u2018${value}\u2019`);
  return { unit, count: Math.min(count, Number.MAX_SAFE_INTEGER), fromStart: value.startsWith('+') };
}

const command: Command = async (ctx) => {
  let mode: Mode = { unit: 'lines', count: 10, fromStart: false };
  let headers: boolean | null = null;
  let delim = 0x0a;
  const files: string[] = [];
  const usage = async (message: string) => {
    await ctx.stderr.write(`tail: ${message}\nTry 'tail --help' for more information.\n`);
    return 1;
  };
  try {
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') { files.push(...args.slice(i + 1)); break; }
      if (arg.startsWith('--')) {
        const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
        const value = () => inline ?? args[++i];
        if (name === 'lines') mode = parseCount(value() ?? '', 'lines');
        else if (name === 'bytes') mode = parseCount(value() ?? '', 'bytes');
        else if (name === 'quiet' || name === 'silent') headers = false;
        else if (name === 'verbose') headers = true;
        else if (name === 'zero-terminated') delim = 0;
        else return usage(`unrecognized option '--${name}'`);
        continue;
      }
      if (!arg.startsWith('-') || arg === '-') { files.push(arg); continue; }
      // The obsolete -N (as the first option): the last N lines.
      if (/^-\d+$/.test(arg)) { mode = parseCount(arg.slice(1), 'lines'); continue; }
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (flag === 'n' || flag === 'c') {
          let value: string | undefined = arg.slice(j + 1);
          if (value === '') value = args[++i];
          if (value === undefined) return usage(`option requires an argument -- '${flag}'`);
          mode = parseCount(value, flag === 'n' ? 'lines' : 'bytes');
          break;
        }
        if (flag === 'q') headers = false;
        else if (flag === 'v') headers = true;
        else if (flag === 'z') delim = 0;
        else if (flag === 'f' || flag === 'F') { /* a finished input has nothing to follow */ }
        else return usage(`invalid option -- '${flag}'`);
      }
    }
  } catch (error) {
    if (error instanceof TailUsage) return usage(error.message);
    throw error;
  }
  if (files.length === 0) files.push('-');
  const label = headers ?? files.length > 1;
  let status = 0;
  let first = true;
  for (const file of files) {
    let bytes: Uint8Array;
    try {
      const parts: Uint8Array[] = [];
      for await (const chunk of inputChunks(ctx, file)) parts.push(chunk);
      bytes = concatBytes(parts);
    } catch (error) {
      await ctx.stderr.write(`tail: cannot open '${file}' for reading: ${strerror(error)}\n`);
      status = 1;
      continue;
    }
    if (label) await writeBytes(ctx.stdout, asciiBytes(`${first ? '' : '\n'}==> ${file === '-' ? 'standard input' : file} <==\n`));
    first = false;
    await writeBytes(ctx.stdout, select(bytes, mode, delim));
  }
  return status;
};

/** The part of `bytes` tail prints. */
function select(bytes: Uint8Array, mode: Mode, delim: number): Uint8Array {
  if (mode.unit === 'bytes') {
    if (mode.fromStart) return bytes.subarray(Math.min(bytes.length, Math.max(0, mode.count - 1)));
    return bytes.subarray(Math.max(0, bytes.length - mode.count));
  }
  if (mode.fromStart) {
    // From line N on: skip N-1 delimiters.
    let at = 0;
    for (let skipped = 0; skipped < mode.count - 1; skipped++) {
      const i = bytes.indexOf(delim, at);
      if (i === -1) return bytes.subarray(bytes.length);
      at = i + 1;
    }
    return bytes.subarray(at);
  }
  if (mode.count === 0) return bytes.subarray(bytes.length);
  // The last N lines: a final line without its delimiter is a line too.
  let end = bytes.length;
  if (end > 0 && bytes[end - 1] === delim) end--;
  let start = end;
  for (let found = 0; ; ) {
    if (start === 0) return bytes.subarray(0);
    const i = bytes.lastIndexOf(delim, start - 1);
    if (i === -1) return bytes.subarray(0);
    found++;
    if (found === mode.count) return bytes.subarray(i + 1);
    start = i;
  }
}

export default command;
