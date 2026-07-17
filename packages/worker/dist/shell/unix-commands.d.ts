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
 * touch, stat, file, xxd, base64, sha256sum, id, hostname, realpath
 */
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
export declare function registerUnixCommands(registry: any, sqliteVfs: SqliteVFS): void;
//# sourceMappingURL=unix-commands.d.ts.map