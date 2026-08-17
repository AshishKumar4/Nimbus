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
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
export interface ParsedCloneArgs {
    url: string | undefined;
    dest: string | undefined;
    depth: number | undefined;
    noShallow: boolean;
    isBg: boolean;
    branch: string | undefined;
}
export declare const CLONE_USAGE = "usage: git clone [--depth <n>] [--no-shallow] [--branch <name> | -b <name>] [--bg] <url> [dir]";
/**
 * Every flag is either handled or refused loudly. Silently skipping unknown
 * flags corrupted positionals for value-taking ones (`--branch dev URL`
 * parsed `dev` as the URL) and silently no-opped `--filter=blob:none` — a
 * "blobless" clone that was not blobless.
 */
export declare function parseCloneArgs(args: string[]): ParsedCloneArgs;
export declare function registerGitCommands(registry: any, vfs: SqliteVFS, doCtx?: DurableObjectState, doEnv?: any): void;
//# sourceMappingURL=commands.d.ts.map