/**
 * git/commands.ts — Nimbus v2.0 Git integration via isomorphic-git.
 *
 * Provides a full `git` command with subcommands:
 * init, clone, status, add, commit, log, branch, checkout, diff,
 * ls-files, rev-parse, remote, fetch, pull, push, merge, reset, tag
 *
 * Uses a VFS→isomorphic-git FS adapter over the command's view of the
 * namespace, as its credential: a repository on SQLite or on a mount alike.
 */
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { type ProcessView } from '@nimbus-sh/core/runtime/process-files.js';
import { DirCache } from './worktree/dircache.js';
type OutputStream = {
    write(s: string): void | Promise<void>;
    /** Present on sinks that keep bytes verbatim (files, byte-capable pipes). */
    writeBytes?(bytes: Uint8Array): void | Promise<void>;
};
type Ctx = {
    pid: number;
    cred: VfsCred;
    args: string[];
    stdout: OutputStream;
    stderr: OutputStream;
    cwd: string;
    env: Record<string, string>;
    /** The command's view of the namespace, as its credential. */
    vfs: ProcessView;
};
export interface ParsedGitGlobals {
    sub: string | undefined;
    subArgs: string[];
    /** The directory the subcommand runs in, after every `-C`. */
    dir: string;
}
/**
 * The options git accepts BEFORE the subcommand. `-C <path>` runs the
 * command as if started from <path>; repeated, each is relative to the
 * previous (`git -C a -C b` runs in `a/b`). `--no-pager` and `-P` are
 * accepted and mean nothing here, there is no pager. Any other leading
 * option is refused: swallowing it would run the next word as a subcommand.
 */
export declare function parseGitGlobals(args: string[], cwd: string): ParsedGitGlobals;
export interface ParsedCloneArgs {
    url: string | undefined;
    dest: string | undefined;
    depth: number | undefined;
    noShallow: boolean;
    isBg: boolean;
    branch: string | undefined;
    /** `-q`/`--quiet`: no progress on stdout; errors still reach stderr. */
    quiet: boolean;
    /** `--filter=<spec>`, as git stores it in remote.<name>.partialclonefilter. */
    filter: string | undefined;
}
export declare const CLONE_USAGE = "usage: git clone [-q | --quiet] [--depth <n>] [--no-shallow] [--filter=<spec>] [--branch <name> | -b <name>] [--bg] <url> [dir]";
/**
 * A partial clone's filter (list-objects-filter-options.c), normalized as
 * git normalizes it: blob:limit's size in bytes. The filters Nimbus
 * fetches with; any other is refused by name rather than ignored.
 */
export declare function parseCloneFilter(spec: string): string;
/**
 * Every flag is either handled or refused loudly. Silently skipping unknown
 * flags corrupted positionals for value-taking ones (`--branch dev URL`
 * parsed `dev` as the URL) and silently no-opped `--filter=blob:none` — a
 * "blobless" clone that was not blobless.
 */
export declare function parseCloneArgs(args: string[]): ParsedCloneArgs;
/**
 * The index entries that restoring `restored` replaces (add_index_entry_with_check):
 * a file at one of a restored path's leading directories, or anything below a
 * restored path. Each restored path costs lookups, not a pass over the index.
 */
export declare function replacedIndexEntries(dc: DirCache, restored: ReadonlySet<string>): Set<number>;
/**
 * The `git` command handler. Split out from registration so it can be
 * lazy-loaded (`await import('./commands.js')`) on first `git` use, keeping
 * this module and its ~106 KB network-facet dependency out of the cold
 * script-eval graph.
 */
export declare function runGitCommand(ctx: Ctx, vfs: SqliteVFS, doCtx?: DurableObjectState, doEnv?: any): Promise<number>;
export {};
//# sourceMappingURL=commands.d.ts.map