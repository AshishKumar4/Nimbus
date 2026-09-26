import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { fsErrorText, inputChunks, writeBytes } from '../../utils/bytes-io.js';

// GNU tee (coreutils 9.7) on bytes, streaming: standard input to standard
// output and every FILE as it arrives. -a appends; a FILE that cannot be
// opened is reported and the rest still get the input (status 1); -i, -p and
// --output-error are accepted (there are no signals or broken pipes to treat
// differently here).

const command: Command = async (ctx) => {
  let append = false;
  const files: string[] = [];
  const usage = async (message: string) => {
    await ctx.stderr.write(`tee: ${message}\nTry 'tee --help' for more information.\n`);
    return 1;
  };
  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if (arg === '--') { files.push(...ctx.args.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const name = arg.slice(2).split('=', 1)[0];
      if (name === 'append') append = true;
      else if (name !== 'ignore-interrupts' && name !== 'output-error') return usage(`unrecognized option '${arg}'`);
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') { files.push(arg); continue; }
    for (const flag of arg.slice(1)) {
      if (flag === 'a') append = true;
      else if (flag !== 'i' && flag !== 'p') return usage(`invalid option -- '${flag}'`);
    }
  }
  let status = 0;
  // Each FILE operand is its own descriptor: without -a, one per occurrence
  // at its own offset (so `tee f f` writes the input once); with -a each
  // occurrence appends.
  const outputs: { path: string; offset: number }[] = [];
  for (const file of files) {
    if (file === '-') { outputs.push({ path: '-', offset: 0 }); continue; }
    const path = resolve(ctx.cwd, file);
    try {
      if (!append) await ctx.vfs.writeFile(path, new Uint8Array(0));
      else if ((await ctx.vfs.stat(path)) === null) await ctx.vfs.writeFile(path, new Uint8Array(0));
      outputs.push({ path, offset: 0 });
    } catch (error) {
      await ctx.stderr.write(`tee: ${file}: ${fsErrorText(error)}\n`);
      status = 1;
    }
  }
  for await (const chunk of inputChunks(ctx, '-')) {
    await writeBytes(ctx.stdout, chunk);
    for (const out of outputs) {
      try {
        if (out.path === '-') await writeBytes(ctx.stdout, chunk);
        else if (append) await ctx.vfs.appendFile(out.path, chunk);
        else { await ctx.vfs.writeRange(out.path, out.offset, chunk); out.offset += chunk.length; }
      } catch (error) {
        await ctx.stderr.write(`tee: ${out.path}: ${fsErrorText(error)}\n`);
        status = 1;
      }
    }
  }
  return status;
};

export default command;
