/**
 * Command-line options: one scanner (`scanOptions`, getopt_long's grammar)
 * and two policies over it. `getopt` is GNU's: an option it cannot take ends
 * the scan with getopt's own diagnostic. `parseArgs` is the compatibility
 * collector the flag-table commands use: exact long names, unknown options
 * set aside for the command to judge, a missing value read as ''.
 */
/**
 * `args` scanned as GNU getopt_long scans them, permuting unless
 * `stopAtOperand`: options and operands may interleave, `--` ends the
 * options, `-` is an operand. A cluster (`-cz`) is its letters; a letter that
 * takes an argument takes the rest of its word or the next word (`-k2`,
 * `-k 2`). A long option is its name, or with `abbreviations` an unambiguous
 * prefix of one (`--coun`); its argument follows `=` or, when required, is
 * the next word.
 */
export function scanOptions(args, spec, options = {}) {
    // Every command runs one scan: a plain loop into an array, which costs what a command's own loop did.
    const abbreviations = options.abbreviations !== false;
    const events = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') {
            for (let rest = i + 1; rest < args.length; rest++)
                events.push({ kind: 'operand', value: args[rest] });
            break;
        }
        if (arg.length < 2 || arg[0] !== '-') {
            if (options.stopAtOperand !== true) {
                events.push({ kind: 'operand', value: arg });
                continue;
            }
            for (let rest = i; rest < args.length; rest++)
                events.push({ kind: 'operand', value: args[rest] });
            break;
        }
        if (arg[1] === '-') {
            const eq = arg.indexOf('=');
            const written = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
            const inline = eq === -1 ? undefined : arg.slice(eq + 1);
            // The spec's own names: not a name every object has (`constructor`).
            const candidates = Object.hasOwn(spec.long, written) ? [written]
                : abbreviations ? Object.keys(spec.long).filter((name) => name.startsWith(written)) : [];
            // Prefixes that name one option through several aliases are not ambiguous.
            const keys = new Set(candidates.map((name) => spec.long[name][0]));
            if (candidates.length === 0) {
                events.push({ kind: 'unknown', option: `--${written}`, written: arg });
                continue;
            }
            if (keys.size > 1) {
                events.push({ kind: 'ambiguous', written, candidates });
                continue;
            }
            const name = candidates[0];
            const [key, argument] = spec.long[name];
            if (argument === 'none' && inline !== undefined) {
                events.push({ kind: 'unwanted', key, option: `--${name}`, value: inline });
            }
            else if (argument === 'required' && inline === undefined) {
                events.push(i + 1 < args.length ? { kind: 'option', key, value: args[i + 1], word: i++ } : { kind: 'missing', key, option: `--${name}` });
            }
            else {
                events.push(inline === undefined ? { kind: 'option', key, word: i } : { kind: 'option', key, value: inline, word: i });
            }
            continue;
        }
        for (let j = 1; j < arg.length; j++) {
            const letter = arg[j];
            const at = letter === ':' ? -1 : spec.short.indexOf(letter);
            if (at === -1) {
                events.push({ kind: 'unknown', option: `-${letter}`, written: arg });
                continue;
            }
            if (spec.short[at + 1] !== ':') {
                events.push({ kind: 'option', key: letter, word: i });
                continue;
            }
            if (j + 1 < arg.length)
                events.push({ kind: 'option', key: letter, value: arg.slice(j + 1), word: i });
            else
                events.push(i + 1 < args.length ? { kind: 'option', key: letter, value: args[i + 1], word: i++ } : { kind: 'missing', key: letter, option: `-${letter}` });
            break;
        }
    }
    return events;
}
/**
 * `args` as GNU getopt_long reads them (scanOptions with abbreviations, and
 * `stopAtOperand` as given): the scan ends at the first option it cannot
 * take, with getopt's own diagnostic, which the command prefixes with its
 * name.
 */
export function getopt(args, spec, options = {}) {
    const events = [];
    for (const event of scanOptions(args, spec, options)) {
        switch (event.kind) {
            case 'option':
            case 'operand':
                events.push(event);
                continue;
            case 'unknown':
                events.push({ kind: 'error', message: event.option.startsWith('--') ? `unrecognized option '${event.written}'` : `invalid option -- '${event.option.slice(1)}'` });
                return events;
            case 'ambiguous':
                events.push({ kind: 'error', message: `option '--${event.written}' is ambiguous; possibilities:${event.candidates.map((name) => ` '--${name}'`).join('')}` });
                return events;
            case 'missing':
                events.push({ kind: 'error', message: event.option.startsWith('--') ? `option '${event.option}' requires an argument` : `option requires an argument -- '${event.key}'` });
                return events;
            case 'unwanted':
                events.push({ kind: 'error', message: `option '${event.option}' doesn't allow an argument` });
                return events;
        }
    }
    return events;
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
