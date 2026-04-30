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
export class VfsEventEmitter {
  private _globalListeners: VfsEventListener[] = [];
  private _pathListeners = new Map<string, VfsPathListener[]>();
  private _pending: VfsEvent[] = [];
  private _flushScheduled = false;

  // Stats
  private _totalEmitted = 0;
  private _totalBatches = 0;

  /** Register a global listener that receives batched events. */
  on(listener: VfsEventListener): () => void {
    this._globalListeners.push(listener);
    return () => {
      const idx = this._globalListeners.indexOf(listener);
      if (idx >= 0) this._globalListeners.splice(idx, 1);
    };
  }

  /** Register a listener for a specific path (or path prefix with recursive). */
  onPath(path: string, listener: VfsPathListener): () => void {
    let list = this._pathListeners.get(path);
    if (!list) {
      list = [];
      this._pathListeners.set(path, list);
    }
    list.push(listener);
    return () => {
      const arr = this._pathListeners.get(path);
      if (arr) {
        const idx = arr.indexOf(listener);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) this._pathListeners.delete(path);
      }
    };
  }

  /** Emit a VFS event. Batched and flushed on the next microtask. */
  emit(type: VfsEventType, path: string, oldPath?: string): void {
    const event: VfsEvent = { type, path, timestamp: Date.now(), oldPath };
    this._pending.push(event);

    // Immediately deliver to path listeners (no batching for these)
    this._deliverToPathListeners(event);

    // Schedule batch flush for global listeners
    if (!this._flushScheduled) {
      this._flushScheduled = true;
      queueMicrotask(() => this._flush());
    }
  }

  private _deliverToPathListeners(event: VfsEvent): void {
    // Exact match
    const exact = this._pathListeners.get(event.path);
    if (exact) {
      for (const listener of exact) {
        try { listener(event); } catch (e) { console.error('[vfs-events] path listener error:', e); }
      }
    }
    // Parent directory listeners (recursive watching)
    let dir = event.path;
    while (dir.includes('/')) {
      dir = dir.substring(0, dir.lastIndexOf('/'));
      const parent = this._pathListeners.get(dir);
      if (parent) {
        for (const listener of parent) {
          try { listener(event); } catch (e) { console.error('[vfs-events] path listener error:', e); }
        }
      }
    }
  }

  private _flush(): void {
    this._flushScheduled = false;
    const batch = this._pending;
    this._pending = [];
    if (batch.length === 0) return;

    this._totalEmitted += batch.length;
    this._totalBatches++;

    for (const listener of this._globalListeners) {
      try { listener(batch); } catch (e) { console.error('[vfs-events] global listener error:', e); }
    }
  }

  /** Remove all listeners. */
  removeAll(): void {
    this._globalListeners = [];
    this._pathListeners.clear();
    this._pending = [];
    this._flushScheduled = false;
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
