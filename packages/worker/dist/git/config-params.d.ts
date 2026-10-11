/**
 * git/config-params.ts — `git -c <name>=<value>`: a setting for one command,
 * over every config file's (config.c git_config_push_parameter and
 * git_config_parse_key). The command's git reads through withConfigOverrides,
 * so each read of a key `-c` set answers it; nothing is written.
 */
/** A refusal of git's own options, in git's words, and the exit it takes. */
export declare class GitGlobalsError extends Error {
    readonly lines: string;
    readonly code: number;
    constructor(lines: string, code: number);
}
/** `-c`'s settings in order; null is a name-only value (boolean true, raw config value absent). */
export type ConfigOverrides = Map<string, Array<string | null>>;
/**
 * One `-c` text: the key before the first '=' (a missing '=' is a
 * boolean's true), its section and variable name in lower case, its
 * subsection as written. An invalid one is git's error, then "unable to
 * parse command-line config" (128).
 */
export declare function parseConfigParameter(text: string): [key: string, value: string | null];
/** The config reads of cf-git (isomorphic-git's getConfig and getConfigAll). */
interface ConfigReader {
    getConfig(args: {
        path: string;
    }): Promise<unknown>;
    getConfigAll(args: {
        path: string;
    }): Promise<unknown[]>;
}
/**
 * `git` with `overrides` over every file's: a key `-c` set reads as its last
 * value, and all of them after the files' for a read of every value.
 */
export declare function withConfigOverrides<G extends ConfigReader>(git: G, overrides: ConfigOverrides): G;
export {};
//# sourceMappingURL=config-params.d.ts.map