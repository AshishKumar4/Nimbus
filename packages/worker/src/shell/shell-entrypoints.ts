import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
import type { CommandRunAsHost, TerminalInputStream } from '../substrate/lifo/commands/types.js';
import type { VfsCred } from '../runtime/os-contracts.js';
import type { VFS } from '../substrate/lifo/kernel/vfs/index.js';
import { resolveVfsPath } from '../vfs/path.js';
import { parseShellInvocation, type ShellInvocationOptions, type ShellName } from './shell-invocation.js';

type Output = { write(s: string): void };

type ShellCommandContext = {
  args?: string[];
  stdout: Output;
  stderr: Output;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: unknown;
  terminalStdin?: TerminalInputStream;
  isFdTerminal?: (fd: number) => boolean;
  pid: number;
  cred: VfsCred;
  setUmask(mask: number): void;
  runAs(cred: VfsCred, argv: string[]): Promise<number>;
  vfs: VFS;
};

export type ShellEntrypointExecutor = {
  execute(cmd: string, options?: {
    cwd?: string;
    env?: Record<string, string>;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
    stdin?: string;
    terminalStdin?: TerminalInputStream;
    runExitTrap?: boolean;
    isolateShellState?: boolean;
    shellOptions?: ShellInvocationOptions;
    scriptMode?: boolean;
    terminalFds?: {
      stdin?: boolean;
      stdout?: boolean;
      stderr?: boolean;
    };
    commandContext?: Record<string, unknown>;
    runAs?: CommandRunAsHost;
  }): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
};

type RegistryLike = {
  has(name: string): boolean;
  register(name: string, handler: (ctx: ShellCommandContext) => Promise<number>): void;
};

type ParsedProgram =
  | { kind: 'command'; body: string; argv0: string; args: string[]; options: ShellInvocationOptions }
  | { kind: 'script'; body: string; path: string; argv0: string; args: string[]; options: ShellInvocationOptions }
  | { kind: 'stdin'; body: string; argv0: string; args: string[]; options: ShellInvocationOptions };

type ParseResult = ParsedProgram | { error: string; exitCode: number };

const SHELL_ALIASES = {
  sh: ['sh', '/bin/sh', '/usr/bin/sh'],
  bash: ['bash', '/bin/bash', '/usr/bin/bash'],
} as const;

export function registerShellEntrypointCommands(
  registry: RegistryLike,
  shell: ShellEntrypointExecutor,
  vfs: CredentialedVfs,
): void {
  const sh = makeShellEntrypoint('sh', shell, vfs);
  const bash = makeShellEntrypoint('bash', shell, vfs);
  for (const name of SHELL_ALIASES.sh) {
    if (!registry.has(name)) registry.register(name, sh);
  }
  for (const name of SHELL_ALIASES.bash) {
    if (!registry.has(name)) registry.register(name, bash);
  }
}

function makeShellEntrypoint(
  shellName: ShellName,
  shell: ShellEntrypointExecutor,
  vfs: CredentialedVfs,
): (ctx: ShellCommandContext) => Promise<number> {
  return async (ctx) => {
    const argv = normalizeArgs(ctx.args);
    if (argv.includes('--version')) {
      ctx.stdout.write(shellName === 'bash'
        ? 'Nimbus bash-compatible shell engine\n'
        : 'Nimbus POSIX sh-compatible shell engine\n');
      return 0;
    }
    if (argv.includes('--help')) {
      ctx.stdout.write(`usage: ${shellName} [-c command] [script]\n`);
      ctx.stdout.write('Executes commands through the Nimbus shell engine with VFS-backed stdin and scripts.\n');
      return 0;
    }

    const program = await parseShellProgram(shellName, ctx, ctx.vfs);
    if ('error' in program) {
      if (program.error) ctx.stderr.write(program.error + '\n');
      return program.exitCode;
    }

    let forwardedStdout = '';
    let forwardedStderr = '';
    const inheritedStdin = await resolveInheritedStdin(shellName, program, ctx);
    if ('error' in inheritedStdin) {
      ctx.stderr.write(inheritedStdin.error + '\n');
      return inheritedStdin.exitCode;
    }
    const result = await shell.execute(program.body, {
      cwd: ctx.cwd || '/home/user',
      env: shellEnvWithPositionals(ctx.env, program.argv0, program.args),
      isolateShellState: true,
      shellOptions: program.options,
      scriptMode: true,
      stdin: inheritedStdin.stdin,
      terminalStdin: ctx.terminalStdin,
      onStdout: (data) => {
        forwardedStdout += data;
        ctx.stdout.write(data);
      },
      onStderr: (data) => {
        forwardedStderr += data;
        ctx.stderr.write(data);
      },
      runExitTrap: true,
      terminalFds: {
        stdin: ctx.isFdTerminal?.(0) ?? false,
        stdout: ctx.isFdTerminal?.(1) ?? false,
        stderr: ctx.isFdTerminal?.(2) ?? false,
      },
      commandContext: {
        pid: ctx.pid,
        cred: ctx.cred,
        setUmask: ctx.setUmask,
      },
      runAs: (_parent, cred, argv) => ctx.runAs(cred, argv),
    });
    writeUnforwarded(ctx.stdout, result.stdout, forwardedStdout);
    writeUnforwarded(ctx.stderr, result.stderr, forwardedStderr);
    return result.exitCode;
  };
}

