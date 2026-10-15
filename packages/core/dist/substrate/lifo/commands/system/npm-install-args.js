import { parseNpmLogLevel } from './npm-log.js';
export function npmInstallInvocation(config) {
    const set = (key) => config.find(key) !== 'default';
    const flag = (key) => config.get(key) === true;
    const text = (key) => {
        const value = config.get(key);
        return typeof value === 'string' && value.length > 0 ? value : null;
    };
    const kinds = (key) => new Set((Array.isArray(config.get(key)) ? config.get(key) : []).map(String));
    // npm: what `--include` names is installed, whatever `--omit` (or the deprecated --production, --no-optional) says.
    const omitted = kinds('omit');
    if (flag('production'))
        omitted.add('dev');
    if (config.get('optional') === false)
        omitted.add('optional');
    const included = kinds('include');
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
        ...(flag('engine-strict') ? ['--engine-strict is not supported here: engines are not checked'] : []),
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
        registry: set('registry') ? text('registry') : null,
        unsupported,
    };
}
