/**
 * node's command line, read as Node reads it (src/node_options.cc
 * OptionsParser::Parse), the one reading of it the runtime registry, the
 * runner and the shims take: the options before the program, each named as
 * Node's own table names it (node-cli-options.generated.ts, from host
 * Node's internal/options and `node --v8-options`), and NODE_OPTIONS beside
 * them, split as Node splits it.
 *
 * As Node takes them:
 *   - `--name=value` only for long options (`-C=x` is an option named
 *     `-C=x`), `_` read as `-` in a long option's name;
 *   - aliases expanded (`-C` is `--conditions`, `-pe` is `--print --eval`,
 *     `-p <code>` is `--print --eval <code>`);
 *   - a value taken from `=`, else from the next argument, which may not
 *     start with `-` (a leading `\-` escapes one, and is dropped); an empty
 *     `--name=` is refused;
 *   - `--no-<name>` only for a boolean option;
 *   - an option Node does not know goes to V8, which refuses one it does not
 *     know either ("bad option");
 *   - `--` ends the options, and is kept out of execArgv;
 *   - in NODE_OPTIONS, `--` and every option Node does not allow there are
 *     refused, and a bare word ends the options it is read for.
 * A refusal is Node's: its message and exit code 9.
 */

import {
  NODE_BOOLEAN_OPTIONS, NODE_ENV_OPTIONS, NODE_KNOWN_OPTIONS, NODE_OPTION_ALIASES, NODE_V8_FLAGS, NODE_VALUE_OPTIONS,
} from './node-cli-options.generated.js';

/** What node's command line says, for the program it runs. */
export interface NodeCommandLine {
  /** The options before the program, as `process.execArgv` holds them (the command line's; not NODE_OPTIONS'). */
  execArgv: string[];
  /** Where the program's own arguments start: its script (or `-`), or, for `-e`, its arguments; their end when there are none. */
  programIndex: number;
  /** The program's own conditions: NODE_OPTIONS' first, then the command line's. */
  conditions: string[];
  /** `-e`/`--eval`'s code (`process._eval`), when the program is one. */
  eval?: string;
  /** `-p`/`--print`: the eval's result is printed. */
  print: boolean;
  version: boolean;
  help: boolean;
}

/** A command line Node refuses: what it prints, and its exit code (9, Node's for a bad option). */
export interface NodeCommandLineError {
  error: string;
  exitCode: 9;
}

const refuse = (message: string): NodeCommandLineError => ({ error: `node: ${message}\n`, exitCode: 9 });

/** Whether NODE_OPTIONS may carry the option named `name` (a long one's `=value` aside), a `--no-` prefix aside. */
function allowedInNodeOptions(name: string): boolean {
  return NODE_ENV_OPTIONS.has(name) || (name.startsWith('--no-') && NODE_ENV_OPTIONS.has('--' + name.slice(5)));
}

/** NODE_OPTIONS split as Node splits it (ParseNodeOptionsEnvVar): spaces part, double quotes group, `\` escapes inside them. */
export function splitNodeOptions(text: string): string[] | NodeCommandLineError {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '\\' && i + 1 < text.length) {
      current += text[++i];
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      inToken = true;
      continue;
    }
    if (c === ' ' && !quoted) {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
      continue;
    }
    current += c;
    inToken = true;
  }
  if (quoted) return refuse('invalid value for NODE_OPTIONS (unterminated string)');
  if (inToken) tokens.push(current);
  return tokens;
}

/** Whether V8 takes `option` (an option Node's table does not have): its name, `_` or `-`, one or two dashes, `--no-` for a flag. */
function v8Takes(option: string): boolean {
  const name = option.replace(/^--?/, '').split('=')[0].replaceAll('_', '-');
  return NODE_V8_FLAGS.has(name) || (name.startsWith('no-') && NODE_V8_FLAGS.has(name.slice(3)));
}

/** What the options of `tokens` (one command line, or NODE_OPTIONS' words) set. */
interface ReadOptions {
  conditions: string[];
  eval?: string;
  print: boolean;
  version: boolean;
  help: boolean;
  /** Where they end in `tokens` (past a `--`). */
  end: number;
}

