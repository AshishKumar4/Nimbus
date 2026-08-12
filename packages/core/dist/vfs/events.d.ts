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
export type VfsEventListener = (events: VfsEvent[]) => void;
export type VfsPathListener = (event: VfsEvent) => void;
/**
 * Lightweight EventEmitter for VFS mutations.
 * - Global listeners receive batched events per microtask.
 * - Path listeners receive individual events for matching paths.
 */
export declare class VfsEventEmitter {
    private _globalListeners;
    private _pathListeners;
    private _pending;
    private _flushScheduled;
    private _totalEmitted;
    private _totalBatches;
    /** Register a global listener that receives batched events. */
    on(listener: VfsEventListener): () => void;
    /** Register a listener for a specific path (or path prefix with recursive). */
    onPath(path: string, listener: VfsPathListener): () => void;
    /** Emit a VFS event. Batched and flushed on the next microtask. */
    emit(type: VfsEventType, path: string, oldPath?: string): void;
    private _deliverToPathListeners;
    private _flush;
    /** Remove all listeners. */
    removeAll(): void;
    get stats(): {
        totalEmitted: number;
        totalBatches: number;
        globalListeners: number;
        pathListeners: number;
        pending: number;
    };
}
//# sourceMappingURL=events.d.ts.map