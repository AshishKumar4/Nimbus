import parseArgv from 'yargs-parser';
import { resolveVfsPath } from '@nimbus-sh/core/vfs/path.js';

/** OpenCode's default command is a TUI, even when its first operand names a project. */
export function classifyOpenCodeInvocation(argv: string[]): 'oneshot' | 'attached' | 'server' | 'dual' {
  const parsed = parseOpenCodeArgv(argv).argv;
  if (parsed.help || parsed.version) return 'oneshot';
  const sub = String(parsed._[0] ?? '');
  if (OPENCODE_SERVER_SUBCOMMANDS.has(sub)) return 'server';
  if (OPENCODE_TUI_SUBCOMMANDS.has(sub)) return 'attached';
  return OPENCODE_SUBCOMMANDS.has(sub) ? 'oneshot' : 'dual';
}

const OPENCODE_SERVER_SUBCOMMANDS = new Set(['serve', 'web']);
const OPENCODE_TUI_SUBCOMMANDS = new Set(['attach']);
const OPENCODE_SUBCOMMANDS = new Set([
  'acp', 'mcp', 'attach', 'run', 'generate', 'debug', 'console', 'providers', 'auth',
  'agent', 'upgrade', 'uninstall', 'serve', 'web', 'models', 'stats', 'export', 'import',
  'github', 'pr', 'session', 'plugin', 'plug', 'db', 'completion',
]);

// Upstream v1.16.2 uses yargs with populate--, these option types and aliases.
// Let its tokenizer own operands, = values, short groups and boolean negation.
const OC_BOOLEAN = ['help', 'version', 'print-logs', 'pure', 'continue', 'fork', 'mdns'];
const OC_STRING = ['_', 'log-level', 'model', 'prompt', 'agent', 'session', 'hostname', 'mdns-domain', 'cors'];
const OC_ALIAS = { help: ['h'], version: ['v'], model: ['m'], continue: ['c'], session: ['s'] };
export function parseOpenCodeArgv(argv: string[]) {
  return parseArgv.detailed(argv, {
    boolean: OC_BOOLEAN, string: OC_STRING, number: ['port'],
    array: ['cors'], alias: OC_ALIAS,
    configuration: { 'populate--': true },
  });
}

export type OpenCodeTransportPlan = {
  cwd: string;
  serveArgv: string[];
  attachArgv: string[];
  port?: number;
};

/** Lossless supported default-TUI options, or a named refusal before any spawn. */
export function buildOpenCodeTransportPlan(
  argv: string[], cwd: string, env: Record<string, string> = {},
): OpenCodeTransportPlan | { error: string } {
  const parsed = parseOpenCodeArgv(argv);
  if (parsed.error) return { error: parsed.error.message };
  const args = parsed.argv;
  const known = new Set([...OC_BOOLEAN, ...OC_STRING, 'port', 'cors', '--']);
  for (const key of [...known]) for (const alias of parsed.aliases[key] ?? []) known.add(alias);
  for (const key of Object.keys(args)) {
    if (!known.has(key)) return { error: `unsupported OpenCode option: ${key.length === 1 ? '-' : '--'}${key}` };
  }
  for (const key of ['model', 'prompt', 'agent']) {
    if (args[key] !== undefined) return { error: `--${key} cannot run over the remote TUI transport: OpenCode attach has no equivalent` };
  }
  if (args.mdns || args['mdns-domain'] !== undefined) {
    return { error: 'mDNS options cannot run over the remote TUI transport: service discovery is unavailable' };
  }
  if (args._.length > 1 || (args['--']?.length ?? 0) > 0) return { error: 'extra positional operands cannot run over the remote TUI transport' };
  if (args.fork && !args.continue && !args.session) return { error: '--fork requires --continue or --session' };
  const scalar = (key: string): string | undefined => {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new Error(`--${key} requires one string value`);
    return value;
  };
  try {
    const project = args._[0] === undefined ? undefined : String(args._[0]);
    const projectCwd = '/' + (project
      ? resolveVfsPath(project, resolveVfsPath(env.PWD ?? cwd, cwd)) : resolveVfsPath(cwd, '/'));
    const level = scalar('log-level');
    if (level !== undefined && !['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(level)) return { error: `invalid --log-level: ${level}` };
    const port = args.port;
    if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535)) return { error: '--port must be an integer from 0 through 65535' };
    const booleanArg = (key: string): string[] => args[key] === undefined ? []
      : args[key] ? [`--${key}`] : [`--${key}=false`];
    const globals = [
      ...booleanArg('print-logs'), ...booleanArg('pure'),
      ...(level === undefined ? [] : ['--log-level', level]),
    ];
    const session = scalar('session');
    return {
      cwd: projectCwd, port,
      // Explicit defaults prevent serve's global server config from changing
      // the default command's local-only network disposition.
      serveArgv: ['serve', '--hostname', scalar('hostname') ?? '127.0.0.1', '--mdns', 'false',
        ...globals, ...(args.cors ?? []).flatMap((domain: string) => ['--cors', domain])],
      attachArgv: [...booleanArg('continue'), ...booleanArg('fork'),
        ...(session === undefined ? [] : ['--session', session]), ...globals],
    };
  } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}
