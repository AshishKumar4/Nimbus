/**
 * Dev-link management for lifo packages.
 *
 * Stores a registry at /etc/lifo/dev-links.json that maps command names
 * to local VFS paths.  `lifo link` adds entries, `lifo unlink` removes them.
 */
import type { ExecutionFs as VFS } from '../../../shell/execution-fs.js';
import type { CommandRegistry } from '../commands/registry.js';
export interface DevLink {
    /** Absolute VFS path to the package root. */
    path: string;
    /** command name -> relative entry path (from lifo.commands). */
    commands: Record<string, string>;
}
export type DevLinksMap = Record<string, DevLink>;
export declare function readDevLinks(vfs: VFS): Promise<DevLinksMap>;
export declare function writeDevLinks(vfs: VFS, links: DevLinksMap): Promise<void>;
/**
 * Link a local package directory for development.
 * Reads the lifo manifest from the directory's package.json and registers
 * all declared commands.
 *
 * Returns the list of command names registered.
 */
export declare function linkPackage(vfs: VFS, registry: CommandRegistry, pkgDir: string): Promise<string[]>;
/**
 * Unlink a previously dev-linked package.
 * Note: we cannot truly un-register commands from the registry, but we
 * remove the dev-link entry so they won't be restored on next boot.
 *
 * Returns the command names that were linked, or null if not found.
 */
export declare function unlinkPackage(vfs: VFS, pkgName: string): Promise<string[] | null>;
/**
 * Restore all dev-linked commands at boot time.
 */
export declare function loadDevLinks(vfs: VFS, registry: CommandRegistry): Promise<void>;
//# sourceMappingURL=lifo-dev.d.ts.map