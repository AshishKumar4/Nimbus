import { parseArgs } from '../../utils/args.js';
import { parseNpmLogLevel } from './npm-log.js';
const INSTALL_ARG_SPEC = {
    global: { type: 'boolean', short: 'g' },
    prefix: { type: 'string' },
    loglevel: { type: 'string' },
    registry: { type: 'string' },
    tag: { type: 'string' },
    cache: { type: 'string' },
    omit: { type: 'string' },
    include: { type: 'string' },
    workspace: { type: 'string', short: 'w' },
    'min-release-age': { type: 'string' },
    'save-prefix': { type: 'string' },
    'ignore-scripts': { type: 'boolean' },
    'no-fund': { type: 'boolean' },
    fund: { type: 'boolean' },
    'no-audit': { type: 'boolean' },
    audit: { type: 'boolean' },
    progress: { type: 'boolean' },
    save: { type: 'boolean', short: 'S' },
    'save-dev': { type: 'boolean', short: 'D' },
    'save-prod': { type: 'boolean', short: 'P' },
    'save-optional': { type: 'boolean', short: 'O' },
    'save-exact': { type: 'boolean', short: 'E' },
    'package-lock': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean', short: 'f' },
    'legacy-peer-deps': { type: 'boolean' },
    workspaces: { type: 'boolean' },
    'no-save': { type: 'boolean' },
    'no-optional': { type: 'boolean' },
    'prefer-dedupe': { type: 'boolean' },
    'install-strategy': { type: 'string' },
    'engine-strict': { type: 'boolean' },
    // bun spells it `-p`; npm's `-P` is --save-prod, and the short map is
    // case-sensitive, so both tools' spellings land where they should.
    production: { type: 'boolean', short: 'p' },
};
export function parseNpmInstallInvocation(args) {
    const parsed = parseArgs(args, INSTALL_ARG_SPEC);
    // npm: what `--include` names is installed, whatever `--omit` says.
    const included = repeatedValues(args, 'include');
    const omitted = repeatedValues(args, 'omit');
    const omits = (type) => omitted.has(type) && !included.has(type);
    const strategy = stringFlag(parsed.flags['install-strategy']);
    const unsupported = [
        ...(strategy !== null && strategy !== 'hoisted' ? [`--install-strategy=${strategy} is not supported here; only hoisted is`] : []),
        ...(stringFlag(parsed.flags.workspace) !== null || parsed.flags.workspaces === true ? ['workspaces (-w, --workspace, --workspaces) are not supported here'] : []),
        ...(parsed.flags['dry-run'] === true ? ['--dry-run is not supported here'] : []),
        ...(parsed.flags['engine-strict'] === true ? ['--engine-strict is not supported here: engines are not checked'] : []),
    ];
    const savePrefix = stringFlag(parsed.flags['save-prefix']);
    return {
        packages: parsed.positional,
        global: parsed.flags.global === true,
        prefix: stringFlag(parsed.flags.prefix),
        loglevel: parseNpmLogLevel(parsed.flags.loglevel),
        production: (parsed.flags.production === true || omitted.has('dev')) && !included.has('dev'),
        saveDev: parsed.flags['save-dev'] === true,
        saveOptional: parsed.flags['save-optional'] === true,
        force: parsed.flags.force === true,
        legacyPeerDeps: parsed.flags['legacy-peer-deps'] === true,
        omitOptional: (omits('optional') || parsed.flags['no-optional'] === true) && !included.has('optional'),
        omitPeer: omits('peer'),
        preferDedupe: parsed.flags['prefer-dedupe'] === true,
        save: parsed.flags['no-save'] !== true && parsed.flags.save !== false,
        savePrefix: parsed.flags['save-exact'] === true ? '' : savePrefix ?? '^',
        unsupported,
    };
}
/**
 * Every value of `--<name>` in the invocation. npm allows `--omit` and
 * `--include` more than once (`--omit=dev --omit=optional`), and the generic
 * parser keeps only the last value — so a kind would be missed whenever a
 * caller named more than one.
 */
function repeatedValues(args, name) {
    const values = new Set();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--')
            break;
        if (arg === `--${name}`) {
            const value = args[++i];
            if (value)
                values.add(value);
        }
        else if (arg.startsWith(`--${name}=`)) {
            values.add(arg.slice(`--${name}=`.length));
        }
    }
    return values;
}
function stringFlag(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
