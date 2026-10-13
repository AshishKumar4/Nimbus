/**
 * git/config-params.ts — `git -c <name>=<value>`: a setting for one command,
 * over every config file's (config.c git_config_push_parameter and
 * git_config_parse_key). The command's git reads through withConfigOverrides,
 * so each read of a key `-c` set answers it; nothing is written.
 */

/** A refusal of git's own options, in git's words, and the exit it takes. */
export class GitGlobalsError extends Error {
  constructor(readonly lines: string, readonly code: number) {
    super(lines.trimEnd());
    this.name = 'GitGlobalsError';
  }
}

/** `-c`'s settings in order; null is a name-only value (boolean true, raw config value absent). */
export type ConfigOverrides = Map<string, Array<string | null>>;

/** iskeychar: what a config section and variable name are made of. */
const KEY_CHAR = /^[A-Za-z0-9-]$/;
const ALPHA = /^[A-Za-z]$/;

/**
 * One `-c` text: the key before the first '=' (a missing '=' is a
 * boolean's true), its section and variable name in lower case, its
 * subsection as written. An invalid one is git's error, then "unable to
 * parse command-line config" (128).
 */
export function parseConfigParameter(text: string): [key: string, value: string | null] {
  const eq = text.indexOf('=');
  const key = eq < 0 ? text : text.slice(0, eq);
  const value = eq < 0 ? null : text.slice(eq + 1);
  const refuse = (error: string): never => {
    throw new GitGlobalsError(`error: ${error}\nfatal: unable to parse command-line config\n`, 128);
  };
  // config_parse_pair, as git reads a split `-c` parameter back.
  if (key === '') refuse('empty config key');
  const lastDot = key.lastIndexOf('.');
  if (lastDot <= 0) refuse(`key does not contain a section: ${key}`);
  if (lastDot === key.length - 1) refuse(`key does not contain variable name: ${key}`);
  const firstDot = key.indexOf('.');
  let stored = '';
  for (let i = 0; i < key.length; i++) {
    const c = key[i];
    // The subsection, between the first dot and the last, is kept as written.
    if (i > firstDot && i < lastDot) {
      if (c === '\n') refuse(`invalid key (newline): ${key}`);
      stored += c;
    } else if (c === '.') {
      stored += c;
    } else if (!KEY_CHAR.test(c) || (i === lastDot + 1 && !ALPHA.test(c))) {
      refuse(`invalid key: ${key}`);
    } else {
      stored += c.toLowerCase();
    }
  }
  return [stored, value];
}

/**
 * git_config_bool's spellings, from a file or command override: a key with no
 * `=` is null in the override (git's true), and an explicit empty value is ''
 * (git's false). cf-git may already have decoded a stored value to a boolean.
 */
export function configBool(value: unknown): boolean | undefined {
  if (value === null) return true;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const text = value.toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(text)) return true;
  if (['false', 'no', 'off', '0', ''].includes(text)) return false;
  return undefined;
}

/** A config key as `-c` stores it: section and variable name in lower case, the subsection kept. */
function configKey(path: string): string {
  const first = path.indexOf('.');
  const last = path.lastIndexOf('.');
  if (first < 0) return path.toLowerCase();
  return path.slice(0, first).toLowerCase() + path.slice(first, last) + path.slice(last).toLowerCase();
}

/** The config reads of cf-git (isomorphic-git's getConfig and getConfigAll). */
interface ConfigReader {
  getConfig(args: { path: string }): Promise<unknown>;
  getConfigAll(args: { path: string }): Promise<unknown[]>;
}

/** The global files in git's order, read by cf-git's canonical config parser. */
export function withGlobalConfig<G extends ConfigReader>(git: G, fs: {
  promises: { readFile(path: string, options?: 'utf8' | { encoding: 'utf8' }): Promise<Uint8Array | string> };
}, env: Record<string, string>, cwd: string): G {
  const home = env.HOME;
  const xdg = env.XDG_CONFIG_HOME || (home ? `${home}/.config` : '');
  const files = (env.GIT_CONFIG_GLOBAL !== undefined ? [env.GIT_CONFIG_GLOBAL]
    : [...(xdg ? [`${xdg}/git/config`] : []), ...(home ? [`${home}/.gitconfig`] : [])])
    .map((file) => file.startsWith('/') ? file : `${cwd}/${file}`);
  if (files.length === 0) return git;
  const contents = new Map<string, ReturnType<typeof fs.promises.readFile>>();
  const read = (file: string, options?: 'utf8' | { encoding: 'utf8' }) => {
    let content = contents.get(file);
    if (content === undefined) { content = fs.promises.readFile(file, options); contents.set(file, content); }
    return content;
  };
  const values = new Map<string, ReturnType<ConfigReader['getConfigAll']>>();
  const globals = (path: string): ReturnType<ConfigReader['getConfigAll']> => {
    const key = configKey(path);
    let found = values.get(key);
    if (found === undefined) {
      found = (async () => {
        const all: Awaited<ReturnType<ConfigReader['getConfigAll']>> = [];
        for (const file of files) {
          const gitdir = `${file}.nimbus`;
          const request = {
            path,
            gitdir,
            fs: { promises: { ...fs.promises, readFile: (name: string, options?: 'utf8' | { encoding: 'utf8' }) => read(name === `${gitdir}/config` ? file : name, options) } },
          };
          all.push(...await git.getConfigAll(request));
        }
        return all;
      })();
      values.set(key, found);
    }
    return found;
  };
  const reads: ConfigReader = {
    async getConfig(args) {
      const local = await git.getConfig(args);
      if (local !== undefined || ('fs' in args && args.fs !== fs)) return local;
      const all = await globals(args.path);
      return all[all.length - 1];
    },
    async getConfigAll(args) {
      const local = await git.getConfigAll(args);
      if ('fs' in args && args.fs !== fs) return local;
      return [...await globals(args.path), ...local];
    },
  };
  return new Proxy(git, {
    get: (target, property, receiver) =>
      property === 'getConfig' || property === 'getConfigAll' ? reads[property] : Reflect.get(target, property, receiver),
  });
}

