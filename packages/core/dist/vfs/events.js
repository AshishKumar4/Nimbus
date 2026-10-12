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
/**
 * Lightweight EventEmitter for VFS mutations.
 * - Global listeners receive batched events per microtask.
 * - Path listeners receive individual events for matching paths.
 */
export class VfsEventEmitter {
    /** Each global listener, and how much of the batch now pending was published before it registered (none of its own). */
    _globalListeners = [];
    _pathListeners = new Map();
    _pending = [];
    _flushScheduled = false;
    // Stats
    _totalEmitted = 0;
    _totalBatches = 0;
    /** Register a global listener that receives batched events: those published from now on. */
    on(listener) {
        const entry = { listener, before: this._pending.length };
        this._globalListeners.push(entry);
        return () => {
            const idx = this._globalListeners.indexOf(entry);
            if (idx >= 0)
                this._globalListeners.splice(idx, 1);
        };
    }
    /** Register a listener for a specific path (or path prefix with recursive). */
    onPath(path, listener) {
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
                if (idx >= 0)
                    arr.splice(idx, 1);
                if (arr.length === 0)
                    this._pathListeners.delete(path);
            }
        };
    }
    /** Emit a VFS event. Batched and flushed on the next microtask. */
    emit(type, path, oldPath) {
        const event = { type, path, timestamp: Date.now(), oldPath };
        this._pending.push(event);
        // Immediately deliver to path listeners (no batching for these)
        this._deliverToPathListeners(event);
        // Schedule batch flush for global listeners
        if (!this._flushScheduled) {
            this._flushScheduled = true;
            queueMicrotask(() => this._flush());
        }
    }
    _deliverToPathListeners(event) {
        // Exact match
        const exact = this._pathListeners.get(event.path);
        if (exact) {
            for (const listener of exact) {
                try {
                    listener(event);
                }
                catch (e) {
                    console.error('[vfs-events] path listener error:', e);
                }
            }
        }
        // Parent directory listeners (recursive watching), the root's ('') last: it holds every path.
        if (event.path === '')
            return;
        let dir = event.path;
        while (dir !== '') {
            const slash = dir.lastIndexOf('/');
            dir = slash === -1 ? '' : dir.substring(0, slash);
            const parent = this._pathListeners.get(dir);
            if (parent) {
                for (const listener of parent) {
                    try {
                        listener(event);
                    }
                    catch (e) {
                        console.error('[vfs-events] path listener error:', e);
                    }
                }
            }
        }
    }
    _flush() {
        this._flushScheduled = false;
        const batch = this._pending;
        this._pending = [];
        if (batch.length === 0)
            return;
        this._totalEmitted += batch.length;
        this._totalBatches++;
        for (const entry of this._globalListeners) {
            const own = entry.before === 0 ? batch : batch.slice(entry.before);
            entry.before = 0;
            if (own.length === 0)
                continue;
            try {
                entry.listener(own);
            }
            catch (e) {
                console.error('[vfs-events] global listener error:', e);
            }
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
