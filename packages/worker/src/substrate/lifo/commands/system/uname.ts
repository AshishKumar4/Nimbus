import type { Command } from '../types.js';
import { parseArgs } from '../../utils/args.js';

const info = {
  sysname: 'Lifo',
  nodename: 'lifo',
  release: '1.0.0',
  version: '#1',
  machine: 'wasm',
  operatingSystem: 'Lifo',
};

const spec = {
  all: { type: 'boolean' as const, short: 'a' },
  'kernel-name': { type: 'boolean' as const, short: 's' },
  nodename: { type: 'boolean' as const, short: 'n' },
  'kernel-release': { type: 'boolean' as const, short: 'r' },
  'kernel-version': { type: 'boolean' as const, short: 'v' },
  machine: { type: 'boolean' as const, short: 'm' },
  'operating-system': { type: 'boolean' as const, short: 'o' },
};

const command: Command = async (ctx) => {
  const parsed = parseArgs('uname', ctx.args, spec);
  if (!parsed.ok) {
    ctx.stderr.write(parsed.error);
    return 1;
  }
  const { flags } = parsed;

  if (flags.all) {
    ctx.stdout.write(
      `${info.sysname} ${info.nodename} ${info.release} ${info.version} ${info.machine} ${info.operatingSystem}\n`,
    );
    return 0;
  }

  // GNU prints the selected fields in a fixed order, not the order given.
  const parts: string[] = [];
  if (flags['kernel-name']) parts.push(info.sysname);
  if (flags.nodename) parts.push(info.nodename);
  if (flags['kernel-release']) parts.push(info.release);
  if (flags['kernel-version']) parts.push(info.version);
  if (flags.machine) parts.push(info.machine);
  if (flags['operating-system']) parts.push(info.operatingSystem);

  // Selecting nothing means -s, which is also what a bare `uname` prints.
  if (parts.length === 0) parts.push(info.sysname);
  ctx.stdout.write(parts.join(' ') + '\n');

  return 0;
};

export default command;
