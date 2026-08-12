import type { Command } from '../types.js';
import { parseArgs } from '../../utils/args.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';

function extractStrings(data: Uint8Array, minLen: number): string[] {
  const results: string[] = [];
  let current = '';

  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    // Printable ASCII range (space through tilde) plus tab
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= minLen) {
        results.push(current);
      }
      current = '';
    }
  }
  if (current.length >= minLen) {
    results.push(current);
  }

  return results;
}

const spec = {
  bytes: { type: 'string' as const, short: 'n' },
  // Every byte of every file is scanned already, so -a asks for the default.
  all: { type: 'boolean' as const, short: 'a' },
};

const command: Command = async (ctx) => {
  const parsed = parseArgs('strings', ctx.args, spec, { numericShorthand: 'bytes' });
  if (!parsed.ok) {
    ctx.stderr.write(parsed.error);
    return 1;
  }
  const files = parsed.positional;

  let minLen = 4;
  if (parsed.flags.bytes !== '') {
    const requested = parseInt(parsed.flags.bytes as string, 10);
    // A length that is not a length used to fall back to 4 in silence.
    if (isNaN(requested) || requested < 1) {
      ctx.stderr.write(`strings: invalid minimum string length ${parsed.flags.bytes}\n`);
      return 1;
    }
    minLen = requested;
  }

  let exitCode = 0;

  if (files.length === 0) {
    ctx.stderr.write('Usage: strings [-n MIN] FILE...\n');
    ctx.stderr.write('Print sequences of printable characters from files.\n');
    return 1;
  }

  for (const file of files) {
    const path = resolve(ctx.cwd, file);
    try {
      const data = ctx.vfs.readFile(path);
      for (const s of extractStrings(data, minLen)) {
        ctx.stdout.write(s + '\n');
      }
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`strings: ${file}: ${e.message}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
  }

  return exitCode;
};

export default command;
