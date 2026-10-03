import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { isVfsError } from '../../../../vfs/vfs-error.js';
import { statOrThrow } from '../../../../vfs/vfs.js';
import { direntTypeIn } from '../../../../vfs/dirent-type.js';

const command: Command = async (ctx) => {
  let maxDepth = Infinity;
  let dirsOnly = false;
  let targetPath = '.';

  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if (arg === '-L' && i + 1 < ctx.args.length) {
      maxDepth = parseInt(ctx.args[++i], 10);
    } else if (arg === '-d') {
      dirsOnly = true;
    } else if (!arg.startsWith('-')) {
      targetPath = arg;
    }
  }

  const absPath = resolve(ctx.cwd, targetPath);
  let dirCount = 0;
  let fileCount = 0;

  async function printTree(dirPath: string, prefix: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    try {
      const listed = await Promise.all((await ctx.vfs.readdir(dirPath)).map(async (entry) => ({
        name: entry.name,
        type: await direntTypeIn(ctx.vfs, dirPath, entry),
      })));
      const filtered = dirsOnly
        ? listed.filter((e) => e.type === 'directory')
        : listed;
      const sorted = filtered.sort((a, b) => a.name.localeCompare(b.name));

      for (let i = 0; i < sorted.length; i++) {
        const entry = sorted[i];
        const isLast = i === sorted.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        await ctx.stdout.write(prefix + connector + entry.name + '\n');

        if (entry.type === 'directory') {
          dirCount++;
          const newPrefix = prefix + (isLast ? '    ' : '│   ');
          const fullPath = dirPath === '/' ? '/' + entry.name : dirPath + '/' + entry.name;
          await printTree(fullPath, newPrefix, depth + 1);
        } else {
          fileCount++;
        }
      }
    } catch {
      // skip inaccessible dirs
    }
  }

  try {
    (await statOrThrow(ctx.vfs, absPath));
  } catch (e) {
    if (isVfsError(e)) {
      await ctx.stderr.write(`tree: '${targetPath}': ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  await ctx.stdout.write(targetPath + '\n');
  await printTree(absPath, '', 1);

  const summary = dirsOnly
    ? `\n${dirCount} directories\n`
    : `\n${dirCount} directories, ${fileCount} files\n`;
  await ctx.stdout.write(summary);

  return 0;
};

export default command;
