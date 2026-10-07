/**
 * git/worktree/repo.ts — one repository as the worktree commands see it:
 * its object store, its worktree, its exclude rules and its index file.
 *
 * Objects are read through cf-git (loose objects) and the ranged pack store
 * the repository's filesystem carries, and written as git writes a loose
 * object, by one flow (objectWriter): one at a time, or for a command that
 * writes many (add's blobs) in the shared wave writer's waves, straight into
 * the engine. The worktree goes through the command's view of the
 * namespace. Configuration is cf-git's reading of .git/config, and for
 * core.excludesFile the global files git reads as well.
 */
import type { WriteBatchStreamResult } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
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
/**
 * The engine, as the command's principal: where a repository on it takes
 * objects in waves. `key` is a path's engine key (no leading slash), null on
 * a mount, which the engine's waves cannot reach.
 */
export interface ObjectEngine {
    key(path: string): Promise<string | null>;
    writeStream(stream: ReadableStream<Uint8Array>): Promise<WriteBatchStreamResult>;
}
/** Objects written by one command: each `write`'s object is there once `flush` has settled. */
export interface ObjectWriter {
    write(type: 'blob' | 'tree' | 'commit', data: Uint8Array): Promise<string>;
    flush(): Promise<void>;
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
    private readonly engine;
    /** This command holds its repository's index lock. */
    private locked;
    readonly store: ObjectStore;
    readonly fs: WorktreeFs;
    private readonly cache;
    private worktreeConfig;
    /** `root` the worktree's top and `gitdir` its git directory, both absolute; `env` the command's. */
    constructor(vfs: ProjectFs, git: RepoGit, gitFs: GitFs, root: string, gitdir: string, env: Record<string, string>, counters?: WalkCounters, engine?: ObjectEngine | null);
    /**
     * The one flow every object is written by: hashed, and, when the
     * repository lacks it (and `sink` holds it back for no wave), its loose
     * bytes put into `sink`.
     */
    private writeObject;
    /** Each object written as it comes, through the command's view (which follows links into mounts). */
    private singleSink;
    /**
     * A writer for the many objects one command writes (add's blobs): in the
     * shared wave writer's waves, straight into the engine, with no write,
     * existence check or directory walk an object (as cf-git's took: 17
     * lookups and a write a file, half of add -A's time at Linux's size).
     * `flush` publishes what is buffered: call it before writing what names
     * the objects (the index). An object put but not yet published is not put
     * again. The waves go to the objects directory where it really is (a
     * linked .git or objects resolved), and publish nothing above it; one
     * holding a link of its own, or on a mount the waves cannot reach, has
     * its objects written one at a time.
     */
    objectWriter(): Promise<ObjectWriter>;
    private waveSink;
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