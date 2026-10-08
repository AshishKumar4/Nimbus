/**
 * npm-config.ts — npm's configuration as npm 10.9.8's @npmcli/config 9.0.0
 * loads it, over the session's files: the command line (nopt 8.1.0 with
 * npm's definitions and shorthands: flags anywhere, abbreviations, `--`
 * ending them), `npm_config_*` in the environment, the project's `.npmrc`
 * (in its local prefix: the nearest directory up from the working one with a
 * package.json or node_modules), the user's (`userconfig`, `~/.npmrc`) and
 * the global one (`globalconfig`, `<prefix>/etc/npmrc`), each over the next,
 * then npm's defaults. A file is read with npm's ini; each value is parsed
 * with npm's parse-field (`${VAR}`, `~/`, booleans) and validated as npm
 * validates it (nopt.clean with npm's type definitions), with npm's
 * warnings: a deprecated key's use, and an invalid value, which is dropped.
 *
 * Named limits: a relative path value resolves against the Worker's own
 * working directory (npm's process's, in npm), and a workspace root's project
 * config above the local prefix is not looked for.
 */
import npmDefinitions from '@npmcli/config/lib/definitions/index.js';
import envReplace from '@npmcli/config/lib/env-replace.js';
import parseField from '@npmcli/config/lib/parse-field.js';
import typeDefs from '@npmcli/config/lib/type-defs.js';
import typeDescription from '@npmcli/config/lib/type-description.js';
import ini from 'ini';
import nopt from 'nopt';

import type { ProcessView as VFS } from '../../../../runtime/process-files.js';
import { dirname, resolve } from '../../utils/path.js';

const { definitions, shorthands } = npmDefinitions;

// npm's definitions in nopt's terms (@npmcli/config's constructor).
const TYPES: Record<string, unknown> = {};
const DEFAULTS: Record<string, unknown> = {};
const DEPRECATED: Record<string, string> = {};
for (const [key, definition] of Object.entries(definitions)) {
  DEFAULTS[key] = definition.default;
  TYPES[key] = definition.type;
  if (definition.deprecated) DEPRECATED[key] = definition.deprecated.trim().replace(/\n +/, '\n');
}

/** npm's configuration, loaded: each key from the first layer that sets it, then npm's default. */
export interface NpmConfig {
  get(key: string): unknown;
  /** npm's default for `key`. */
  default(key: string): unknown;
  /** The directory whose `.npmrc` is the project's. */
  readonly localPrefix: string;
  /** The command line's positional arguments, the command first. */
  readonly positionals: readonly string[];
  /** npm's warnings of the load, each one line for `npm warn `. */
  readonly warnings: readonly string[];
}

