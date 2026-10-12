/**
 * VFS Event System — EventEmitter for filesystem mutations.
 *
 * Fires on every write/unlink/rename/mkdir. Foundation for fs.watch(),
 * chokidar shim, and HMR in Phase 4.
 *
 * Events are debounce-batched: rapid mutations (e.g. npm install writing
 * thousands of files) are coalesced into a single batch emission per
 * microtask, reducing listener overhead.
 */
export type VfsEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' | 'rename';
export interface VfsEvent {
    type: VfsEventType;
    path: string;
    /** For rename events, the original path */
    oldPath?: string;
    timestamp: number;
}
/** Whether `path` is `tree` or under it (`tree` '' or '/': the root, which holds everything). */
export declare function inWatchedTree(tree: string, path: string): boolean;
/**
 * `event` as a watch of `tree` is told it, one rule for every watch: each
 * end of it the watch holds (in `tree`) and may see (`shown`: its name for
 * a path, null when it may not see it) is told; any rename seen at one end
 * only is that end's add, or unlink. The watched path itself, or a
 * directory above it, renamed is the watched path's going (unlink, where it
 * was seen); a watch that follows its target (`follow`) is told its move
 * instead (a rename, where it may see both places), and moves with it
 * (CompositeVFS.watchChanges). A directory above it renamed took it along
 * only if it is there now (`exists`, asked of nothing else); what a
 * directory renamed to above the watched path brings is not known, and not
 * told. Null: nothing to tell.
 */
export declare function projectChange(event: VfsEvent, tree: string, shown: (path: string) => string | null, follow?: boolean, exists?: (path: string) => boolean): VfsEvent | null;
export type VfsEventListener = (events: VfsEvent[]) => void;
export type VfsPathListener = (event: VfsEvent) => void;
/**
 * Lightweight EventEmitter for VFS mutations.
 * - Global listeners receive batched events per microtask: the ones
 *   published after each registered, whatever registers or lets go while a
 *   batch is delivered.
 * - Path listeners receive individual events at or under their path, by
 *   either end of a rename, and a rename of a directory above their path.
 */
export declare class VfsEventEmitter {
    private _globalListeners;
    private _pathListeners;
    private _pending;
    /** Each pending event's publication number (they rise). */
    private _pendingAt;
    /** Publications so far. */
    private _published;
    private _flushScheduled;
    /** Publications the path listeners are yet to hear, in order (one a listener makes waits for the one it hears). */
    private _pathQueue;
    private _pathDelivering;
    private _totalEmitted;
    private _totalBatches;
    /** Register a global listener that receives batched events: those published from now on. */
    on(listener: VfsEventListener): () => void;
    /** Register a listener for a path and everything under it ('' is the root). */
    onPath(path: string, listener: VfsPathListener): () => void;
    /** Emit a VFS event: to path listeners now, to global listeners batched on the next microtask; to no one, when no one listens. */
    emit(type: VfsEventType, path: string, oldPath?: string): void;
    /**
     * `event` to each path listener registered when it was published, once:
     * at its path or above it, at either end of a rename, and under a renamed
     * directory (what it watches moved).
     */
    private _deliverToPathListeners;
    private _flush;
    get stats(): {
        totalEmitted: number;
        totalBatches: number;
        globalListeners: number;
        pathListeners: number;
        pending: number;
    };
}
//# sourceMappingURL=events.d.ts.map