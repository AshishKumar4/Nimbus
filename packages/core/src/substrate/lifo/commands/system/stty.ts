import type { Command } from '../types.js';

const COOKED_STATE = 'nimbus-cooked';
const RAW_STATE = 'nimbus-raw';

const command: Command = async (ctx) => {
  if (!ctx.isFdTerminal?.(0) || !ctx.setRawMode) {
    ctx.stderr.write('stty: standard input: Inappropriate ioctl for device\n');
    return 1;
  }

  if (ctx.args.length === 0) {
    ctx.stdout.write(`${ctx.getRawMode?.() ? 'raw' : 'cooked'}\n`);
    return 0;
  }

  if (ctx.args.length === 1 && ctx.args[0] === '-g') {
    ctx.stdout.write(`${ctx.getRawMode?.() ? RAW_STATE : COOKED_STATE}\n`);
    return 0;
  }

  let setRaw = false;
  let setCooked = false;

  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    switch (arg) {
      case RAW_STATE:
      case 'raw':
      case '-icanon':
      case '-echo':
      case 'cbreak':
        setRaw = true;
        break;
      case COOKED_STATE:
      case 'sane':
      case 'cooked':
      case 'icanon':
      case 'echo':
        setCooked = true;
        break;
      case 'min':
      case 'time':
        if (i + 1 >= ctx.args.length || !isUnsignedInteger(ctx.args[i + 1])) {
          ctx.stderr.write(`stty: invalid argument '${arg}'\n`);
          return 1;
        }
        i++;
        break;
      default:
        ctx.stderr.write(`stty: invalid argument '${arg}'\n`);
        return 1;
    }
  }

  ctx.setRawMode(setRaw && !setCooked);
  return 0;
};

function isUnsignedInteger(value: string): boolean {
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

export default command;
