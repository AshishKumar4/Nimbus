import type { ProcessView as VFS } from '../../../../runtime/process-files.js';
/** A command line, as npm's nopt reads it: the flags it set, and the positional arguments. */
export interface NpmArgv {
    readonly cli: Record<string, unknown>;
    readonly positionals: string[];
}
/** nopt's parse of `argv` (the arguments after npm's subcommand). */
export declare function parseNpmArgv(argv: readonly string[]): NpmArgv;
/** npm's configuration, loaded: each key from the first layer that sets it. */
export interface NpmConfig {
    get(key: string): unknown;
    /** The directory whose `.npmrc` is the project's (and npm's working package's). */
    readonly localPrefix: string;
    /** npm's warnings of the load, each one line for `npm warn `. */
    readonly warnings: readonly string[];
}
/** `${VAR}` in `text`, from `env` (@npmcli/config env-replace.js), backslashes escaping. */
export declare function npmEnvReplace(text: string, env: Record<string, string>): string;
/** Load npm's configuration for a command run in `cwd` with `env` and the flags of `argv`. */
export declare function loadNpmConfig(vfs: VFS, cwd: string, env: Record<string, string>, argv: NpmArgv): Promise<NpmConfig>;
//# sourceMappingURL=npm-config.d.ts.map