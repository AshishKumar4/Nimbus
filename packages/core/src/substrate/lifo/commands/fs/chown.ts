import { parseChownOwnership } from '../../../../shell/unix-accounts.js';
import type { Command } from '../types.js';
import { parseArgs } from '../../utils/args.js';
import { resolve } from '../../utils/path.js';
import { statOrThrow } from '../../../../vfs/vfs.js';
import { strerror } from '../../../../vfs/vfs-error.js';

const spec = {
  recursive: { type: 'boolean' as const, short: 'R' },
};

const command: Command = async (ctx) => {
  const { flags, positional } = parseArgs(ctx.args, spec);
  if (positional.length < 2) {
    await ctx.stderr.write('chown: missing operand\n');
    return 1;
  }
  const vfs = ctx.vfs;

  let requested: { uid: number | null; gid: number | null };
  try {
    requested = (await parseChownOwnership(vfs, positional[0]));
  } catch (error) {
    await ctx.stderr.write(`chown: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const apply = async (path: string, type: string): Promise<void> => {
    if (flags.recursive && type === 'directory') {
      for (const child of (await vfs.readdir(path))) {
        const childPath = resolve(path, child.name);
        (await apply(childPath, (await statOrThrow(vfs, childPath)).type));
      }
    }
    (await vfs.chown(path, requested.uid, requested.gid));
  };

  let exitCode = 0;
  for (const file of positional.slice(1)) {
    // GNU stats each operand before changing it, so a name it cannot look
    // up (missing, or behind a directory it cannot search) "cannot be
    // accessed", and only a change the filesystem refuses is a change of
    // ownership that failed.
    const path = resolve(ctx.cwd, file);
    let type: string;
    try {
      type = (await statOrThrow(vfs, path)).type;
    } catch (error) {
      await ctx.stderr.write(`chown: cannot access '${file}': ${strerror(error)}\n`);
      exitCode = 1;
      continue;
    }
    try {
      (await apply(path, type));
    } catch (error) {
      await ctx.stderr.write(`chown: changing ownership of '${file}': ${strerror(error)}\n`);
      exitCode = 1;
    }
  }
  return exitCode;
};

export default command;
