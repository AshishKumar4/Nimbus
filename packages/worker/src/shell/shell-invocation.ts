export type ShellName = 'sh' | 'bash';

export type ShellInvocationOptions = {
  errexit?: boolean;
  nounset?: boolean;
  pipefail?: boolean;
};

export type ShellInvocation =
  | { kind: 'command'; body: string; args: string[]; options: ShellInvocationOptions }
  | { kind: 'script'; path: string; args: string[]; options: ShellInvocationOptions }
  | { kind: 'stdin'; args: string[]; options: ShellInvocationOptions }
  /** `--help` / `--version` given as an option to the shell, not to a script. */
  | { kind: 'usage'; topic: 'help' | 'version' };

export type ShellInvocationParseResult =
  | { ok: true; invocation: ShellInvocation }
  | { ok: false; error: string; exitCode: number };

type OptionClusterParseResult =
  | { ok: true; consumed: number; invocation?: ShellInvocation }
  | { ok: false; error: string; exitCode: number };

const MODE_FLAGS = new Set(['e', 'u', 'l']);
const VALUE_FLAGS = new Set(['o']);
const LONG_MODE_FLAGS = new Set([
  '--login',
  '--noprofile',
  '--norc',
  '--posix',
  '--restricted',
]);

export function parseShellInvocation(shellName: ShellName, rawArgs: string[] | undefined): ShellInvocationParseResult {
  const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
  let readFromStdin = false;
  const options: ShellInvocationOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      if (readFromStdin) {
        return { ok: true, invocation: { kind: 'stdin', args: args.slice(i + 1), options: { ...options } } };
      }
      const script = args[i + 1];
      if (!script) break;
      return {
        ok: true,
        invocation: { kind: 'script', path: script, args: args.slice(i + 2), options: { ...options } },
      };
    }
    if (arg === '-c') {
      return commandFromNextArg(shellName, args, i, options);
    }
    if (arg === '-s' || arg === '-') {
      readFromStdin = true;
      continue;
    }
    if (arg === '-o') {
      if (args[i + 1] === undefined) return error(shellName, '-o requires an argument', 2);
      const option = args[i + 1];
      if (!applyShellOption(shellName, option, true, options)) {
        return error(shellName, `unsupported option: -o ${option}`, 2);
      }
      i++;
      continue;
    }
    if (arg.length === 2 && arg.startsWith('-') && MODE_FLAGS.has(arg[1])) {
      applyShellFlag(arg[1], true, options);
      continue;
    }
    // Only the shell's own options, so `bash script --help` passes --help to
    // the script the way every installer expects.
    if (arg === '--help') return { ok: true, invocation: { kind: 'usage', topic: 'help' } };
    if (arg === '--version') return { ok: true, invocation: { kind: 'usage', topic: 'version' } };
    if (LONG_MODE_FLAGS.has(arg)) continue;
    if (arg.startsWith('--')) return error(shellName, `unsupported option: ${arg}`, 2);
    if (isOptionCluster(arg)) {
      const parsed = parseOptionCluster(shellName, args, i, options);
      if (!parsed.ok) return parsed;
      i += parsed.consumed;
      if (parsed.invocation?.kind === 'command') return { ok: true, invocation: parsed.invocation };
      if (parsed.invocation?.kind === 'stdin') {
        readFromStdin = true;
        continue;
      }
      continue;
    }
    if (arg.startsWith('-')) return error(shellName, `unsupported option: ${arg}`, 2);
    if (readFromStdin) {
      return { ok: true, invocation: { kind: 'stdin', args: args.slice(i), options: { ...options } } };
    }
    return { ok: true, invocation: { kind: 'script', path: arg, args: args.slice(i + 1), options: { ...options } } };
  }

  return readFromStdin
    ? { ok: true, invocation: { kind: 'stdin', args: [], options: { ...options } } }
    : error(shellName, `already running inside the Nimbus interactive shell; use '${shellName} -c <command>' or pipe a script`, 0);
}

function parseOptionCluster(
  shellName: ShellName,
  args: string[],
  index: number,
  options: ShellInvocationOptions,
): OptionClusterParseResult {
  const cluster = args[index];
  for (let i = 1; i < cluster.length; i++) {
    const flag = cluster[i];
    if (flag === 'c') {
      const parsed = commandFromNextArg(shellName, args, index, options);
      if (parsed.ok) return { ok: true, consumed: 1, invocation: parsed.invocation };
      return { ok: false, error: parsed.error, exitCode: parsed.exitCode };
    }
    if (flag === 's') return { ok: true, consumed: 0, invocation: { kind: 'stdin', args: [], options: { ...options } } };
    if (VALUE_FLAGS.has(flag)) {
      const option = i === cluster.length - 1 ? args[index + 1] : cluster.slice(i + 1);
      if (option === undefined) {
        return { ok: false, error: `${shellName}: -${flag} requires an argument`, exitCode: 2 };
      }
      if (!applyShellOption(shellName, option, true, options)) {
        return { ok: false, error: `${shellName}: unsupported option: -o ${option}`, exitCode: 2 };
      }
      return { ok: true, consumed: i === cluster.length - 1 ? 1 : 0 };
    }
    if (MODE_FLAGS.has(flag)) {
      applyShellFlag(flag, true, options);
      continue;
    }
    return { ok: false, error: `${shellName}: unsupported option: -${flag}`, exitCode: 2 };
  }
  return { ok: true, consumed: 0 };
}

function commandFromNextArg(
  shellName: ShellName,
  args: string[],
  index: number,
  options: ShellInvocationOptions,
): ShellInvocationParseResult {
  const command = args[index + 1];
  if (command === undefined) return error(shellName, '-c requires an argument', 2);
  return {
    ok: true,
    invocation: { kind: 'command', body: command, args: args.slice(index + 2), options: { ...options } },
  };
}

function error(shellName: ShellName, message: string, exitCode: number): ShellInvocationParseResult {
  return { ok: false, error: `${shellName}: ${message}`, exitCode };
}

function isOptionCluster(arg: string): boolean {
  return arg.length > 2 && arg[0] === '-' && arg !== '--';
}

function applyShellFlag(flag: string, enabled: boolean, options: ShellInvocationOptions): void {
  if (flag === 'e') options.errexit = enabled;
  if (flag === 'u') options.nounset = enabled;
}

function applyShellOption(
  _shellName: ShellName,
  option: string,
  enabled: boolean,
  options: ShellInvocationOptions,
): boolean {
  switch (option) {
    case 'errexit':
      options.errexit = enabled;
      return true;
    case 'nounset':
      options.nounset = enabled;
      return true;
    case 'pipefail':
      options.pipefail = enabled;
      return true;
    default:
      return false;
  }
}
