import type { Command } from '../commands/types.js';
import type { VFS } from '../kernel/vfs/index.js';

export type DefaultShell = 'lifo' | 'bash';

export function defaultShellPath(home: string): string {
  const normalizedHome = (home || '/home/user').replace(/\/+$/, '');
  return `${normalizedHome}/.config/nimbus/shell`;
}

export function readDefaultShell(vfs: Pick<VFS, 'readFileString'>, home: string): DefaultShell {
  try {
    return vfs.readFileString(defaultShellPath(home)).trim() === 'bash' ? 'bash' : 'lifo';
  } catch {
    return 'lifo';
  }
}

function writeDefaultShell(vfs: VFS, home: string, shell: DefaultShell): void {
  const path = defaultShellPath(home);
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (!vfs.exists(parent)) vfs.mkdir(parent, { recursive: true });
  vfs.writeFile(path, `${shell}\n`);
}

export function makeChshCommand(deps: {
  isBashInstalled(home: string): boolean;
}): Command {
  return async (ctx) => {
    const home = ctx.env.HOME || '/home/user';
    if (ctx.args.length === 0) {
      ctx.stdout.write(`${readDefaultShell(ctx.vfs, home)}\n`);
      return 0;
    }
    if (ctx.args.length !== 2 || ctx.args[0] !== '-s') {
      ctx.stderr.write('usage: chsh [-s bash|lifo|sh]\n');
      return 2;
    }

    const requested = ctx.args[1];
    const shell: DefaultShell | null =
      requested === 'bash' ? 'bash' :
      requested === 'lifo' || requested === 'sh' ? 'lifo' :
      null;
    if (shell === null) {
      ctx.stderr.write(`chsh: unsupported shell '${requested}' (expected bash, lifo, or sh)\n`);
      return 2;
    }
    if (shell === 'bash' && !deps.isBashInstalled(home)) {
      ctx.stderr.write("chsh: bash is not installed (run 'nimbus install bash')\n");
      return 1;
    }

    try {
      writeDefaultShell(ctx.vfs, home, shell);
      ctx.stdout.write(`default shell: ${shell}\n`);
      return 0;
    } catch (error: unknown) {
      ctx.stderr.write(`chsh: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  };
}
