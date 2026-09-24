/**
 * `df`, `mount` and `/proc/mounts`: three views of one table, the filesystem
 * authority's mount listing (`NimbusFilesystemAuthority.mounts`). An embedder
 * wrapping the authority adds its mounts there and all three show them.
 */
import type { CommandRegistry } from '../substrate/lifo/commands/registry.js';
import type { NimbusFilesystemAuthority, NimbusMountEntry } from '../runtime/os-contracts.js';
/** `/proc/mounts`, in the kernel's format. Usage is not part of it. */
export declare function formatProcMounts(entries: readonly NimbusMountEntry[]): string;
/** `df` and `mount` over `filesystem`'s listing, for the credential of the calling process. */
export declare function registerMountCommands(registry: CommandRegistry, filesystem: NimbusFilesystemAuthority): void;
//# sourceMappingURL=mount-commands.d.ts.map