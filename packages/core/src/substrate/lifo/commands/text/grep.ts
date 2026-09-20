import type { Command } from '../types.js';
import { resolve } from '../../utils/path.js';
import { VFSError } from '../../kernel/vfs/index.js';
import { getMimeType, isBinaryMime } from '../../utils/mime.js';

const command: Command = async (ctx) => {
  const args = ctx.args;
  let ignoreCase = false;
  let invert = false;
  let lineNumbers = false;
  let countOnly = false;
  let filesWithMatches = false;
  let recursive = false;
  let wordMatch = false;
  let pattern = '';
  const files: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') { i++; break; }
    if (arg.startsWith('-') && arg.length > 1 && arg[1] !== '-') {
      for (let j = 1; j < arg.length; j++) {
        switch (arg[j]) {
          case 'i': ignoreCase = true; break;
          case 'v': invert = true; break;
          case 'n': lineNumbers = true; break;
          case 'c': countOnly = true; break;
          case 'l': filesWithMatches = true; break;
          case 'r': recursive = true; break;
          case 'E': break; // JS regex is already ERE
          case 'w': wordMatch = true; break;
        }
      }
      i++;
    } else if (!pattern) {
      pattern = arg;
      i++;
    } else {
      break;
    }
  }

  while (i < args.length) {
    files.push(args[i++]);
  }

  if (!pattern) {
    await ctx.stderr.write('grep: missing pattern\n');
    return 2;
  }

  let regexPattern = pattern;
  if (wordMatch) {
    regexPattern = `\\b${regexPattern}\\b`;
  }

  let regex: RegExp;
  try {
    regex = new RegExp(regexPattern, ignoreCase ? 'i' : '');
  } catch {
    await ctx.stderr.write(`grep: invalid regex: ${pattern}\n`);
    return 2;
  }

  let matched = false;
  const multiFile = files.length > 1 || recursive;

  async function grepLines(lines: string[], fileName: string | null): Promise<void> {
    let count = 0;
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const matches = regex.test(line);
      if (matches !== invert) {
        matched = true;
        count++;
        if (filesWithMatches) {
          if (fileName) await ctx.stdout.write(fileName + '\n');
          return;
        }
        if (!countOnly) {
          let output = '';
          if (multiFile && fileName) output += fileName + ':';
          if (lineNumbers) output += (idx + 1) + ':';
          output += line + '\n';
          await ctx.stdout.write(output);
        }
      }
    }
    if (countOnly) {
      let output = '';
      if (multiFile && fileName) output += fileName + ':';
      output += count + '\n';
      await ctx.stdout.write(output);
    }
  }

  async function walkDir(dirPath: string): Promise<string[]> { const result: string[] = [];
  try {
    const entries = (await ctx.vfs.readdir(dirPath));
    for (const entry of entries) {
      const fullPath = dirPath === '/' ? '/' + entry.name : dirPath + '/' + entry.name;
      if (entry.type === 'file') {
        result.push(fullPath);
      } else if (entry.type === 'directory') {
        result.push(...(await walkDir(fullPath)));
      }
    }
  } catch {
    // skip inaccessible dirs
  }
  return result; }

  if (files.length === 0) {
    if (ctx.stdin) {
      const content = await ctx.stdin.readAll();
      const lines = content.replace(/\n$/, '').split('\n');
      await grepLines(lines, null);
    } else {
      await ctx.stderr.write('grep: missing file operand\n');
      return 2;
    }
  } else {
    for (const file of files) {
      const path = resolve(ctx.cwd, file);
      try {
        const stat = (await ctx.vfs.stat(path));
        if (stat.type === 'directory') {
          if (recursive) {
            const dirFiles = (await walkDir(path));
            for (const f of dirFiles) {
              try {
                if (isBinaryMime(getMimeType(f))) {
                  continue;
                }
                const content = (await ctx.vfs.readFileString(f));
                const lines = content.replace(/\n$/, '').split('\n');
                await grepLines(lines, f);
              } catch {
                // skip unreadable files
              }
            }
          } else {
            await ctx.stderr.write(`grep: ${file}: Is a directory\n`);
          }
          continue;
        }
        if (isBinaryMime(getMimeType(path))) {
          await ctx.stderr.write(`grep: ${file}: binary file, skipping\n`);
          continue;
        }
        const content = (await ctx.vfs.readFileString(path));
        const lines = content.replace(/\n$/, '').split('\n');
        await grepLines(lines, multiFile ? file : null);
      } catch (e) {
        if (e instanceof VFSError) {
          await ctx.stderr.write(`grep: ${file}: ${e.message}\n`);
        } else {
          throw e;
        }
      }
    }
  }

  return matched ? 0 : 1;
};

export default command;
