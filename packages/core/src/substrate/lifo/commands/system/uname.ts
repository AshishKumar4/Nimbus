import type { Command } from '../types.js';

/**
 * Nimbus presents a Linux system: the syscall surface, the filesystem layout
 * and the binaries that run on it are Linux's. Third-party install scripts
 * gate on `uname -s` (`case "$(uname -s)" in Linux|Darwin)`), so anything else
 * here makes every one of them refuse to install. The machine stays honest —
 * the code that runs is wasm, not x86_64.
 */
const INFO = {
  sysname: 'Linux',
  nodename: 'nimbus',
  release: '1.0.0',
  version: '#1 Nimbus',
  machine: 'wasm',
  processor: 'unknown',
  platform: 'unknown',
  operatingSystem: 'GNU/Linux',
} as const;

const FIELDS = {
  s: INFO.sysname,
  n: INFO.nodename,
  r: INFO.release,
  v: INFO.version,
  m: INFO.machine,
  p: INFO.processor,
  i: INFO.platform,
  o: INFO.operatingSystem,
} as const;

const ALL_ORDER = ['s', 'n', 'r', 'v', 'm', 'o'] as const;

const command: Command = async (ctx) => {
  const selected = new Set<string>();

  for (const arg of ctx.args) {
    if (!arg.startsWith('-')) continue;
    if (arg === '--all') {
      for (const flag of ALL_ORDER) selected.add(flag);
      continue;
    }
    for (let i = 1; i < arg.length; i++) {
      if (arg[i] === 'a') for (const flag of ALL_ORDER) selected.add(flag);
      else if (arg[i] in FIELDS) selected.add(arg[i]);
    }
  }

  if (selected.size === 0) {
    ctx.stdout.write(INFO.sysname + '\n');
    return 0;
  }

  const order = (['s', 'n', 'r', 'v', 'm', 'p', 'i', 'o'] as const).filter((f) => selected.has(f));
  ctx.stdout.write(order.map((f) => FIELDS[f]).join(' ') + '\n');
  return 0;
};

export default command;