/** The options at the head of `tokens`, as Node's OptionsParser reads them; `env` for NODE_OPTIONS'. */
function readOptions(tokens: readonly string[], env: boolean): ReadOptions | NodeCommandLineError {
  const read: ReadOptions = { conditions: [], print: false, version: false, help: false, end: 0 };
  // An alias's expansion past its first option, read before the next argument.
  const pending: string[] = [];
  let i = 0;
  const hasNext = () => pending.length > 0 || i < tokens.length;
  const peek = () => (pending.length > 0 ? pending[0] : tokens[i]);
  const take = () => (pending.length > 0 ? pending.shift()! : tokens[i++]);
  while (hasNext()) {
    const fromLine = pending.length === 0;
    const arg = peek();
    if (fromLine && (arg.length <= 1 || arg[0] !== '-')) break;
    take();
    if (arg === '--') {
      if (env) return refuse('-- is not allowed in NODE_OPTIONS');
      break;
    }
    let name = arg;
    let value: string | undefined;
    let hasEquals = false;
    // Only a long option takes `=value`, and its name reads `_` as `-`.
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      if (equals !== -1) {
        name = arg.slice(0, equals);
        value = arg.slice(equals + 1);
        hasEquals = true;
      }
      name = '--' + name.slice(2).replaceAll('_', '-');
    }
    if (env && !allowedInNodeOptions(name)) return refuse(`${hasEquals ? `${name}=` : name} is not allowed in NODE_OPTIONS`);
    const typed = name;
    for (;;) {
      let expansion = NODE_OPTION_ALIASES.get(name);
      if (expansion === undefined && hasEquals) expansion = NODE_OPTION_ALIASES.get(`${name}=`);
      if (expansion === undefined && hasNext() && !peek().startsWith('-')) expansion = NODE_OPTION_ALIASES.get(`${name} <arg>`);
      if (expansion === undefined) break;
      name = expansion[0];
      pending.unshift(...expansion.slice(1));
    }
    if (!NODE_KNOWN_OPTIONS.has(name)) {
      const negated = name.startsWith('--no-') ? '--' + name.slice(5) : null;
      if (negated !== null && NODE_KNOWN_OPTIONS.has(negated)) {
        if (!NODE_BOOLEAN_OPTIONS.has(negated)) return refuse(`${arg} is an invalid negation because it is not a boolean option`);
        continue;
      }
      // Not Node's: V8's (one argument; its value only after `=`), or a bad option.
      if (!v8Takes(arg)) return refuse(`bad option: ${arg}`);
      continue;
    }
    if (NODE_VALUE_OPTIONS.has(name)) {
      if (hasEquals) {
        if (value === '') return refuse(`${typed}= requires an argument`);
      } else {
        if (!hasNext() || peek().startsWith('-')) return refuse(`${typed} requires an argument`);
        value = take();
        if (value.startsWith('\\-')) value = value.slice(1);
      }
    }
    switch (name) {
      case '--conditions': read.conditions.push(value!); break;
      case '--eval': read.eval = value; break;
      case '--print': read.print = true; break;
      case '--version': read.version = true; break;
      case '--help': read.help = true; break;
    }
  }
  read.end = i;
  return read;
}

/** node's `args` (after `node` itself) and its NODE_OPTIONS, read as Node reads them. */
export function parseNodeCommandLine(args: readonly string[], nodeOptions = ''): NodeCommandLine | NodeCommandLineError {
  const envTokens = splitNodeOptions(nodeOptions);
  if ('error' in envTokens) return envTokens;
  const fromEnv = readOptions(envTokens, true);
  if ('error' in fromEnv) return fromEnv;
  const fromArgs = readOptions(args, false);
  if ('error' in fromArgs) return fromArgs;
  // The options before the program, but the `--` that ended them.
  const options = args.slice(0, fromArgs.end);
  return {
    execArgv: options.at(-1) === '--' ? options.slice(0, -1) : options,
    programIndex: fromArgs.end,
    conditions: [...fromEnv.conditions, ...fromArgs.conditions],
    ...(fromArgs.eval !== undefined ? { eval: fromArgs.eval } : {}),
    print: fromArgs.print || fromEnv.print,
    version: fromArgs.version,
    help: fromArgs.help,
  };
}
