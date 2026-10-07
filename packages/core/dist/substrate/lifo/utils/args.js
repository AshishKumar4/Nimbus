/**
 * Command-line options: one scanner (`scanOptions`, getopt_long's grammar)
 * and two policies over it. `getopt` is GNU's: an option it cannot take ends
 * the scan with getopt's own diagnostic. `parseArgs` is the compatibility
 * collector the flag-table commands use: exact long names, unknown options
 * set aside for the command to judge, a missing value read as ''.
 */
/**
 * `args` scanned as GNU getopt_long scans them, permuting: options and
 * operands may interleave, `--` ends the options, `-` is an operand. A
 * cluster (`-cz`) is its letters; a letter that takes an argument takes the
 * rest of its word or the next word (`-k2`, `-k 2`). A long option is its
 * name, or with `abbreviations` an unambiguous prefix of one (`--coun`); its
 * argument follows `=` or, when required, is the next word.
 */
export function* scanOptions(args, spec, { abbreviations = true } = {}) {
    const takesArgument = (letter) => spec.short[spec.short.indexOf(letter) + 1] === ':';
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            for (const rest of args.slice(i + 1))
                yield { kind: 'operand', value: rest };
            return;
        }
        if (!arg.startsWith('-') || arg === '-') {
            yield { kind: 'operand', value: arg };
            continue;
        }
        if (arg.startsWith('--')) {
            const eq = arg.indexOf('=');
            const written = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
            const inline = eq === -1 ? undefined : arg.slice(eq + 1);
            const candidates = written in spec.long ? [written]
                : abbreviations ? Object.keys(spec.long).filter((name) => name.startsWith(written)) : [];
            // Prefixes that name one option through several aliases are not ambiguous.
            const keys = new Set(candidates.map((name) => spec.long[name][0]));
            if (candidates.length === 0) {
                yield { kind: 'unknown', option: `--${written}`, written: arg };
                continue;
            }
            if (keys.size > 1) {
                yield { kind: 'ambiguous', written, candidates };
                continue;
            }
            const name = candidates[0];
            const [key, argument] = spec.long[name];
            if (argument === 'none' && inline !== undefined) {
                yield { kind: 'unwanted', key, option: `--${name}`, value: inline };
            }
            else if (argument === 'required' && inline === undefined) {
                yield i + 1 < args.length ? { kind: 'option', key, value: args[++i] } : { kind: 'missing', key, option: `--${name}` };
            }
            else {
                yield inline === undefined ? { kind: 'option', key } : { kind: 'option', key, value: inline };
            }
            continue;
        }
        for (let j = 1; j < arg.length; j++) {
            const letter = arg[j];
            if (letter === ':' || !spec.short.includes(letter)) {
                yield { kind: 'unknown', option: `-${letter}`, written: arg };
                continue;
            }
            if (!takesArgument(letter)) {
                yield { kind: 'option', key: letter };
                continue;
            }
            const rest = arg.slice(j + 1);
            if (rest !== '')
                yield { kind: 'option', key: letter, value: rest };
            else
                yield i + 1 < args.length ? { kind: 'option', key: letter, value: args[++i] } : { kind: 'missing', key: letter, option: `-${letter}` };
            break;
        }
    }
}
/**
 * `args` as GNU getopt_long reads them (scanOptions with abbreviations): the
 * scan ends at the first option it cannot take, with getopt's own
 * diagnostic, which the command prefixes with its name.
 */
export function* getopt(args, spec) {
    for (const event of scanOptions(args, spec)) {
        switch (event.kind) {
            case 'option':
            case 'operand':
                yield event;
                continue;
            case 'unknown':
                yield { kind: 'error', message: event.option.startsWith('--') ? `unrecognized option '${event.written}'` : `invalid option -- '${event.option.slice(1)}'` };
                return;
            case 'ambiguous':
                yield { kind: 'error', message: `option '--${event.written}' is ambiguous; possibilities:${event.candidates.map((name) => ` '--${name}'`).join('')}` };
                return;
            case 'missing':
                yield { kind: 'error', message: event.option.startsWith('--') ? `option '${event.option}' requires an argument` : `option requires an argument -- '${event.key}'` };
                return;
            case 'unwanted':
                yield { kind: 'error', message: `option '${event.option}' doesn't allow an argument` };
                return;
        }
    }
}
/**
 * A flag table's options, collected: scanOptions over the table without
 * abbreviations, every flag present (false, or '' for a string); an
 * undeclared option is set aside in `unknown`, a string option with nothing
 * after it is '', and a boolean given `--name=value` is true.
 */
export function parseArgs(args, spec) {
    const flags = {};
    const positional = [];
    const unknown = [];
    const nameOf = {};
    const getoptSpec = { short: '', long: {} };
    for (const [long, def] of Object.entries(spec)) {
        flags[long] = def.type === 'boolean' ? false : '';
        const key = def.short ?? long;
        nameOf[key] = long;
        if (def.short)
            getoptSpec.short += def.type === 'string' ? `${def.short}:` : def.short;
        getoptSpec.long[long] = [key, def.type === 'string' ? 'required' : 'none'];
    }
    for (const event of scanOptions(args, getoptSpec, { abbreviations: false })) {
        if (event.kind === 'operand')
            positional.push(event.value);
        else if (event.kind === 'unknown')
            unknown.push(event.option);
        else if (event.kind === 'option') {
            const name = nameOf[event.key];
            flags[name] = spec[name].type === 'boolean' ? true : event.value ?? '';
        }
        else if (event.kind === 'missing')
            flags[nameOf[event.key]] = '';
        else if (event.kind === 'unwanted')
            flags[nameOf[event.key]] = true;
    }
    return { flags, positional, unknown };
}
