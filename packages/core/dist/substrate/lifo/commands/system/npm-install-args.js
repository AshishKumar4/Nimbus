import { parseNpmLogLevel } from './npm-log.js';
import { npmCacheMode } from '../../../../_shared/npm-cache-mode.js';
/** npm's options its cache mode is read from: `--offline`, `--prefer-offline`, `--prefer-online`, and the deprecated aliases of the latter two. */
const CACHE_MODE_KEYS = ['offline', 'prefer-offline', 'prefer-online', 'cache-min', 'cache-max'];
export function npmInstallInvocation(config) {
    const set = (key) => config.find(key) !== 'default';
    const flag = (key) => config.get(key) === true;
    const text = (key) => {
        const value = config.get(key);
        return typeof value === 'string' && value.length > 0 ? value : null;
    };
    const kinds = (key) => new Set((Array.isArray(config.get(key)) ? config.get(key) : []).map(String));
    // @npmcli/config's buildOmitList: --omit, less what --include names, the
    // deprecated --production, --only, --also, --dev and --optional each
    // adding to one or the other (--no-production includes dev, as
    // --optional includes optional).
    const omitted = kinds('omit');
    const included = kinds('include');
    const only = config.get('only');
    if ((typeof only === 'string' && /^prod(uction)?$/.test(only)) || flag('production'))
        omitted.add('dev');
    else if (config.get('production') === false)
        included.add('dev');
    const also = config.get('also');
    if (typeof also === 'string' && /^dev/.test(also))
        included.add('dev');
    if (flag('dev'))
        included.add('dev');
    if (config.get('optional') === false)
        omitted.add('optional');
    else if (config.get('optional') === true)
        included.add('optional');
    const omits = (type) => omitted.has(type) && !included.has(type);
    const global = flag('global') || config.get('location') === 'global';
    // npm: --global-style is the shallow strategy, --legacy-bundling the nested one; a global install is always shallow.
    const strategy = flag('legacy-bundling') ? 'nested' : flag('global-style') ? 'shallow' : text('install-strategy');
    const unsupported = [
        ...(!global && strategy !== null && strategy !== 'hoisted' ? [`--install-strategy=${strategy} is not supported here; only hoisted is`] : []),
        ...(kinds('workspace').size > 0 || flag('workspaces') ? ['workspaces (-w, --workspace, --workspaces) are not supported here'] : []),
        ...(flag('dry-run') ? ['--dry-run is not supported here'] : []),
        ...(flag('package-lock-only') ? ['--package-lock-only is not supported here: package-lock.json is not written'] : []),
        ...(config.get('bin-links') === false ? ['--no-bin-links is not supported here'] : []),
        ...(config.get('before') !== null && config.get('before') !== undefined ? ['--before is not supported here'] : []),
        ...['cpu', 'os', 'libc'].flatMap((name) => (text(name) !== null ? [`--${name} is not supported here: platforms are this runtime's`] : [])),
    ];
    return {
        packages: config.positionals.slice(1),
        global,
        prefix: set('prefix') ? text('prefix') : null,
        loglevel: set('loglevel') ? parseNpmLogLevel(config.get('loglevel')) : null,
        production: omits('dev'),
        saveDev: flag('save-dev'),
        saveOptional: flag('save-optional'),
        force: flag('force'),
        strictPeerDeps: flag('strict-peer-deps'),
        legacyPeerDeps: flag('legacy-peer-deps'),
        omitOptional: omits('optional'),
        omitPeer: omits('peer'),
        preferDedupe: flag('prefer-dedupe'),
        save: config.get('save') !== false,
        savePrefix: flag('save-exact') ? '' : text('save-prefix') ?? '',
        engineStrict: flag('engine-strict'),
        registry: set('registry') ? text('registry') : null,
        cache: npmCacheMode(config.flattened(CACHE_MODE_KEYS)),
        unsupported,
    };
}
