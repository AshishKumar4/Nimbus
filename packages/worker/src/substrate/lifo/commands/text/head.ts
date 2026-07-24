import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { SinkWriter, streamRange } from '../../../../_shared/byte-stream.js';

const command: Command = async (ctx) => {
  let lines = 10;
  let bytes: number | undefined;
  const files: string[] = [];

  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if (arg === '-n' || arg === '-c') {
      const count = parseCount(ctx.args[++i]);
      if (count === null) { ctx.stderr.write(`head: invalid count\n`); return 1; }
      if (arg === '-c') bytes = count; else lines = count;
    } else if (/^-[nc]\d/.test(arg)) {
      const count = parseCount(arg.slice(2));
      if (count === null) { ctx.stderr.write(`head: invalid count\n`); return 1; }
      if (arg[1] === 'c') bytes = count; else lines = count;
    } else if (/^-\d+$/.test(arg)) {
      lines = Number.parseInt(arg.slice(1), 10);
    } else {
      files.push(arg);
    }
  }

  if (files.length === 0) {
    if (!ctx.stdin) { ctx.stderr.write('head: missing file operand\n'); return 1; }
    const text = await ctx.stdin.readAll();
    ctx.stdout.write(bytes === undefined ? headLines(text, lines) : text.slice(0, bytes));
    return 0;
  }

  let exitCode = 0;
  const writer = bytes === undefined ? null : new SinkWriter(ctx.stdout);
  for (const file of files) {
    const path = resolve(ctx.cwd, file);
    try {
      if (files.length > 1) ctx.stdout.write(`==> ${file} <==\n`);
      if (writer === null) {
        ctx.stdout.write(headLines(ctx.vfs.readFileString(path), lines));
      } else {
        // Bounded read: works on regular files and on endless character
        // devices alike, since neither is ever materialised whole.
        streamRange((offset, length) => ctx.vfs.readRange(path, offset, length), writer, {
          length: bytes,
          signal: ctx.signal,
        });
      }
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`head: ${file}: ${e.message}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
  }

  writer?.end();
  return exitCode;
};

function headLines(text: string, count: number): string {
  const all = text.split('\n');
  const selected = all.slice(0, count);
  return selected.join('\n') + (all.length > count ? '\n' : '');
}

function parseCount(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d+)([bkKmMgG]?)$/.exec(value);
  if (!match) return null;
  const scale = { '': 1, b: 512, k: 1024, K: 1024, m: 1024 ** 2, M: 1024 ** 2, g: 1024 ** 3, G: 1024 ** 3 };
  return Number.parseInt(match[1], 10) * scale[match[2] as keyof typeof scale];
}

export default command;
