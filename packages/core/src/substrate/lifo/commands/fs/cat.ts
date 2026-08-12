import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { SinkWriter, streamRange } from '../../../../_shared/byte-stream.js';

const command: Command = async (ctx) => {
  if (ctx.args.length === 0) {
    // Read from stdin if available (enables piping: echo hi | cat)
    if (ctx.stdin) {
      const content = await ctx.stdin.readAll();
      ctx.stdout.write(content);
      return 0;
    }
    ctx.stderr.write('cat: missing operand\n');
    return 1;
  }

  let exitCode = 0;
  // One writer across all operands: cat concatenates byte streams, so a
  // multi-byte character split across an operand boundary stays one character.
  const writer = new SinkWriter(ctx.stdout);

  for (const arg of ctx.args) {
    const path = resolve(ctx.cwd, arg);
    try {
      const stat = ctx.vfs.stat(path);
      if (stat.type === 'directory') throw new VFSError('EISDIR', `'${arg}': is a directory`);
      if (stat.size > 0) {
        // A regular file's size is its exact extent — copy precisely that, in
        // bounded steps, so a large file never becomes a large buffer.
        streamRange((offset, length) => ctx.vfs.readRange(path, offset, length), writer, {
          length: stat.size,
          signal: ctx.signal,
        });
      } else {
        // Empty files, /dev/null and synthesised /proc entries. Character
        // devices with no end reject this unbounded read by design.
        writer.write(ctx.vfs.readFile(path));
      }
    } catch (e) {
      if (e instanceof VFSError) {
        ctx.stderr.write(`cat: ${arg}: ${e.message}\n`);
        exitCode = 1;
      } else {
        throw e;
      }
    }
  }

  writer.end();
  return exitCode;
};

export default command;
