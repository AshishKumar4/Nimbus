/**
 * node's command line, read as Node reads it (src/node_options.cc): the
 * options before the program, each taking its value from `--name=value` or
 * from the next argument when Node's own table says it takes one
 * (node-cli-options.generated.ts), `--` ending them; and NODE_OPTIONS,
 * split as Node splits it (double quotes group, a backslash escapes inside
 * them) and holding only the options Node allows there.
 *
 * What Nimbus's node takes from them: the program's own conditions
 * (`--conditions`, `-C`), for the exports and imports resolvers, and the
 * options as `process.execArgv` holds them (the command line's; Node keeps
 * NODE_OPTIONS' out of it). An option Node does not know is passed over on
 * the command line (V8's own flags are many, and the runtime has none of
 * them); in NODE_OPTIONS it is refused as Node refuses it.
 */
import { NODE_ENV_OPTIONS, NODE_OPTION_ALIASES, NODE_VALUE_OPTIONS } from './node-cli-options.generated.js';
const refuse = (message) => ({ error: `node: ${message}\n`, exitCode: 9 });
/** An option's name as Node's table spells it: the alias's first expansion, without its `=` form. */
function canonical(name) {
    const expansion = NODE_OPTION_ALIASES.get(name);
    return expansion?.length === 1 ? expansion[0] : name;
}
function takesValue(name) {
    return NODE_VALUE_OPTIONS.has(canonical(name));
}
/** process.allowedNodeEnvironmentFlags.has, as Node answers it: `_` for `-`, a `--no-` prefix and an `=value` aside. */
export function allowedInNodeOptions(option) {
    let key = option.startsWith('--') ? '--' + option.slice(2).replaceAll('_', '-') : option;
    const equals = key.indexOf('=');
    if (equals !== -1)
        key = key.slice(0, equals);
    if (NODE_ENV_OPTIONS.has(key))
        return true;
    return key.startsWith('--no-') && NODE_ENV_OPTIONS.has('--' + key.slice(5));
}
/** NODE_OPTIONS split as Node splits it (ParseNodeOptionsEnvVar): spaces part, double quotes group, `\` escapes inside them. */
export function splitNodeOptions(text) {
    const tokens = [];
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
            if (inToken)
                tokens.push(current);
            current = '';
            inToken = false;
            continue;
        }
        current += c;
        inToken = true;
    }
    if (quoted)
        return refuse('invalid value for NODE_OPTIONS (unterminated string)');
    if (inToken)
        tokens.push(current);
    return tokens;
}
/**
 * The options at the head of `tokens`: each with its value, the conditions
 * among them, and where they end, at the first word that is not one (on the
 * command line, the program). In NODE_OPTIONS (`env`) an option Node does
 * not allow there is refused.
 */
function readOptions(tokens, env) {
    const options = [];
    const conditions = [];
    let i = 0;
    while (i < tokens.length) {
        const token = tokens[i];
        // `--` ends the options; Node keeps it out of execArgv.
        if (token === '--') {
            i++;
            break;
        }
        // The first word that is not an option ends them: the program on the
        // command line; in NODE_OPTIONS, where it and all after it are passed over.
        if (!token.startsWith('-') || token === '-')
            break;
        // Node names a long option given with a value by its name and `=`, a short one whole.
        if (env && !allowedInNodeOptions(token)) {
            const named = token.startsWith('--') && token.includes('=') ? token.slice(0, token.indexOf('=') + 1) : token;
            return refuse(`${named} is not allowed in NODE_OPTIONS`);
        }
        const equals = token.indexOf('=');
        const name = equals === -1 ? token : token.slice(0, equals);
        let value = equals === -1 ? undefined : token.slice(equals + 1);
        options.push(token);
        i++;
        if (value === undefined && takesValue(name)) {
            if (i >= tokens.length)
                return refuse(`${name} requires an argument`);
            value = tokens[i++];
            options.push(value);
        }
        if (canonical(name) === '--conditions' && value !== undefined)
            conditions.push(value);
    }
    return { options, conditions, end: i };
}
/** node's `args` (after `node` itself) and its NODE_OPTIONS, read as Node reads them. */
export function parseNodeCommandLine(args, nodeOptions = '') {
    const envTokens = splitNodeOptions(nodeOptions);
    if ('error' in envTokens)
        return envTokens;
    const fromEnv = readOptions(envTokens, true);
    if ('error' in fromEnv)
        return fromEnv;
    const fromArgs = readOptions(args, false);
    if ('error' in fromArgs)
        return fromArgs;
    return {
        execArgv: fromArgs.options,
        programIndex: fromArgs.end,
        conditions: [...fromEnv.conditions, ...fromArgs.conditions],
    };
}
