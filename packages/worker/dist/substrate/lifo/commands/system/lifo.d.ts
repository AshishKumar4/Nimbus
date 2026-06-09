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
import type { VFS } from '../../kernel/vfs/index.js';
import type { Kernel } from '../../kernel/index.js';
import type { ShellExecuteFn } from './npm.js';
export declare function createLifoPkgCommand(registry: CommandRegistry, _shellExecute?: ShellExecuteFn, kernel?: Kernel): Command;
/**
 * Boot-time loader: restores dev-linked commands + re-registers
 * installed lifo packages with the lifo runtime.
 */
/**
 * Re-register all globally installed packages into the command registry.
 *
 * Handles two kinds of packages:
 *   - lifo packages (have a lifo.json manifest) → registered via the lifo runtime
 *   - regular npm packages (have a "bin" field in package.json) → registered via node runner
 *
 * Called on every daemon boot so that packages installed via `npm install -g`
 * or `lifo install` are available as shell commands, including after a snapshot
 * restore where the VFS has the files but the registry is freshly created.
 *
 * Also restores dev-linked packages.
 *
 * Safe to call on a fresh VM — it is a no-op when /usr/lib/node_modules is empty.
 */
export declare function rehydrateGlobalPackages(vfs: VFS, registry: CommandRegistry): void;
/** @deprecated Use rehydrateGlobalPackages() instead. */
export declare function bootLifoPackages(vfs: VFS, registry: CommandRegistry): void;
//# sourceMappingURL=lifo.d.ts.map