/** The repository a read names: its gitdir, else its worktree's .git (as cf-git takes `dir`). */
function gitdirOf(args: { path: string }): string | null {
  if ('gitdir' in args && typeof args.gitdir === 'string') return args.gitdir;
  if ('dir' in args && typeof args.dir === 'string') return `${args.dir}/.git`;
  return null;
}

/**
 * `git` with a repository's config.worktree over its config where the
 * repository sets extensions.worktreeConfig: git reads system, global,
 * local, worktree, then -c (withConfigOverrides, over this). Whether it is
 * set is the repository's own config's (`files`, cf-git reading only that
 * file), read once per repository until this command writes a config.
 */
export function withWorktreeConfig<G extends ConfigReader & { setConfig(args: { path: string }): Promise<void> }>(git: G, files: ConfigReader, fs: {
  promises: { readFile(path: string, options?: 'utf8' | { encoding: 'utf8' }): Promise<Uint8Array | string> };
}): G {
  const enabled = new Map<string, Promise<boolean>>();
  const worktreeConfig = (args: { path: string }): Promise<string | null> | null => {
    const gitdir = 'fs' in args && args.fs === fs ? gitdirOf(args) : null;
    if (gitdir === null) return null;
    let known = enabled.get(gitdir);
    if (known === undefined) {
      known = files.getConfig({ fs, gitdir, path: 'extensions.worktreeConfig' }).then((value) => configBool(value) === true, () => false);
      enabled.set(gitdir, known);
    }
    return known.then((on) => (on ? gitdir : null));
  };
  /** cf-git's read of `path` in `gitdir`'s config.worktree, offered as the config of a gitdir of its own. */
  const inWorktreeFile = (gitdir: string, path: string) => {
    const file = `${gitdir}/config.worktree`;
    const own = `${file}.nimbus`;
    return {
      path,
      gitdir: own,
      fs: { promises: { ...fs.promises, readFile: (name: string, options?: 'utf8' | { encoding: 'utf8' }) => fs.promises.readFile(name === `${own}/config` ? file : name, options) } },
    };
  };
  const calls = {
    async getConfig(args: { path: string }) {
      const gitdir = await worktreeConfig(args);
      if (gitdir !== null) {
        const own = await git.getConfig(inWorktreeFile(gitdir, args.path)).catch(() => undefined);
        if (own !== undefined) return own;
      }
      return await git.getConfig(args);
    },
    async getConfigAll(args: { path: string }) {
      const all = await git.getConfigAll(args);
      const gitdir = await worktreeConfig(args);
      if (gitdir === null) return all;
      return [...all, ...await git.getConfigAll(inWorktreeFile(gitdir, args.path)).catch(() => [])];
    },
    async setConfig(args: { path: string }) {
      enabled.clear();
      await git.setConfig(args);
    },
  };
  return new Proxy(git, {
    get: (target, property, receiver) =>
      property === 'getConfig' || property === 'getConfigAll' || property === 'setConfig' ? calls[property] : Reflect.get(target, property, receiver),
  });
}

/**
 * `git` with `overrides` over every file's: a key `-c` set reads as its last
 * value, and all of them after the files' for a read of every value.
 */
export function withConfigOverrides<G extends ConfigReader>(git: G, overrides: ConfigOverrides): G {
  if (overrides.size === 0) return git;
  const reads: ConfigReader = {
    async getConfig(args) {
      const values = overrides.get(configKey(args.path));
      return values !== undefined ? values[values.length - 1] : await git.getConfig(args);
    },
    async getConfigAll(args) {
      return [...await git.getConfigAll(args), ...(overrides.get(configKey(args.path)) ?? [])];
    },
  };
  return new Proxy(git, {
    get: (target, property, receiver) =>
      property === 'getConfig' || property === 'getConfigAll' ? reads[property] : Reflect.get(target, property, receiver),
  });
}
