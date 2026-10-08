/**
 * git/config-params.ts — `git -c <name>=<value>`: a setting for one command,
 * over every config file's (config.c git_config_push_parameter and
 * git_config_parse_key). The command's git reads through withConfigOverrides,
 * so each read of a key `-c` set answers it; nothing is written.
 */
/** A refusal of git's own options, in git's words, and the exit it takes. */
export class GitGlobalsError extends Error {
    lines;
    code;
    constructor(lines, code) {
        super(lines.trimEnd());
        this.lines = lines;
        this.code = code;
        this.name = 'GitGlobalsError';
    }
}
/** iskeychar: what a config section and variable name are made of. */
const KEY_CHAR = /^[A-Za-z0-9-]$/;
const ALPHA = /^[A-Za-z]$/;
/**
 * One `-c` text: the key before the first '=' (a missing '=' is a
 * boolean's true), its section and variable name in lower case, its
 * subsection as written. An invalid one is git's error, then "unable to
 * parse command-line config" (128).
 */
export function parseConfigParameter(text) {
    const eq = text.indexOf('=');
    const key = eq < 0 ? text : text.slice(0, eq);
    const value = eq < 0 ? 'true' : text.slice(eq + 1);
    const refuse = (error) => {
        throw new GitGlobalsError(`error: ${error}\nfatal: unable to parse command-line config\n`, 128);
    };
    // config_parse_pair, as git reads a split `-c` parameter back.
    if (key === '')
        refuse('empty config key');
    const lastDot = key.lastIndexOf('.');
    if (lastDot <= 0)
        refuse(`key does not contain a section: ${key}`);
    if (lastDot === key.length - 1)
        refuse(`key does not contain variable name: ${key}`);
    const firstDot = key.indexOf('.');
    let stored = '';
    for (let i = 0; i < key.length; i++) {
        const c = key[i];
        // The subsection, between the first dot and the last, is kept as written.
        if (i > firstDot && i < lastDot) {
            if (c === '\n')
                refuse(`invalid key (newline): ${key}`);
            stored += c;
        }
        else if (c === '.') {
            stored += c;
        }
        else if (!KEY_CHAR.test(c) || (i === lastDot + 1 && !ALPHA.test(c))) {
            refuse(`invalid key: ${key}`);
        }
        else {
            stored += c.toLowerCase();
        }
    }
    return [stored, value];
}
/** A config key as `-c` stores it: section and variable name in lower case, the subsection kept. */
function configKey(path) {
    const first = path.indexOf('.');
    const last = path.lastIndexOf('.');
    if (first < 0)
        return path.toLowerCase();
    return path.slice(0, first).toLowerCase() + path.slice(first, last) + path.slice(last).toLowerCase();
}
/**
 * `git` with `overrides` over every file's: a key `-c` set reads as its last
 * value, and all of them after the files' for a read of every value.
 */
export function withConfigOverrides(git, overrides) {
    if (overrides.size === 0)
        return git;
    const reads = {
        async getConfig(args) {
            const values = overrides.get(configKey(args.path));
            return values !== undefined ? values[values.length - 1] : await git.getConfig(args);
        },
        async getConfigAll(args) {
            return [...await git.getConfigAll(args), ...(overrides.get(configKey(args.path)) ?? [])];
        },
    };
    return new Proxy(git, {
        get: (target, property, receiver) => property === 'getConfig' || property === 'getConfigAll' ? reads[property] : Reflect.get(target, property, receiver),
    });
}
