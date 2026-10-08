/**
 * node's command line, read as Node reads it (src/node_options.cc
 * OptionsParser::Parse), the one reading of it the runtime registry, the
 * runner and the shims take: the options before the program, each named as
 * Node's own table names it (node-cli-options.generated.ts, from host
 * Node's internal/options and `node --v8-options`), and NODE_OPTIONS beside
 * them, split as Node splits it.
 *
 * As Node takes them, in its order:
 *   - `--name=value` only for long options (`-C=x` is an option named
 *     `-C=x`), `_` read as `-` in a long option's name;
 *   - `--no-<name>` read as `<name>`, negated, before aliases expand, and
 *     refused unless the option is a boolean (or V8's);
 *   - aliases expanded (`-C` is `--conditions`, `-pe` is `--print --eval`,
 *     `-p <code>` is `--print --eval <code>`, `--experimental-permission` is
 *     `--permission`);
 *   - a value taken from `=`, else from the next argument, which may not
 *     start with `-` (a leading `\-` escapes one, and is dropped); an empty
 *     `--name=` is refused;
 *   - an option Node does not know goes to V8, which refuses one it does not
 *     know either ("bad option"), once Node's own options are read;
 *   - `--` ends the options, and is kept out of execArgv;
 *   - in NODE_OPTIONS, `--` and every option Node does not allow there are
 *     refused, and a bare word ends the options it is read for.
 * A refusal is Node's: its message (naming the option as it was typed) and
 * exit code 9.
 */

import { NODE_OPTION_ALIASES, NODE_OPTIONS_TABLE, NODE_V8_FLAGS } from './node-cli-options.generated.js';

/** What a node program's run takes of its command line: its runner, its launch's walk and its process read it. */
export interface NodeLaunch {
  /** The options before the program, as `process.execArgv` holds them (the command line's; not NODE_OPTIONS'). */
  execArgv: string[];
  /** The program's own conditions: NODE_OPTIONS' first, then the command line's. */
  conditions: string[];
  /** `-r`/`--require`'s modules, NODE_OPTIONS' first: required from the working directory, in order, before the program. */
  require: string[];
  /** `--import`'s modules, NODE_OPTIONS' first: imported from the working directory, in order, after those and before the program. */
  import: string[];
  /** `-e`/`--eval`'s code (`process._eval`), when the program is one. */
  eval?: string;
  /** `-p`/`--print`: the eval's completion value is printed when the process exits. */
  print: boolean;
}

/** What node's command line says, for the program it runs. */
export interface NodeCommandLine extends NodeLaunch {
  /** Where the program's own arguments start: its script (or `-`), or, for `-e`, its arguments; their end when there are none. */
  programIndex: number;
  /** `--input-type`: what `-e` code and stdin are (`module`, `commonjs`), the command line's over NODE_OPTIONS'. */
  inputType?: string;
  version: boolean;
  help: boolean;
}

/** A command line Node refuses: what it prints, and its exit code (9, Node's for a bad option). */
export interface NodeCommandLineError {
  error: string;
  exitCode: 9;
}

const refuse = (message: string): NodeCommandLineError => ({ error: `node: ${message}\n`, exitCode: 9 });

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
  require: string[];
  import: string[];
  eval?: string;
  /** A boolean the last of its options set (`--print`, or `--no-print`). */
  print?: boolean;
  inputType?: string;
  version: boolean;
  help: boolean;
  /** Where they end in `tokens` (past a `--`). */
  end: number;
}

/** The options at the head of `tokens`, as Node's OptionsParser::Parse reads them; `env` for NODE_OPTIONS'. */
function readOptions(tokens: readonly string[], env: boolean): ReadOptions | NodeCommandLineError {
  const read: ReadOptions = { conditions: [], require: [], import: [], version: false, help: false, end: 0 };
  // An alias's expansion past its first option, read before the next argument.
  const synthetic: string[] = [];
  let i = 0;
  const empty = () => synthetic.length === 0 && i >= tokens.length;
  const first = () => (synthetic.length > 0 ? synthetic[0] : tokens[i]);
  const popFirst = () => (synthetic.length > 0 ? synthetic.shift()! : tokens[i++]);
  // An option neither Node nor V8 knows: V8 refuses it once Node's own are read.
  let unknown: string | undefined;
  while (!empty()) {
    if (first().length <= 1 || first()[0] !== '-') break;
    const arg = popFirst();
    if (arg === '--') {
      if (env) return refuse('-- is not allowed in NODE_OPTIONS');
      break;
    }
    // Only a long option takes `=value`.
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    let name = equals === -1 ? arg : arg.slice(0, equals);
    // The option as it was typed, for Node's messages: no alias expanded, its `=` kept.
    const typed = equals === -1 ? name : name + '=';
    name = name.slice(0, 2) + name.slice(2).replaceAll('_', '-');
    const negation = name.startsWith('--no-');
    if (negation) name = '--' + name.slice(5);
    for (;;) {
      const expansion = NODE_OPTION_ALIASES.get(name)
        ?? (equals !== -1 ? NODE_OPTION_ALIASES.get(name + '=') : undefined)
        ?? (!empty() && first() !== '' && first()[0] !== '-' ? NODE_OPTION_ALIASES.get(name + ' <arg>') : undefined);
      if (expansion === undefined) break;
      const previous = name;
      name = expansion[0];
      synthetic.unshift(...expansion.slice(1));
      // `--prof-process` stands for itself and a `--`.
      if (name === previous) break;
    }
    const option = NODE_OPTIONS_TABLE.get(name);
    if (env && option?.env !== true) return refuse(`${typed} is not allowed in NODE_OPTIONS`);
    if (option === undefined) {
      // V8's (one argument; its value only after `=`), or a bad option.
      if (unknown === undefined && !v8Takes(arg)) unknown = arg;
      continue;
    }
    if (negation && option.kind !== 'boolean' && option.kind !== 'v8') {
      return refuse(`${arg} is an invalid negation because it is not a boolean option`);
    }
    let value = '';
    if (option.kind === 'value') {
      if (equals !== -1) {
        value = arg.slice(equals + 1);
        if (value === '') return refuse(`${typed} requires an argument`);
      } else {
        if (empty()) return refuse(`${typed} requires an argument`);
        value = popFirst();
        if (value.startsWith('-')) return refuse(`${typed} requires an argument`);
        if (value.startsWith('\\-')) value = value.slice(1);
      }
    }
    switch (name) {
      case '--conditions': read.conditions.push(value); break;
      case '--require': read.require.push(value); break;
      case '--import': read.import.push(value); break;
      case '--eval': read.eval = value; break;
      case '--input-type': read.inputType = value; break;
      case '--print': read.print = !negation; break;
      case '--version': read.version = !negation; break;
      case '--help': read.help = !negation; break;
    }
  }
  if (unknown !== undefined) return refuse(`bad option: ${unknown}`);
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
    require: [...fromEnv.require, ...fromArgs.require],
    import: [...fromEnv.import, ...fromArgs.import],
    ...(fromArgs.eval !== undefined ? { eval: fromArgs.eval } : {}),
    print: fromArgs.print ?? fromEnv.print ?? false,
    ...(fromArgs.inputType ?? fromEnv.inputType) !== undefined ? { inputType: fromArgs.inputType ?? fromEnv.inputType } : {},
    version: fromArgs.version,
    help: fromArgs.help,
  };
}
