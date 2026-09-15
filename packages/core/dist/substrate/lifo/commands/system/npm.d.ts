import type { Command, CommandContext } from '../types.js';
import type { CommandRegistry } from '../registry.js';
import type { Kernel } from '../../kernel/index.js';
import { type NpmLogEmitter } from './npm-log.js';
export declare const NPM_VERSION = "10.0.0";
interface PackageJson {
    name?: string;
    version?: string;
    description?: string;
    main?: string;
    bin?: string | Record<string, string>;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    license?: string;
    author?: string | {
        name: string;
    };
}
export type ShellExecuteFn = (cmd: string, ctx: CommandContext) => Promise<number>;
/**
 * The host's piece of `npm install`: once the invocation has been parsed
 * into a spec and the summary output decided, the install itself is
 * whatever the host's batched installer does. Global installs carry the
 * resolved bin directory so the host — not this command — owns where
 * shims land and who exposes them.
 */
export interface NpmInstallPort {
    install(spec: {
        projectDir: string;
        packages: readonly string[];
        global: boolean;
        /** Resolved absolute bin directory — present only when `global` is set. */
        globalBinDir?: string;
        production?: boolean;
        npmLog?: NpmLogEmitter | null;
        onProgress?: (line: string) => void;
    }): Promise<{
        installed: string[];
        failed: string[];
        totalFiles?: number;
        fromCacheHits?: number;
        linkedBins?: number;
    }>;
}
export interface NpmCommandDeps {
    installer?: NpmInstallPort;
}
export declare function getBinEntries(pkg: PackageJson): Record<string, string>;
export declare function registerBinCommand(registry: CommandRegistry, binName: string, scriptPath: string, kernel?: Kernel): void;
export declare function createNpmCommand(registry: CommandRegistry, shellExecute?: ShellExecuteFn, kernel?: Kernel, deps?: NpmCommandDeps): Command;
export declare function createNpxCommand(registry: CommandRegistry, shellExecute?: ShellExecuteFn): Command;
export declare function npmInstallGlobal(packageName: string, ctx: CommandContext, registry: CommandRegistry, kernel?: Kernel): Promise<number>;
export {};
//# sourceMappingURL=npm.d.ts.map