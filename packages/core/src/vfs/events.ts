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
export function inWatchedTree(tree: string, path: string): boolean {
  if (tree === '' || tree === '/' || path === tree) return true;
  return path.length > tree.length && path.charCodeAt(tree.length) === 47 && path.startsWith(tree);
}

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
export function projectChange(
  event: VfsEvent, tree: string, shown: (path: string) => string | null, follow = false, exists: (path: string) => boolean = () => true,
): VfsEvent | null {
  const seen = (path: string): string | null => (inWatchedTree(tree, path) ? shown(path) : null);
  const { type, timestamp } = event;
  const path = seen(event.path);
  // The event itself where the watch names it as it came.
  if (event.oldPath === undefined) return path === null ? null : path === event.path ? event : { type, path, timestamp };
  const from = event.oldPath;
  if (inWatchedTree(from, tree)) {
    const moved = event.path + tree.slice(from.length);
    // Where the watched path was: seen through the directories above `from` as they are, and the ones that
    // moved with it where they went (they are the same directories).
    const above = shown(from);
    const was = above === null ? null : from === tree ? above : shown(moved) === null || !exists(moved) ? null : above + tree.slice(from.length);
    if (was === null) return null;
    const now = follow ? shown(moved) : null;
    return now === null ? { type: 'unlink', path: was, timestamp } : { type: 'rename', path: now, oldPath: was, timestamp };
  }
  const oldPath = seen(from);
  if (path !== null && oldPath !== null) return path === event.path && oldPath === from ? event : { type, path, oldPath, timestamp };
  if (path !== null) return { type: 'add', path, timestamp };
  if (oldPath !== null) return { type: 'unlink', path: oldPath, timestamp };
  return null;
}

export type VfsEventListener = (events: VfsEvent[]) => void;
export type VfsPathListener = (event: VfsEvent) => void;

/** A listener's registration: what it hears, the publications after `from`, and whether it was let go (a delivery under way skips it). */
interface Registration<L> {
  readonly listener: L;
  readonly from: number;
  removed: boolean;
}

/**
 * Lightweight EventEmitter for VFS mutations.
 * - Global listeners receive batched events per microtask: the ones
 *   published after each registered, whatever registers or lets go while a
 *   batch is delivered.
 * - Path listeners receive individual events at or under their path, by
 *   either end of a rename, and a rename of a directory above their path.
 */
export class VfsEventEmitter {
  private _globalListeners: Registration<VfsEventListener>[] = [];
  private _pathListeners = new Map<string, Registration<VfsPathListener>[]>();
  private _pending: VfsEvent[] = [];
  /** Each pending event's publication number (they rise). */
  private _pendingAt: number[] = [];
  /** Publications so far. */
  private _published = 0;
  private _flushScheduled = false;
  /** Publications the path listeners are yet to hear, in order (one a listener makes waits for the one it hears). */
  private _pathQueue: { event: VfsEvent; at: number }[] = [];
  private _pathDelivering = false;

  // Stats
  private _totalEmitted = 0;
  private _totalBatches = 0;

  /** Register a global listener that receives batched events: those published from now on. */
  on(listener: VfsEventListener): () => void {
    const entry: Registration<VfsEventListener> = { listener, from: this._published, removed: false };
    this._globalListeners.push(entry);
    return () => {
      entry.removed = true;
      const idx = this._globalListeners.indexOf(entry);
      if (idx >= 0) this._globalListeners.splice(idx, 1);
    };
  }

  /** Register a listener for a path and everything under it ('' is the root). */
  onPath(path: string, listener: VfsPathListener): () => void {
    let list = this._pathListeners.get(path);
    if (!list) {
      list = [];
      this._pathListeners.set(path, list);
    }
    const entry: Registration<VfsPathListener> = { listener, from: this._published, removed: false };
    list.push(entry);
    return () => {
      entry.removed = true;
      const arr = this._pathListeners.get(path);
      if (arr) {
        const idx = arr.indexOf(entry);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) this._pathListeners.delete(path);
      }
    };
  }

  /** Emit a VFS event: to path listeners now, to global listeners batched on the next microtask; to no one, when no one listens. */
  emit(type: VfsEventType, path: string, oldPath?: string): void {
    const at = ++this._published;
    this._totalEmitted++;
    if (this._globalListeners.length === 0 && this._pathListeners.size === 0) return;
    const event: VfsEvent = { type, path, timestamp: Date.now(), oldPath };

    // Queued for the global listeners first: one a path listener publishes is after it.
    if (this._globalListeners.length > 0) {
      this._pending.push(event);
      this._pendingAt.push(at);
      if (!this._flushScheduled) {
        this._flushScheduled = true;
        queueMicrotask(() => this._flush());
      }
    }

    // Immediately deliver to path listeners (no batching for these), in publication order.
    if (this._pathListeners.size === 0) return;
    this._pathQueue.push({ event, at });
    if (this._pathDelivering) return;
    this._pathDelivering = true;
    try {
      for (let next = this._pathQueue.shift(); next !== undefined; next = this._pathQueue.shift()) this._deliverToPathListeners(next.event, next.at);
    } finally {
      this._pathDelivering = false;
    }
  }

  /**
   * `event` to each path listener registered when it was published, once:
   * at its path or above it, at either end of a rename, and under a renamed
   * directory (what it watches moved).
   */
  private _deliverToPathListeners(event: VfsEvent, at: number): void {
    const heard: Registration<VfsPathListener>[] = [];
    const hear = (key: string): void => {
      for (const entry of this._pathListeners.get(key) ?? []) if (entry.from < at && !heard.includes(entry)) heard.push(entry);
    };
    for (const end of event.oldPath === undefined ? [event.path] : [event.path, event.oldPath]) {
      // The end itself, then each directory above it, the root's ('') last: it holds every path.
      hear(end);
      for (let dir = end; dir !== '';) {
        const slash = dir.lastIndexOf('/');
        dir = slash === -1 ? '' : dir.substring(0, slash);
        hear(dir);
      }
      if (event.oldPath !== undefined && end !== '') {
        for (const key of this._pathListeners.keys()) if (key.startsWith(`${end}/`)) hear(key);
      }
    }
    for (const entry of heard) {
      if (entry.removed) continue;
      try { entry.listener(event); } catch (e) { console.error('[vfs-events] path listener error:', e); }
    }
  }

  private _flush(): void {
    this._flushScheduled = false;
    const batch = this._pending;
    const at = this._pendingAt;
    this._pending = [];
    this._pendingAt = [];
    if (batch.length === 0) return;

    this._totalBatches++;

    // The listeners registered now, each told what was published after it registered; one let go meanwhile is skipped.
    for (const entry of this._globalListeners.slice()) {
      if (entry.removed) continue;
      let first = 0;
      while (first < at.length && at[first]! <= entry.from) first++;
      if (first === batch.length) continue;
      const own = first === 0 ? batch : batch.slice(first);
      try { entry.listener(own); } catch (e) { console.error('[vfs-events] global listener error:', e); }
    }
  }

  get stats() {
    return {
      totalEmitted: this._totalEmitted,
      totalBatches: this._totalBatches,
      globalListeners: this._globalListeners.length,
      pathListeners: this._pathListeners.size,
      pending: this._pending.length,
    };
  }
}
