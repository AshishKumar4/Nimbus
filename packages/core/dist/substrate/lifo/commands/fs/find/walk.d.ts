/**
 * find's walk, in fts order: each start point, then depth first in the order
 * readdir returns names, a directory before its contents (or after them,
 * under -depth). The visitor sees files strictly in that order.
 *
 * What the visitor will ask for next is read ahead of it: when a directory's
 * listing arrives, its subdirectories' listings (and, when the expression
 * reads stats, its entries' stats) are queued in the order the walk will
 * reach them, and a bounded number run at once. Nothing read ahead is
 * observable: an error is reported when the visitor reaches it, and work for
 * a subtree the visitor never enters is dropped. A mount whose every readdir
 * is a network round trip then costs about one round trip per level of
 * concurrency, not per directory.
 *
 * Read-ahead is for walks that only look. When the expression runs commands
 * or deletes, a directory must be read when the walk reaches it, after the
 * visits that may have changed it, so the caller turns it off.
 */
import type { ProcessStat, ProcessView } from '../../../../../runtime/process-files.js';
import type { VfsDirent, VfsFileType } from '../../../../../vfs/vfs.js';
import { type VfsError } from '../../../../../vfs/vfs-error.js';
import type { SymlinkMode } from './expression.js';
/** A settled filesystem call: never a rejected promise, so work read ahead and then dropped cannot fail the walk. */
export type Outcome<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly error: VfsError;
};
/** A position in walk order: the start point's index, then each child's index. A prefix (an ancestor) comes first. */
type Key = readonly number[];
/** One unit of filesystem work: started when there is room ahead of the walk, or at once when the walk needs it. */
declare class Task<T> {
    readonly key: Key;
    readonly listing: boolean;
    private readonly run;
    private readonly scheduler;
    private promise;
    /** A listing started ahead of the walk, holding a place in the read-ahead window until the walk takes it or passes it. */
    held: boolean;
    constructor(key: Key, listing: boolean, run: () => Promise<T>, scheduler: Scheduler);
    get started(): boolean;
    /** The outcome, starting the work now if nothing has yet. */
    result(): Promise<Outcome<T>>;
}
/** Filesystem calls in flight ahead of the walk, when the walk reads ahead. */
export declare const READ_AHEAD_CALLS = 16;
/**
 * Starts queued tasks in walk order, at most `calls` filesystem calls at
 * once and at most READ_AHEAD_LISTINGS listings waiting for the walk. A task
 * the walk has passed is dropped from the queue; only the walk itself can
 * still start it (a -depth visit going back to its directory).
 */
