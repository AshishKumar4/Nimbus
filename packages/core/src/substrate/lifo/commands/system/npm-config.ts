/**
 * npm-config.ts — npm's configuration, as npm 10.9.8 (@npmcli/config 9.0.0)
 * loads it, for the keys the shell's npm reads: the command line (nopt's
 * parse, flags anywhere, `--` ending them), `npm_config_*` in the
 * environment, the project's `.npmrc` (in its local prefix: the nearest
 * directory up from the working one with a package.json or node_modules),
 * the user's (`userconfig`, `~/.npmrc`) and the global one (`globalconfig`,
 * `<prefix>/etc/npmrc`), each over the next, then the defaults. A file is
 * read with npm's own ini, `${VAR}` in a key or value is the environment's,
 * and a value is typed as npm types it: a boolean from `true` and `false`, a
 * path from `~/`, a semver or url that is not one ignored with npm's
 * warning, as is a deprecated key's use (`init.author.name`).
 *
 * Named limits: only the definitions below are typed (any other key is read
 * as npm reads an unknown one), and the project config of a workspace's
 * root is not looked for above the local prefix.
 */
import ini from 'ini';
import semver from 'semver';

import type { ProcessView as VFS } from '../../../../runtime/process-files.js';
import { dirname, resolve } from '../../utils/path.js';

type ConfigType = 'boolean' | 'nullable-boolean' | 'string' | 'path' | 'semver' | 'url' | 'string-list';

/** npm's definitions of the keys read here: their type, default and short flag. */
const DEFINITIONS: Record<string, { type: ConfigType; default: unknown; deprecated?: string }> = {
  yes: { type: 'nullable-boolean', default: null },
  force: { type: 'boolean', default: false },
  global: { type: 'boolean', default: false },
  scope: { type: 'string', default: '' },
  'init-author-name': { type: 'string', default: '' },
  'init-author-email': { type: 'string', default: '' },
  'init-author-url': { type: 'url', default: '' },
  'init-license': { type: 'string', default: 'ISC' },
  'init-version': { type: 'semver', default: '1.0.0' },
  'init-module': { type: 'path', default: '~/.npm-init.js' },
  'init.author.name': { type: 'string', default: '', deprecated: 'Use `--init-author-name` instead.' },
  'init.author.email': { type: 'string', default: '', deprecated: 'Use `--init-author-email` instead.' },
  'init.author.url': { type: 'url', default: '', deprecated: 'Use `--init-author-url` instead.' },
  'init.license': { type: 'string', default: 'ISC', deprecated: 'Use `--init-license` instead.' },
  'init.version': { type: 'semver', default: '1.0.0', deprecated: 'Use `--init-version` instead.' },
  'save-exact': { type: 'boolean', default: false },
  'save-prefix': { type: 'string', default: '^' },
  userconfig: { type: 'path', default: '~/.npmrc' },
  globalconfig: { type: 'path', default: '' },
  prefix: { type: 'path', default: '' },
  loglevel: { type: 'string', default: 'notice' },
  workspace: { type: 'string-list', default: [] },
};

/** nopt's shorthands among them. */
const SHORTHANDS: Record<string, string[]> = {
  y: ['--yes'], f: ['--force'], g: ['--global'], E: ['--save-exact'], s: ['--loglevel', 'silent'],
  w: ['--workspace'], C: ['--prefix'], ws: ['--workspaces'],
};

/** The invalid-value message npm's type descriptions give. */
const INVALID: Partial<Record<ConfigType, string>> = {
  semver: 'Must be full valid SemVer string',
  url: 'Must be full url with "http://"',
};

/** A command line, as npm's nopt reads it: the flags it set, and the positional arguments. */
export interface NpmArgv {
  readonly cli: Record<string, unknown>;
  readonly positionals: string[];
}

/** nopt's parse of `argv` (the arguments after npm's subcommand). */
export function parseNpmArgv(argv: readonly string[]): NpmArgv {
  const cli: Record<string, unknown> = Object.create(null);
  const positionals: string[] = [];
  const args = [...argv];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    // A short flag, or several run together, by their expansions.
    if (!arg.startsWith('--')) {
      const letters = arg.slice(1).split('=')[0]!;
      const expansion = SHORTHANDS[letters]
        ?? (letters.split('').every((letter) => SHORTHANDS[letter]) ? letters.split('').flatMap((letter) => SHORTHANDS[letter]!) : null);
      if (expansion !== null) {
        const value = arg.includes('=') ? [arg.slice(arg.indexOf('=') + 1)] : [];
        args.splice(i, 1, ...expansion, ...value);
        i--;
        continue;
      }
    }
    const equals = arg.indexOf('=');
    let key = (equals === -1 ? arg : arg.slice(0, equals)).replace(/^-+/, '');
    let negated = false;
    if (key.startsWith('no-') && !(key in DEFINITIONS)) {
      key = key.slice(3);
      negated = true;
    }
    const type = DEFINITIONS[key]?.type;
    const boolean = type === 'boolean' || type === 'nullable-boolean' || (type === undefined && equals === -1);
    if (equals !== -1) {
      cli[key] = negated ? false : arg.slice(equals + 1);
    } else if (boolean) {
      const next = args[i + 1];
      if (next === 'true' || next === 'false') {
        cli[key] = negated ? next !== 'true' : next === 'true';
        i++;
      } else {
        cli[key] = !negated;
      }
    } else {
      // A typed value takes the next argument, unless that is `--`.
      const next = args[i + 1];
      const value = next === undefined || /^-{2,}$/.test(next) ? '' : next;
      if (next !== undefined && !/^-{2,}$/.test(next)) i++;
      if (type === 'string-list') cli[key] = [...((cli[key] as string[] | undefined) ?? []), value];
      else cli[key] = value;
    }
  }
  return { cli, positionals };
}

