import { parseArgs } from '@nimbus-sh/core/substrate/lifo/utils/args.js';
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
    // bun spells it `-p`; npm's `-P` is --save-prod, and the short map is
    // case-sensitive, so both tools' spellings land where they should.
    production: { type: 'boolean', short: 'p' },
};
export function parseNpmInstallInvocation(args) {
    const parsed = parseArgs(args, INSTALL_ARG_SPEC);
    return {
        packages: parsed.positional,
        global: parsed.flags.global === true,
        prefix: stringFlag(parsed.flags.prefix),
        loglevel: parseNpmLogLevel(parsed.flags.loglevel),
        production: parsed.flags.production === true || omittedDependencyTypes(args).has('dev'),
    };
}
/**
 * Every `--omit` in the invocation. npm allows the flag more than once
 * (`--omit=dev --omit=optional`), and the generic parser keeps only the last
 * value — so the one spelling that matters would be missed whenever a caller
 * omitted more than one kind.
 */
function omittedDependencyTypes(args) {
    const omitted = new Set();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--')
            break;
        if (arg === '--omit') {
            const value = args[++i];
            if (value)
                omitted.add(value);
        }
        else if (arg.startsWith('--omit=')) {
            omitted.add(arg.slice('--omit='.length));
        }
    }
    return omitted;
}
function stringFlag(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
