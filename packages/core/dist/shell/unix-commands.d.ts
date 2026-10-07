/**
 * unix-commands.ts — the Unix commands that need the shell's own machinery:
 * credentials, mounts, command resolution (which/type/command/xargs) and the
 * durable store's metadata. Every command is a real implementation; the
 * pure byte/text tools are the substrate's (substrate/lifo/commands), which
 * `textCommand` wraps where this module registers one of them.
 * `registerUnixCommands` at the end is the list.
 */
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { Command } from '../substrate/lifo/commands/types.js';
import { type ResolveContext } from '../substrate/lifo/commands/registry.js';
/**
 * The registry these commands dispatch through: registration, and name
 * resolution for `which`, `type`, `command` and `xargs`.
 * `resolve` answers `unknown` because the registry holds whatever any module
 * registered — and the worker's npm-bin fallback replaces the method outright
 * — so what comes back is a command only once it has been checked.
 */
type UnixCommandRegistry = {
    register(name: string, handler: Command): void;
    resolve(name: string, from?: ResolveContext): unknown;
};
export declare function registerUnixCommands(registry: UnixCommandRegistry, sqliteVfs: SqliteVFS): void;
export {};
//# sourceMappingURL=unix-commands.d.ts.map