/** npm's configuration, loaded: each key from the first layer that sets it. */
export interface NpmConfig {
  get(key: string): unknown;
  /** The directory whose `.npmrc` is the project's (and npm's working package's). */
  readonly localPrefix: string;
  /** npm's warnings of the load, each one line for `npm warn `. */
  readonly warnings: readonly string[];
}

/** `${VAR}` in `text`, from `env` (@npmcli/config env-replace.js), backslashes escaping. */
export function npmEnvReplace(text: string, env: Record<string, string>): string {
  return text.replace(/(?<!\\)(\\*)\$\{([^${}]+)\}/g, (original, escapes: string, name: string) => {
    const value = env[name] !== undefined ? env[name] : `\${${name}}`;
    if (escapes.length % 2) return original.slice((escapes.length + 1) / 2);
    return escapes.slice(escapes.length / 2) + value;
  });
}

/** Load npm's configuration for a command run in `cwd` with `env` and the flags of `argv`. */
export async function loadNpmConfig(vfs: VFS, cwd: string, env: Record<string, string>, argv: NpmArgv): Promise<NpmConfig> {
  const home = env.HOME || '/home/user';
  const warnings: string[] = [];
  // Highest first, as get reads them; `source` names one in a warning.
  const layers: Array<{ where: string; source: string; data: Record<string, unknown> }> = [];
  const parse = (value: unknown, key: string): unknown => {
    if (typeof value !== 'string') return value;
    const type = DEFINITIONS[key]?.type;
    let text = value.trim();
    if ((type === 'boolean' || type === 'nullable-boolean') && text === '') return true;
    if (type !== 'string' && type !== 'path') {
      switch (text) {
        case 'true': return true;
        case 'false': return false;
        case 'null': return null;
        case 'undefined': return undefined;
      }
    }
    text = npmEnvReplace(text, env);
    if (type === 'path') text = /^~\//.test(text) ? resolve(home, text.slice(2)) : resolve(cwd, text);
    if (type === 'string-list') return [text];
    return text;
  };
  const layer = (where: string, source: string, raw: Record<string, unknown> | null): void => {
    const data: Record<string, unknown> = Object.create(null);
    for (const [rawKey, value] of Object.entries(raw ?? {})) {
      const key = npmEnvReplace(rawKey, env);
      data[key] = parse(value, key);
      const deprecated = DEFINITIONS[rawKey]?.deprecated;
      if (deprecated !== undefined) warnings.push(`config ${key} ${deprecated}`);
    }
    layers.push({ where, source, data });
  };
  const get = (key: string): unknown => {
    for (const { data } of layers) if (key in data) return data[key];
    return undefined;
  };
  const readFile = async (path: string): Promise<Record<string, unknown> | null> => {
    try {
      return ini.decode(await vfs.readFileString(path));
    } catch {
      return null;
    }
  };

  layer('cli', 'command line options', argv.cli);
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
      if (await exists(vfs, `${dir === '/' ? '' : dir}/package.json`) || await exists(vfs, `${dir === '/' ? '' : dir}/node_modules`)) {
        localPrefix = dir;
        break;
      }
      if (dir === '/') break;
    }
    localPrefix ||= cwd;
  }
  const userconfig = (): string => String(get('userconfig') ?? resolve(home, '.npmrc'));
  const projectFile = resolve(localPrefix, '.npmrc');
  if (get('global') !== true && projectFile !== userconfig()) layer('project', projectFile, await readFile(projectFile));
  const userFile = userconfig();
  layer('user', userFile, await readFile(userFile));
  const prefix = String(get('prefix') ?? (env.PREFIX || '/usr/local'));
  const globalFile = String(get('globalconfig') || resolve(prefix, 'etc/npmrc'));
  layer('global', globalFile, await readFile(globalFile));

  // npm's validation, in its layers' order (global, user, project, env, cli).
  for (const { source, data } of [...layers].reverse()) {
    for (const [key, value] of Object.entries(data)) {
      const type = DEFINITIONS[key]?.type;
      let valid: unknown = value;
      if (type === 'semver') valid = semver.valid(value) ?? undefined;
      else if (type === 'url') valid = urlValue(value);
      if (valid === undefined && (type === 'semver' || type === 'url')) {
        warnings.push(`invalid config ${key}=${JSON.stringify(value)} set in ${source}`, `invalid config ${INVALID[type]}`);
        delete data[key];
      } else {
        data[key] = valid;
      }
    }
  }

  return {
    get: (key) => {
      const value = get(key);
      return value === undefined ? DEFINITIONS[key]?.default : value;
    },
    localPrefix,
    warnings,
  };
}

/** nopt's url type: a URL with a host, as its href; undefined for anything else. */
function urlValue(value: unknown): string | undefined {
  if (value === '') return '';
  try {
    const url = new URL(String(value));
    return url.host ? url.href : undefined;
  } catch {
    return undefined;
  }
}

async function exists(vfs: VFS, path: string): Promise<boolean> {
  try {
    return await vfs.exists(path);
  } catch {
    return false;
  }
}