declare class Scheduler {
    private readonly calls;
    private readonly queue;
    private readonly holding;
    private inFlight;
    private held;
    private position;
    private stopped;
    /** Resolves once nothing is in flight, after stop(). */
    private idle;
    constructor(calls: number);
    get enabled(): boolean;
    task<T>(key: Key, listing: boolean, run: () => Promise<T>): Task<T>;
    /** Queue `task` to run ahead of the walk. */
    ahead(task: Task<unknown>): void;
    started(): void;
    settled(): void;
    /** The walk has taken a listing, or passed it: its place in the window is free. */
    release(task: Task<unknown>): void;
    /** The walk has reached `key`: everything before it is behind the walk. */
    advance(key: Key): void;
    stop(): void;
    /** Once the calls already started have answered: find's reads do not outlive it. */
    drained(): Promise<void>;
    private pump;
}
export interface WalkOptions {
    readonly vfs: ProcessView;
    readonly cwd: string;
    readonly symlinks: SymlinkMode;
    readonly maxDepth: number;
    readonly minDepth: number;
    readonly depthFirst: boolean;
    readonly sameDevice: boolean;
    readonly ignoreVanished: boolean;
    /** Filesystem calls to run ahead of the visitor; 0 reads each thing when the visitor needs it. */
    readonly readAhead: number;
    /** Whether the expression reads stats, so entries' stats are worth reading ahead. */
    readonly prefetchStats: boolean;
    /**
     * Whether only what the walk already knows (-maxdepth, -xdev, a loop) can
     * keep it out of a subtree, so whole subtrees are read ahead. When the
     * expression can -prune, only the level below where the walk is.
     */
    readonly readAheadSubtrees: boolean;
    readonly signal: AbortSignal;
    /** A diagnostic, after `find: `. Every diagnostic also makes the exit status 1. */
    report(message: string): Promise<void>;
}
export type VisitResult = 'continue' | 'prune' | 'quit';
export interface Visitor {
    /**
     * Every fts event's depth, visited or not, in order; `newStart` marks a
     * start point's first. -execdir … + runs its batch where either changes.
     */
    event(depth: number, newStart: boolean): Promise<void>;
    visit(entry: FindEntry): Promise<VisitResult>;
}
/** A file the walk reached, with its stats and listing read once, on first need or ahead of it. */
export declare class FindEntry {
    private readonly walker;
    readonly key: Key;
    /** The path as find prints it. */
    readonly path: string;
    /** The path the filesystem resolves. */
    readonly absolute: string;
    /** What -name matches: the last component. */
    readonly name: string;
    readonly depth: number;
    readonly start: string;
    /** The type readdir gave (links not followed); null for a start point, whose type comes from its stat. */
    readonly direntType: VfsFileType | null;
    readonly parent: FindEntry | null;
    private lstatTask;
    private followTask;
    private listingTask;
    private childEntries;
    private statReported;
    constructor(walker: Walker, key: Key, 
    /** The path as find prints it. */
    path: string, 
    /** The path the filesystem resolves. */
    absolute: string, 
    /** What -name matches: the last component. */
    name: string, depth: number, start: string, 
    /** The type readdir gave (links not followed); null for a start point, whose type comes from its stat. */
    direntType: VfsFileType | null, parent: FindEntry | null);
    private get lstatWork();
    private get followWork();
    /** lstat(2): null when the file is gone. */
    lstat(): Promise<Outcome<ProcessStat | null>>;
    /** stat(2), links followed: null when nothing is at the end of them. */
    followed(): Promise<Outcome<ProcessStat | null>>;
    /** Whether this file is examined through its links (findutils' following_links). */
    get following(): boolean;
    /** A start point written with a trailing slash names the directory a link leads to, as path resolution does. */
    private get forcesFollow();
    /** Queue the stat xstat will need, to be read ahead of the walk. */
    prefetchStat(): void;
    /**
     * The stat find examines (findutils' xstat): the link itself under -P,
     * its target under -L (or -H at depth 0), the link again when it dangles.
     */
    xstat(): Promise<Outcome<ProcessStat>>;
    private present;
    /**
     * The stat a predicate needs, or null after reporting why there is none
     * (once per file, as findutils' get_statinfo does).
     */
    statForTest(): Promise<ProcessStat | null>;
    reportStatError(error: VfsError): Promise<void>;
    private get listingWork();
    /** Queue the listing, to be read ahead of the walk. */
    prefetchListing(): void;
    /**
     * The directory's names, for the walk and for -empty. Without read-ahead
     * every call reads the directory again, as GNU's -empty and fts each do.
     */
    listing(): Promise<Outcome<VfsDirent[]>>;
    /** The entries of this directory's listing, made once for the walk and its read-ahead alike. */
    children(listing: readonly VfsDirent[]): FindEntry[];
    /** The listing, taken by the walk to descend: it no longer holds a place in the read-ahead window. */
    takeListing(): Promise<Outcome<VfsDirent[]>>;
    /**
     * Whether the walk stats this file itself, as fts does: a start point, a
     * directory (to know it can be entered, and where it is), and a link it
     * follows. Every other file's type is what readdir said.
     */
    get statedByWalk(): boolean;
    /** The type the walk sees: a stat's, for what the walk stats; readdir's otherwise. A failed stat leaves it unknown. */
    walkType(): Promise<Outcome<VfsFileType>>;
    /** The directory -execdir runs a command for this file in, and the name it gives the command (findutils' record_exec_dir). */
    get execDirectory(): {
        directory: string;
        argument: string;
    };
}
export declare class Walker {
    readonly options: WalkOptions;
    private readonly visitor;
    readonly scheduler: Scheduler;
    private readonly readAheadDone;
    private failed;
    private quit;
    private newStart;
    constructor(options: WalkOptions, visitor: Visitor);
    private event;
    /** Once every call the walk started, read ahead or not, has answered. */
    settled(): Promise<void>;
    /** 0, or 1 once anything has gone wrong. */
    get status(): number;
    report(message: string): Promise<void>;
    /** A failure the walk caused without a diagnostic of its own (a command that failed under -exec … +). */
    fail(): void;
    statTask(entry: FindEntry, follow: boolean): Task<ProcessStat | null>;
    listingTask(entry: FindEntry): Task<VfsDirent[]>;
    /** Whether the walk descends into `entry`, by everything but -prune (which only the visit decides). */
    private descends;
    private rootDevice;
    /** The ancestor `stat` is the same directory as, when following links has led back to it. */
    private cycleWith;
    /** Walk every start point, until the last or until -quit or an abort ends the walk. */
    run(startPoints: readonly string[]): Promise<void>;
    private walk;
    /**
     * Queue what the walk will want from these children: the stats it takes
     * (and the expression's, when it reads them), and the listings of the
     * directories it will descend into. Under -xdev only the stat says whether
     * a directory is on this device, so a probe queued in its place reads the
     * stat first and never lists a directory on another one.
     */
    private readAhead;
    private stopWalk;
}
export {};
//# sourceMappingURL=walk.d.ts.map