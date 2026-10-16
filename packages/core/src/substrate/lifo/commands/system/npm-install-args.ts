/**
 * npm-install-args.ts — what `npm install` and `npm ci` take from npm's
 * configuration (npm-config.ts: the command line as npm's nopt parses it,
 * npm_config_* and the .npmrc files), the one place npm's options are read.
 */
import type { NpmConfig } from './npm-config.js';
import { parseNpmLogLevel, type NpmLogLevel } from './npm-log.js';
import { npmCacheMode, type NpmCacheMode } from '../../../../_shared/npm-cache-mode.js';

/** npm's options its cache mode is read from: `--offline`, `--prefer-offline`, `--prefer-online`, and the deprecated aliases of the latter two. */
const CACHE_MODE_KEYS = ['offline', 'prefer-offline', 'prefer-online', 'cache-min', 'cache-max'] as const;

export interface NpmInstallInvocation {
  packages: string[];
  global: boolean;
  prefix: string | null;
  /** `--loglevel`, when it names a level npm recognises; null otherwise. */
  loglevel: NpmLogLevel | null;
  /**
   * `--omit=dev` (or npm's deprecated `--production`, bun's `-p`): install dependencies only.
   *
   * Both npm and bun honour this, and it is the one answer a project has to a
   * devDependency Nimbus cannot run — a headless-browser driver, a native
   * toolchain — when the thing being installed is the runtime, not the test
   * suite. The flag was in the arg spec but its value was dropped, so it
   * silently did nothing and the install failed on a package the caller had
   * already said to skip.
   */
  production: boolean;
  /**
   * `-D` / `--save-dev`: record the spec under devDependencies. Read by the
   * in-process install path, which owns the package.json update itself.
   */
  saveDev: boolean;
  /** `-O` / `--save-optional`: record the spec under optionalDependencies. */
  saveOptional: boolean;
  /** `-f` / `--force`: a peer conflict the project owns is a warning, not ERESOLVE. */
  force: boolean;
  /** `--strict-peer-deps`: any peer conflict is ERESOLVE unless forced, not only the project's. */
  strictPeerDeps: boolean;
  /** `--legacy-peer-deps`: peers are neither installed nor checked, as npm 6 did. */
  legacyPeerDeps: boolean;
  /** `--omit=optional` (or `--no-optional`): what only optional dependencies need is not installed. */
  omitOptional: boolean;
  /** `--omit=peer`: what only peer dependencies need is not installed. */
  omitPeer: boolean;
  /** `--prefer-dedupe`: an installed copy is replaced by an older one that meets every edge too, so one copy serves them all. */
  preferDedupe: boolean;
  /** False for `--no-save`: package.json is left as it is. */
  save: boolean;
  /** What a saved range starts with: `--save-prefix`, '' for `--save-exact`, else '^'. */
  savePrefix: string;
  /** `--engine-strict`: a package whose engines exclude this node or npm fails the install (EBADENGINE), where npm otherwise warns. */
  engineStrict: boolean;
  /** The registry npm's configuration names (`--registry`, npm_config_registry, an .npmrc); null where only npm's default does. */
  registry: string | null;
  /** How the install's packuments are read: npm's cache mode (npm-cache-mode.ts) from its configuration. */
  cache: NpmCacheMode;
  /** Options npm has that this npm does not implement, as npm ERR! lines: the install refuses them rather than ignore them. */
  unsupported: string[];
}

export function npmInstallInvocation(config: NpmConfig): NpmInstallInvocation {
  const set = (key: string) => config.find(key) !== 'default';
  const flag = (key: string) => config.get(key) === true;
  const text = (key: string) => {
    const value = config.get(key);
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  const kinds = (key: string) => new Set((Array.isArray(config.get(key)) ? config.get(key) as unknown[] : []).map(String));
  // @npmcli/config's buildOmitList: --omit, less what --include names, the
  // deprecated --production, --only, --also, --dev and --optional each
  // adding to one or the other (--no-production includes dev, as
  // --optional includes optional).
  const omitted = kinds('omit');
  const included = kinds('include');
  const only = config.get('only');
  if ((typeof only === 'string' && /^prod(uction)?$/.test(only)) || flag('production')) omitted.add('dev');
  else if (config.get('production') === false) included.add('dev');
  const also = config.get('also');
  if (typeof also === 'string' && /^dev/.test(also)) included.add('dev');
  if (flag('dev')) included.add('dev');
  if (config.get('optional') === false) omitted.add('optional');
  else if (config.get('optional') === true) included.add('optional');
  const omits = (type: string) => omitted.has(type) && !included.has(type);
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
    ...(['cpu', 'os', 'libc'] as const).flatMap((name) => (text(name) !== null ? [`--${name} is not supported here: platforms are this runtime's`] : [])),
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
