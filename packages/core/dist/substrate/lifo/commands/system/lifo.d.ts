/**
 * lifo -- lifo package manager command.
 *
 * Subcommands:
 *   install|add <name>   install a lifo-pkg-* package (sugar over npm -g)
 *   remove  <name>       remove a lifo package
 *   list                 list installed lifo packages + dev links
 *   search  <term>       search npm for lifo-pkg-* packages
 *   init    <name>       scaffold a new lifo package template
 *   link    <path>       dev-link a local package directory
 *   unlink  <name>       remove a dev link
 */
import type { Command } from '../types.js';
import type { CommandRegistry } from '../registry.js';
import { ProcessView } from '../../../../runtime/process-files.js';
import type { Kernel } from '../../kernel/index.js';
import type { NpmCommandDeps, ShellExecuteFn } from './npm.js';
export declare function createLifoPkgCommand(registry: CommandRegistry, _shellExecute?: ShellExecuteFn, kernel?: Kernel, 
/** Its install port: the host's, else the shell's own. */
deps?: NpmCommandDeps): Command;
/**
 * Restore lifo's commands after a boot, into `registry`, for the host that
 * offers lifo (createLifoPkgCommand): its dev-linked packages', and those
 * of each lifo package npm installed globally, under the prefix npm's
 * configuration in `at` resolves. npm's own global bins need no restoring:
 * they are linked into the prefix's bin, and the shell finds them on PATH.
 */
export declare function rehydrateLifoPackages(vfs: ProcessView, registry: CommandRegistry, at: {
    cwd: string;
    env: Record<string, string>;
}): Promise<void>;
//# sourceMappingURL=lifo.d.ts.map