import type { Command } from '../types.js';
import type { CommandRegistry } from '../registry.js';

/** How help groups the commands it lists; what it lists is what the shell has. */
const CATEGORIES: Record<string, string[]> = {
  'File system': [
    'ls', 'cat', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'find', 'tree',
    'stat', 'ln', 'du', 'df', 'mount', 'chmod', 'file', 'rmdir', 'realpath',
    'basename', 'dirname', 'mktemp', 'chown',
  ],
  'Text processing': [
    'grep', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr',
    'sed', 'awk', 'diff', 'nl', 'rev',
  ],
  'I/O utilities': ['tee', 'xargs', 'yes', 'printf'],
  'System': [
    'env', 'uname', 'date', 'sleep', 'uptime', 'whoami', 'hostname',
    'free', 'which', 'ps', 'top', 'kill', 'watch', 'cal', 'bc',
    'man', 'help',
  ],
  'Network': ['curl', 'wget', 'ping', 'dig'],
  'Archive': ['tar', 'gzip', 'gunzip', 'zip', 'unzip'],
  'Node.js': ['node', 'npm', 'npx', 'lifo'],
};

/**
 * help: the shell's builtins, then each category's commands the registry
 * has, then the registered commands no category names. `builtinNames` is
 * the calling shell's (Shell.builtinNames).
 */
export function createHelpCommand(registry: CommandRegistry, builtinNames: () => Iterable<string> = () => []): Command {
  return async (ctx) => {
    const categorized = new Set(Object.values(CATEGORIES).flat());
    const builtins = [...builtinNames()];
    const sections: [string, string[]][] = [
      ['Shell builtins', builtins],
      ...Object.entries(CATEGORIES).map(([category, names]): [string, string[]] => [category, names.filter((name) => registry.has(name))]),
      ['Other commands', registry.list().filter((name) => !categorized.has(name) && !builtins.includes(name))],
    ];
    await ctx.stdout.write('Lifo Commands\n');
    await ctx.stdout.write('==================\n\n');

    for (const [category, commands] of sections) {
      if (commands.length === 0) continue;
      await ctx.stdout.write(`${category}:\n`);
      // Format in columns
      const cols = 6;
      for (let i = 0; i < commands.length; i += cols) {
        const row = commands.slice(i, i + cols)
          .map(c => c.padEnd(12))
          .join('');
        await ctx.stdout.write(`  ${row}\n`);
      }
      await ctx.stdout.write('\n');
    }

    await ctx.stdout.write('Use "man <command>" for detailed help on a specific command.\n');
    return 0;
  };
}
