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

const LONG_FLAGS: Record<string, keyof typeof FIELDS> = {
  '--kernel-name': 's',
  '--nodename': 'n',
  '--kernel-release': 'r',
  '--kernel-version': 'v',
  '--machine': 'm',
  '--processor': 'p',
  '--hardware-platform': 'i',
  '--operating-system': 'o',
};

/** GNU's `-a` omits -p and -i when they are unknown, which here they always are. */
const ALL_ORDER = ['s', 'n', 'r', 'v', 'm', 'o'] as const;
const PRINT_ORDER = ['s', 'n', 'r', 'v', 'm', 'p', 'i', 'o'] as const;

const USAGE = 'Usage: uname [-asnrvmpio]\n';

const command: Command = async (ctx) => {
  const selected = new Set<string>();

  for (const arg of ctx.args) {
    if (arg === '--all') {
      for (const flag of ALL_ORDER) selected.add(flag);
      continue;
    }
    if (arg.startsWith('--')) {
      const field = LONG_FLAGS[arg];
      // A long option must be matched whole. Scanning it as a cluster of
      // short flags made `uname --bogus` pick the `o` and `s` out of the
      // word and answer "Linux GNU/Linux" to a typo.
      if (!field) {
        ctx.stderr.write(`uname: unrecognized option '${arg}'\n`);
        ctx.stderr.write(USAGE);
        return 1;
      }
      selected.add(field);
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let i = 1; i < arg.length; i++) {
        const ch = arg[i];
        if (ch === 'a') for (const flag of ALL_ORDER) selected.add(flag);
        else if (ch in FIELDS) selected.add(ch);
        else {
          // Dropping the letter left `uname -Q` printing the kernel name, so
          // a caller could not tell a typo from a supported request.
          ctx.stderr.write(`uname: invalid option -- '${ch}'\n`);
          ctx.stderr.write(USAGE);
          return 1;
        }
      }
      continue;
    }
    ctx.stderr.write(`uname: extra operand '${arg}'\n`);
    ctx.stderr.write(USAGE);
    return 1;
  }

  if (selected.size === 0) {
    ctx.stdout.write(INFO.sysname + '\n');
    return 0;
  }

  // GNU prints the selected fields in a fixed order, not the order given.
  const order = PRINT_ORDER.filter((f) => selected.has(f));
  ctx.stdout.write(order.map((f) => FIELDS[f]).join(' ') + '\n');
  return 0;
};

export default command;
