import type { Command, CommandContext } from '../types.js';
import { type CommandRegistry } from '../registry.js';
import type { ProcessView as VFS } from '../../../../runtime/process-files.js';
import type { Kernel } from '../../kernel/index.js';
import { type NpmLogEmitter } from './npm-log.js';
/** The registry an install reads from when its env names none. */
export declare const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";
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
 * resolved prefix so the host — not this command — owns where
 * `<prefix>/lib/node_modules` and `<prefix>/bin` land.
 */
export interface NpmInstallPort {
    install(spec: {
        projectDir: string;
        packages: readonly string[];
        global: boolean;
        /** Resolved absolute prefix — present only when `global` is set. */
        globalPrefix?: string;
        /** The running command's pid — authorizes the host's batch writes. */
        pid: number;
        /** Registry origin from the command's env (`NPM_REGISTRY`), else the default. */
        registry: string;
        production?: boolean;
        /** `npm ci`: validate package-lock.json, remove node_modules, place exactly what the lock records. */
        fromLockfile?: boolean;
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
/**
 * The registry origin an install uses: the command's `NPM_REGISTRY`, else
 * the default. Normalized once, here, where the setting is read: blank is
 * unset, and a trailing slash is trimmed so one origin spelled two ways
 * shares one cache namespace downstream.
 */
export declare function npmRegistryOrigin(configured: string | undefined): string;
/** A package's bins, name -> target inside the package, as npm installs them (npmBinMap). */
/**
 * The packages in a node_modules directory, by name (`pkg` or `@scope/pkg`):
 * each entry that is a directory or a link (an `npm link`ed or workspace
 * package), a scope's entries in its place. Names starting with `.` (`.bin`,
 * `.package-lock.json`) are npm's own files, not packages; a directory that
 * cannot be read holds none.
 */
export declare function packagesIn(vfs: VFS, modulesDir: string): AsyncGenerator<string>;
export declare function getBinEntries(pkg: PackageJson): Record<string, string>;
export declare function registerBinCommand(registry: CommandRegistry, binName: string, scriptPath: string, kernel?: Kernel): void;
export declare function createNpmCommand(registry: CommandRegistry, shellExecute?: ShellExecuteFn, kernel?: Kernel, deps?: NpmCommandDeps): Command;
export declare function createNpxCommand(registry: CommandRegistry, shellExecute?: ShellExecuteFn): Command;
export declare function npmInstallGlobal(packageName: string, ctx: CommandContext, registry: CommandRegistry, kernel?: Kernel): Promise<number>;
export {};
//# sourceMappingURL=npm.d.ts.map