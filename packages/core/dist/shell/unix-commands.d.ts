/**
 * unix-commands.ts — the Unix commands that need the shell's own machinery:
 * credentials, mounts, command resolution (which/type/command/xargs) and the
 * durable store's metadata. Every command is a real implementation; the
 * pure byte/text tools are the substrate's (substrate/lifo/commands), which
 * `textCommand` wraps where this module registers one of them.
 * `registerUnixCommands` at the end is the list.
 */
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import { type CommandRegistry } from '../substrate/lifo/commands/registry.js';
export declare function registerUnixCommands(registry: CommandRegistry, sqliteVfs: SqliteVFS): void;
//# sourceMappingURL=unix-commands.d.ts.map