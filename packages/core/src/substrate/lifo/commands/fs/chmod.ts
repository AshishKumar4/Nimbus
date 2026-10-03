import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { isVfsError, strerror } from '../../../../vfs/vfs-error.js';
import { statOrThrow } from '../../../../vfs/vfs.js';
import { adjustMode, compileMode } from '../../utils/mode-change.js';

const command: Command = async (ctx) => {
  let recursive = false;
  let modeStr = '';
  const files: string[] = [];

  for (const arg of ctx.args) {
    if (!modeStr && (arg === '-R' || arg === '-r' || arg === '--recursive')) {
      recursive = true;
    } else if (!modeStr) {
      modeStr = arg;
    } else {
      files.push(arg);
    }
  }

  if (!modeStr || files.length === 0) {
    await ctx.stderr.write('chmod: missing operand\n');
    return 1;
  }

  const spec = compileMode(modeStr);
  if (!spec) {
    await ctx.stderr.write(`chmod: invalid mode: '${modeStr}'\n`);
    return 1;
  }

  let exitCode = 0;

  const applyChmod = async (filePath: string): Promise<void> => {
    const st = (await statOrThrow(ctx.vfs, filePath));
    // No umask: a clause without a who applies to everyone.
    (await ctx.vfs.chmod(filePath, adjustMode(st.mode, st.type === 'directory', 0, spec)));
    if (recursive && st.type === 'directory') {
      for (const entry of (await ctx.vfs.readdir(filePath))) {
        (await applyChmod(filePath === '/' ? '/' + entry.name : filePath + '/' + entry.name));
      }
    }
  };

  for (const file of files) {
    try {
      (await applyChmod(resolve(ctx.cwd, file)));
    } catch (e) {
      // GNU's words: a name that is not there cannot be accessed; a change
      // the filesystem refuses is a change of permissions that failed.
      const what = isVfsError(e, 'ENOENT') || isVfsError(e, 'ENOTDIR') ? 'cannot access' : 'changing permissions of';
      await ctx.stderr.write(`chmod: ${what} '${file}': ${strerror(e)}\n`);
      exitCode = 1;
    }
  }

  return exitCode;
};

export default command;
