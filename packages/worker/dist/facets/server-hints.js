/**
 * server-hints.ts — which programs start as residents directly. Hints only:
 * a program that listens runs on as a resident however it started
 * (FacetManager._promote), so a hint that is missing or wrong costs time,
 * never correctness. A server it names skips the run up to its listen that
 * its first launch would otherwise make twice.
 *
 *   KNOWN_SERVER_BINS_HINT   bins that serve unless told to do something that
 *                            ends (`build`, `--version`): vite, next, astro…
 *   learned                  a program that listened, by its package, bin and
 *                            first positional argument, learned in this
 *                            workspace when it was run on as a resident.
 */
export function serverIdentityKey(identity) {
    return `${identity.package}\u0000${identity.bin}\u0000${identity.arg0}`;
}
/** The first argument that is not an option: the subcommand, when the bin has one. */
export function firstPositional(argv) {
    return argv.find((arg) => !arg.startsWith('-')) ?? '';
}
export const KNOWN_SERVER_BINS_HINT = new Set([
    'vite', 'vinext', 'next', 'astro', 'nuxt', 'remix', 'serve', 'http-server',
    'wrangler', 'nodemon', 'tsx', 'ts-node-dev', 'webpack-dev-server',
    'parcel', 'rollup', 'esbuild', 'turbo',
]);
const NON_INTERACTIVE_ARGS = new Set(['--help', '-h', 'help', '--version', '-v', 'version']);
/** An argument that asks a CLI for help or its version: it prints and ends. */
export function isNonInteractiveArg(arg) {
    return NON_INTERACTIVE_ARGS.has(arg.trim().toLowerCase());
}
/**
 * Whether `binName argv` is a known server's serving invocation: one of the
 * known bins, unless asked for help, its version or a `build` (each ends);
 * any bin watching or serving by flag.
 */
export function knownServerBin(binName, argv) {
    if (KNOWN_SERVER_BINS_HINT.has(binName))
        return !argv.some((arg) => isNonInteractiveArg(arg) || arg === 'build');
    return argv.some((arg) => arg === '--watch' || arg === '-w' || arg === '--serve' || arg === '--dev');
}
const LEARNED_KEY = 'server-hints';
/** Identities kept, the least recently learned leaving first. */
export const LEARNED_SERVERS_MAX = 256;
/** The programs this workspace learned are servers, read once per isolate. */
export class LearnedServers {
    storage;
    keys = null;
    constructor(storage) {
        this.storage = storage;
    }
    load() {
        return this.keys ??= this.storage.get(LEARNED_KEY).then((keys) => (Array.isArray(keys) ? keys : []));
    }
    async has(identity) {
        return (await this.load()).includes(serverIdentityKey(identity));
    }
    async learn(identity) {
        const key = serverIdentityKey(identity);
        const keys = (await this.load()).filter((known) => known !== key);
        keys.push(key);
        if (keys.length > LEARNED_SERVERS_MAX)
            keys.splice(0, keys.length - LEARNED_SERVERS_MAX);
        this.keys = Promise.resolve(keys);
        await this.storage.put(LEARNED_KEY, keys);
    }
}