async function resolveInheritedStdin(
  shellName: ShellName,
  program: ParsedProgram,
  ctx: ShellCommandContext,
): Promise<{ stdin?: string } | { error: string; exitCode: number }> {
  if (program.kind === 'stdin') return { stdin: '' };
  if (ctx.isFdTerminal?.(0) !== false) return {};
  try {
    return { stdin: await readContextStdin(ctx.stdin) };
  } catch (e: unknown) {
    return { error: `${shellName}: failed to read stdin: ${formatError(e)}`, exitCode: 1 };
  }
}

async function parseShellProgram(
  shellName: ShellName,
  ctx: ShellCommandContext,
  vfs: Pick<CredentialedVfs, 'exists' | 'readFileString'>,
): Promise<ParseResult> {
  const parsed = parseShellInvocation(shellName, ctx.args);
  if (!parsed.ok) {
    if (parsed.exitCode !== 0) return { error: parsed.error, exitCode: parsed.exitCode };
    let stdin = '';
    try {
      stdin = await readContextStdin(ctx.stdin);
    } catch (e: unknown) {
      return { error: `${shellName}: failed to read stdin: ${formatError(e)}`, exitCode: 1 };
    }
    if (stdin.length > 0) return { kind: 'stdin', body: stdin, argv0: shellName, args: [], options: {} };
    return { error: parsed.error, exitCode: parsed.exitCode };
  }

  if (parsed.invocation.kind === 'command') {
    const { argv0, args } = commandPositionals(shellName, parsed.invocation.args);
    return {
      kind: 'command',
      body: parsed.invocation.body,
      argv0,
      args,
      options: parsed.invocation.options,
    };
  }
  if (parsed.invocation.kind === 'script') {
    return loadScript(
      shellName,
      parsed.invocation.path,
      parsed.invocation.args,
      parsed.invocation.options,
      ctx.cwd,
      vfs,
    );
  }

  let stdin = '';
  try {
    stdin = await readContextStdin(ctx.stdin);
  } catch (e: unknown) {
    return { error: `${shellName}: failed to read stdin: ${formatError(e)}`, exitCode: 1 };
  }
  return { kind: 'stdin', body: stdin, argv0: shellName, args: parsed.invocation.args, options: parsed.invocation.options };
}

function loadScript(
  shellName: ShellName,
  script: string,
  args: string[],
  options: ShellInvocationOptions,
  cwd: string | undefined,
  vfs: Pick<CredentialedVfs, 'exists' | 'readFileString'>,
): ParseResult {
  const path = resolveVfsPath(script, cwd || '/home/user');
  try {
    if (!vfs.exists(path)) return { error: `${shellName}: ${script}: No such file or directory`, exitCode: 127 };
    return { kind: 'script', path, body: vfs.readFileString(path), argv0: script, args, options };
  } catch (error: unknown) {
    if (hasErrorCode(error, 'EACCES') || hasErrorCode(error, 'EPERM')) {
      return { error: `${shellName}: ${script}: Permission denied`, exitCode: 126 };
    }
    return { error: `${shellName}: ${script}: ${formatError(error)}`, exitCode: 1 };
  }
}

async function readContextStdin(stdin: unknown): Promise<string> {
  if (typeof stdin === 'string') return stdin;
  if (!stdin || typeof stdin !== 'object') return '';
  if (hasReadAll(stdin)) {
    return stdinChunkToString(await stdin.readAll());
  }
  if (hasRead(stdin)) {
    const chunks: string[] = [];
    while (true) {
      const chunk = await stdin.read();
      if (chunk === null || chunk === undefined) break;
      chunks.push(stdinChunkToString(chunk));
    }
    return chunks.join('');
  }
  return '';
}

function commandPositionals(shellName: ShellName, args: string[]): { argv0: string; args: string[] } {
  const [argv0, ...positionals] = args;
  return { argv0: argv0 ?? shellName, args: positionals };
}

function shellEnvWithPositionals(
  baseEnv: Record<string, string> | undefined,
  argv0: string,
  args: string[],
): Record<string, string> {
  const env = { ...(baseEnv || {}) };
  for (const key of Object.keys(env)) {
    if (key === '@' || key === '#' || isPositionalKey(key)) delete env[key];
  }
  env['0'] = argv0;
  env['#'] = String(args.length);
  env['@'] = args.join(' ');
  for (let i = 0; i < args.length; i++) {
    env[String(i + 1)] = args[i];
  }
  return env;
}

function isPositionalKey(key: string): boolean {
  if (key.length === 0) return false;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

type ReadAllStdin = { readAll(): unknown };
type ReadStdin = { read(): unknown };

function hasReadAll(value: object): value is ReadAllStdin {
  return 'readAll' in value && typeof value.readAll === 'function';
}

function hasRead(value: object): value is ReadStdin {
  return 'read' in value && typeof value.read === 'function';
}

function stdinChunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk);
  if (chunk instanceof ArrayBuffer) return new TextDecoder().decode(chunk);
  return String(chunk);
}

function normalizeArgs(args: string[] | undefined): string[] {
  return Array.isArray(args) ? args.map(String) : [];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function writeUnforwarded(output: Output, returned: string | undefined, forwarded: string): void {
  if (!returned) return;
  if (!forwarded) {
    output.write(returned);
    return;
  }
  if (returned.length > forwarded.length && returned.startsWith(forwarded)) {
    output.write(returned.slice(forwarded.length));
  }
}
