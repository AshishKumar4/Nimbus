/**
 * git/worktree/repo.ts — one repository as the worktree commands see it:
 * its object store, its worktree, its exclude rules and its index file.
 *
 * Objects go through cf-git (loose objects) and the ranged pack store the
 * repository's filesystem carries; the worktree through the command's view
 * of the namespace. Configuration is cf-git's reading of .git/config, and
 * for core.excludesFile the global files git reads as well.
 */
import type { ProjectFs } from '../../runtime/project-fs.js';
import type { GitPacksSeam } from '../pack/store.js';
import { DirCache, type IndexEdit } from './dircache.js';
import { Excludes } from './excludes.js';
import { type ObjectStore } from './tree.js';
import { type WalkCounters, type Worktree, type WorktreeFs } from './walk.js';
/** The cf-git calls a repository makes. */
export interface RepoGit {
    readObject(args: {
        fs: unknown;
        dir: string;
        oid: string;
        cache: object;
        format: 'content';
    }): Promise<{
        type: string;
        object: unknown;
    }>;
    writeObject(args: {
        fs: unknown;
        dir: string;
        type: 'blob' | 'tree' | 'commit';
        object: Uint8Array;
        format: 'content';
    }): Promise<string>;
    getConfig(args: {
        fs: unknown;
        dir?: string;
        gitdir?: string;
        path: string;
    }): Promise<unknown>;
    resolveRef(args: {
        fs: unknown;
        gitdir: string;
        ref: string;
    }): Promise<string>;
}
/** createGitFs's adapter: cf-git's filesystem, with the repository's pack store. */
export interface GitFs {
    packs: GitPacksSeam;
    promises: Record<string, unknown> & {
        readFile(path: string, options?: unknown): Promise<Uint8Array | string>;
    };
}
/** git_config_bool's spellings. */
export declare function configBool(value: unknown): boolean | undefined;
export declare class WorktreeRepo {
    readonly vfs: ProjectFs;
    readonly git: RepoGit;
    readonly gitFs: GitFs;
    readonly root: string;
    readonly gitdir: string;
    private readonly env;
    readonly counters: WalkCounters;
    /** This command holds its repository's index lock. */
    private locked;
    readonly store: ObjectStore;
    readonly fs: WorktreeFs;
    private readonly cache;
    private worktreeConfig;
    /** `root` the worktree's top and `gitdir` its git directory, both absolute; `env` the command's. */
    constructor(vfs: ProjectFs, git: RepoGit, gitFs: GitFs, root: string, gitdir: string, env: Record<string, string>, counters?: WalkCounters);
    config(path: string): Promise<unknown>;
    /** The worktree with the settings its comparisons take. */
    worktree(): Promise<Worktree>;
    readIndex(): Promise<DirCache>;
    /** HEAD's tree, the empty tree while HEAD names no commit. */
    headTree(): Promise<string>;
    /** A pattern file's list, or none when it cannot be read. */
    private patternFile;
    /** A global config value: ~/.gitconfig over $XDG_CONFIG_HOME/git/config, as git reads them. */
    private globalConfig;
    /**
     * setup_standard_excludes: core.excludesFile (or $XDG_CONFIG_HOME/git/ignore,
     * else ~/.config/git/ignore), then $GIT_DIR/info/exclude, then each
     * directory's .gitignore. A .gitignore missing from a sparse worktree is
     * read from the index, as git reads a skip-worktree one.
     */
    excludes(dc: DirCache): Promise<Excludes>;
    /**
     * ce_smudge_racily_clean_entry for each entry this command never checked:
     * racily clean, its stat still matching, and its content no longer the blob.
     */
    private racilySmudged;
    /**
     * Run `fn` holding the repository's index lock: the index read in it is
     * the one its write replaces. A command that changes the index reads and
     * writes it in here; others wait their turn.
     */
    withIndexLock<T>(fn: () => Promise<T>): Promise<T>;
    /** write_locked_index: `dc` with `edit` applied, its racily clean entries smudged. Only under the lock. */
    writeIndex(dc: DirCache, edit?: IndexEdit): Promise<void>;
    /** The checksum the index file ends with now, null when there is none. */
    private currentTrailer;
    /**
     * repo_update_index_if_able: a status or diff, which read the index without
     * the lock, writes back what it refreshed (or an index with racy entries)
     * only if the index is still the one it read; a writer that came between
     * wins, and the refresh is simply not kept.
     */
    updateIndexIfAble(dc: DirCache): Promise<void>;
}
//# sourceMappingURL=repo.d.ts.map