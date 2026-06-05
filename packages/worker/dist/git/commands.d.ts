/**
 * git-commands.ts — Nimbus v2.0 Git integration via isomorphic-git.
 *
 * Provides a full `git` command with subcommands:
 * init, clone, status, add, commit, log, branch, checkout,
 * diff, remote, fetch, pull, push, merge, reset, tag, stash
 *
 * Uses a VFS→isomorphic-git FS adapter that maps all operations
 * to the SqliteVFS.
 */
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
export declare function registerGitCommands(registry: any, vfs: SqliteVFS, doCtx?: DurableObjectState, doEnv?: any): void;
//# sourceMappingURL=commands.d.ts.map