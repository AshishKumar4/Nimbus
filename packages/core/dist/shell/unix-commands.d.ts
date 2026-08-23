/**
 * unix-commands.ts — Nimbus v2.0 Unix command implementations.
 *
 * Every command is a real implementation operating on SqliteVFS.
 * No stubs, no "not implemented" — each does actual work.
 *
 * Commands: which, env, export, unset, history, clear, alias, date,
 * uptime, tree, find, grep -r, head, tail, wc, diff, sort, uniq,
 * sed (s///), awk (field extract), xargs, tee, chown, ln -s,
 * du, man/help, basename, dirname, printf, true, false, seq, sleep,
 * touch, stat, file, xxd, od, hexdump, base64, sha256sum, id, hostname,
 * realpath
 */
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { Command } from '../substrate/lifo/commands/types.js';
/**
 * The registry these commands dispatch through: registration, and name
 * resolution for `which`, `type`, `command`, `find -exec` and `xargs`.
 * `resolve` answers `unknown` because the registry holds whatever any module
 * registered — and the worker's npm-bin fallback replaces the method outright
 * — so what comes back is a command only once it has been checked.
 */
type UnixCommandRegistry = {
    register(name: string, handler: Command): void;
    resolve(name: string): unknown;
};
export declare function registerUnixCommands(registry: UnixCommandRegistry, sqliteVfs: SqliteVFS): void;
export {};
//# sourceMappingURL=unix-commands.d.ts.map