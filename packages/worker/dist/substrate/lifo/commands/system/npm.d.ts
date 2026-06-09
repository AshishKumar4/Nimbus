import type { Command, CommandContext } from '../types.js';
import type { CommandRegistry } from '../registry.js';
import type { Kernel } from '../../kernel/index.js';
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
export declare function getBinEntries(pkg: PackageJson): Record<string, string>;
export declare function registerBinCommand(registry: CommandRegistry, binName: string, scriptPath: string, kernel?: Kernel): void;
export declare function createNpmCommand(registry: CommandRegistry, shellExecute?: ShellExecuteFn, kernel?: Kernel): Command;
export declare function createNpxCommand(registry: CommandRegistry, shellExecute?: ShellExecuteFn): Command;
export declare function npmInstallGlobal(packageName: string, ctx: CommandContext, registry: CommandRegistry, kernel?: Kernel): Promise<number>;
export {};
//# sourceMappingURL=npm.d.ts.map