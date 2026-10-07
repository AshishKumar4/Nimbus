import type { CommandContext } from '../types.js';
import type { ProcessView as VFS } from '../../../../runtime/process-files.js';
import { type NpmConfig } from './npm-config.js';
/** An npm error: its code, and its message's lines, each printed `npm error <line>`. */
export declare class NpmError extends Error {
    readonly code?: string | undefined;
    constructor(message: string, code?: string | undefined);
}
/**
 * The package `npm init <initializer>` runs (init.js execCreate): `@scope`
 * is `@scope/create`, a hosted git repository `user/project` is
 * `user/create-project`, a registry package `name@spec` is
 * `create-name@spec` (`@scope/create-name@spec` for a scoped one); anything
 * else is not an initializer.
 */
export declare function npmInitializerPackage(initializer: string): string;
/**
 * `npm init`, `npm create` and `npm innit` (npm.ts loads this module for
 * them): with an initializer, npm exec's run of the package it names (npx);
 * without, npm's own package.json, asked for on the command's input unless
 * under `yes`.
 */
export declare function npmInitCommand(ctx: CommandContext): Promise<number>;
/** The terminal the template asks its questions on. */
export interface NpmInitIo {
    /** Print `text` to standard output. */
    print(text: string): Promise<void>;
    /** Show `question` and read one line; null when the input ended. Throws NpmInitCanceled on ^C. */
    ask(question: string): Promise<string | null>;
}
/** ^C at a question: npm warns `init canceled`. */
export declare class NpmInitCanceled extends Error {
}
/** How the template ended: written, refused at "Is this OK?", or the input ended mid-question. */
export type NpmInitOutcome = 'written' | 'aborted' | 'ended';
/** `npm init` without an initializer in `dir` (init.js template, init-package-json). */
export declare function npmInitTemplate(vfs: VFS, dir: string, config: NpmConfig, io: NpmInitIo): Promise<NpmInitOutcome>;
//# sourceMappingURL=npm-init.d.ts.map