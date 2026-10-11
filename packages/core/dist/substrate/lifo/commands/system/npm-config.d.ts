import type { ProcessView as VFS } from '../../../../runtime/process-files.js';
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
export declare function loadNpmConfig(vfs: VFS, cwd: string, env: Record<string, string>, argv: readonly string[]): Promise<NpmConfig>;
//# sourceMappingURL=npm-config.d.ts.map