/** Load npm's configuration for `argv` (the command and its arguments) run in `cwd` with `env`. */
export async function loadNpmConfig(vfs: VFS, cwd: string, env: Record<string, string>, argv: readonly string[]): Promise<NpmConfig> {
  const home = env.HOME || '/home/user';
  const globalPrefix = env.PREFIX || '/usr/local';
  const warnings: string[] = [];
  const fieldOptions = { platform: 'linux', types: TYPES, home, env };
  // Highest first, as get reads them; `source` names one in a warning.
  const layers: Array<{ where: string; source: string; data: Record<string, unknown> }> = [];
  const invalid = (source: string) => (key: string, value: unknown, type: unknown): void => {
    warnings.push(`invalid config ${key}=${JSON.stringify(value)} set in ${source}`, invalidDescription(type));
  };
  const layer = (where: string, source: string, raw: Record<string, unknown> | null): void => {
    const data: Record<string, unknown> = Object.create(null);
    for (const [rawKey, value] of Object.entries(raw ?? {})) {
      const key = envReplace(rawKey, env);
      data[key] = parseField(value, key, fieldOptions);
      const deprecated = DEPRECATED[rawKey];
      if (deprecated !== undefined && where !== 'default') warnings.push(`config ${key} ${deprecated}`);
    }
    layers.push({ where, source, data });
  };
  const get = (key: string): unknown => {
    for (const { data } of layers) if (key in data) return data[key];
    return undefined;
  };
  const readRc = async (path: string): Promise<Record<string, unknown> | null> => {
    try {
      return ini.decode(await vfs.readFileString(path));
    } catch {
      return null;
    }
  };

  // The command line, validated as nopt parses it.
  nopt.invalidHandler = invalid('command line options');
  let parsed: Record<string, unknown> & { argv: { remain: string[] } };
  try {
    parsed = nopt(TYPES, shorthands, [...argv], 0);
  } finally {
    nopt.invalidHandler = null;
  }
  const { argv: { remain }, ...cli } = parsed;
  layer('cli', 'command line options', cli);

  const fromEnv: Record<string, unknown> = Object.create(null);
  for (const [name, value] of Object.entries(env)) {
    if (!/^npm_config_/i.test(name) || value === '') continue;
    let key = name.slice('npm_config_'.length);
    if (!key.startsWith('//')) key = key.replace(/(?!^)_/g, '-').toLowerCase();
    fromEnv[key] = value;
  }
  layer('env', 'environment', fromEnv);

  // The local prefix: --prefix, or the nearest directory with a package.json or node_modules.
  const cliPrefix = layers[0]!.data.prefix;
  let localPrefix = typeof cliPrefix === 'string' ? cliPrefix : '';
  if (localPrefix === '') {
    for (let dir = cwd; ; dir = dirname(dir)) {
      const at = dir === '/' ? '' : dir;
      if (await exists(vfs, `${at}/package.json`) || await exists(vfs, `${at}/node_modules`)) {
        localPrefix = dir;
        break;
      }
      if (dir === '/') break;
    }
    localPrefix ||= cwd;
  }
  const userconfig = (): string => String(get('userconfig') ?? resolve(home, '.npmrc'));
  const projectFile = resolve(localPrefix, '.npmrc');
  const global = get('global') === true || get('location') === 'global';
  if (!global && projectFile !== userconfig()) layer('project', projectFile, await readRc(projectFile));
  const userFile = userconfig();
  layer('user', userFile, await readRc(userFile));
  const prefix = String(get('prefix') ?? globalPrefix);
  const globalFile = String(get('globalconfig') || resolve(prefix, 'etc/npmrc'));
  layer('global', globalFile, await readRc(globalFile));
  layer('default', 'default values', { ...DEFAULTS, prefix: globalPrefix });

  // npm's validation of every layer but the command line's (already) and
  // the defaults, in its order: global, user, project, environment.
  for (const { where, source, data } of [...layers].reverse()) {
    if (where === 'default' || where === 'cli') continue;
    nopt.invalidHandler = invalid(source);
    try {
      nopt.clean(data, TYPES, typeDefs);
    } finally {
      nopt.invalidHandler = null;
    }
  }

  return {
    get,
    default: (key) => DEFAULTS[key],
    localPrefix,
    positionals: remain,
    warnings,
  };
}

/** @npmcli/config invalidHandler's second line: what the value must be. */
function invalidDescription(type: unknown): string {
  let described = type;
  if (Array.isArray(type)) {
    if (type.includes(typeDefs.url.type)) described = typeDefs.url.type;
    else if (type.includes(typeDefs.path.type)) described = typeDefs.path.type;
  }
  const descriptions = typeDescription(described);
  const mustBe = descriptions.filter((m) => m !== undefined && m !== Array);
  const keyword = mustBe.length === 1 && descriptions.includes(Array) ? ' one or more'
    : mustBe.length > 1 && descriptions.includes(Array) ? ' one or more of:'
      : mustBe.length > 1 ? ' one of:' : '';
  const description = mustBe.length === 1 ? mustBe[0]
    : [...new Set(mustBe.map((n) => (typeof n === 'string' ? n : JSON.stringify(n))))].join(', ');
  return `invalid config Must be${keyword} ${String(description)}`;
}

async function exists(vfs: VFS, path: string): Promise<boolean> {
  try {
    return await vfs.exists(path);
  } catch {
    return false;
  }
}
