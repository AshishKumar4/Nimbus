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
import { isVfsError, syscallError, VFS_STRERROR } from '../../../../../vfs/vfs-error.js';
import { resolve } from '../../../utils/path.js';
import { quote } from './errors.js';
import { baseName } from './format.js';
async function settle(run) {
    try {
        return { ok: true, value: await run() };
    }
    catch (error) {
        if (isVfsError(error))
            return { ok: false, error };
        throw error;
    }
}
function compareKeys(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++)
        if (a[i] !== b[i])
            return a[i] - b[i];
    return a.length - b.length;
}
/** One unit of filesystem work: started when there is room ahead of the walk, or at once when the walk needs it. */
class Task {
    key;
    run;
    scheduler;
    weigh;
    promise = null;
    held = 0;
    constructor(key, run, scheduler, 
    /** For a listing: how many entries its result holds in the window. */
    weigh) {
        this.key = key;
        this.run = run;
        this.scheduler = scheduler;
        this.weigh = weigh;
    }
    get started() {
        return this.promise !== null;
    }
    get windowed() {
        return this.weigh !== null;
    }
    start() {
        void this.result();
    }
    /** The outcome, starting the work now if nothing has yet. */
    result() {
        if (this.promise === null) {
            this.scheduler.started();
            const weigh = this.weigh;
            this.promise = settle(this.run)
                .then((outcome) => {
                if (outcome.ok && weigh !== null)
                    this.scheduler.hold(this, weigh(outcome.value));
                return outcome;
            })
                .finally(() => this.scheduler.settled());
        }
        return this.promise;
    }
}
/** A min-heap of tasks by walk order. */
class TaskQueue {
    heap = [];
    peek() {
        return this.heap[0];
    }
    push(task) {
        const heap = this.heap;
        heap.push(task);
        for (let i = heap.length - 1; i > 0;) {
            const parent = (i - 1) >> 1;
            if (compareKeys(heap[parent].key, heap[i].key) <= 0)
                break;
            [heap[parent], heap[i]] = [heap[i], heap[parent]];
            i = parent;
        }
    }
    pop() {
        const heap = this.heap;
        const top = heap[0];
        const last = heap.pop();
        if (heap.length > 0 && last !== undefined) {
            heap[0] = last;
            for (let i = 0;;) {
                const left = 2 * i + 1;
                const right = left + 1;
                let smallest = i;
                if (left < heap.length && compareKeys(heap[left].key, heap[smallest].key) < 0)
                    smallest = left;
                if (right < heap.length && compareKeys(heap[right].key, heap[smallest].key) < 0)
                    smallest = right;
                if (smallest === i)
                    break;
                [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
                i = smallest;
            }
        }
        return top;
    }
}
/** Filesystem calls in flight ahead of the walk, when the walk reads ahead. */
export const READ_AHEAD_CALLS = 16;
/**
 * Entries of listings read ahead and held for the walk before it reaches
 * them: what the window costs in memory (each, with its stats, well under
 * a kilobyte), whatever the size of a directory.
 */
const READ_AHEAD_ENTRIES = 4096;
/**
 * Starts queued tasks in walk order, at most `calls` filesystem calls at
 * once, and no more listings once READ_AHEAD_ENTRIES entries wait for the
 * walk. A task the walk has passed is dropped from the queue; only the walk
 * itself can still start it (a -depth visit going back to its directory).
 */
class Scheduler {
    calls;
    queue = new TaskQueue();
    holding = new TaskQueue();
    inFlight = 0;
    held = 0;
    position = [];
    stopped = false;
    /** Resolves once nothing is in flight, after stop(). */
    idle = null;
    constructor(calls) {
        this.calls = calls;
    }
    get enabled() {
        return this.calls > 0;
    }
    /** Work for the walk at `key`; a listing says how many entries its result holds in the window. */
    task(key, run, weigh = null) {
        return new Task(key, run, this, weigh);
    }
    /** Queue `task` to run ahead of the walk. */
    ahead(task) {
        if (!this.enabled || task.started)
            return;
        this.queue.push(task);
        this.pump();
    }
    started() {
        this.inFlight++;
    }
    settled() {
        this.inFlight--;
        if (this.inFlight === 0)
            this.idle?.();
        this.pump();
    }
    /** A listing read ahead has arrived: its entries wait in the window, unless the walk has already taken or passed it. */
    hold(task, entries) {
        if (task.held === 0)
            return;
        task.held += entries;
        this.held += entries;
    }
    /** The walk has taken a listing, or passed it: its share of the window is free. */
    release(task) {
        if (task.held === 0)
            return;
        this.held -= task.held;
        task.held = 0;
        this.pump();
    }
    /** The walk has reached `key`: everything before it is behind the walk, and let go. */
    advance(key) {
        this.position = key;
        for (let task = this.holding.peek(); task !== undefined && compareKeys(task.key, key) < 0; task = this.holding.peek()) {
            this.holding.pop();
            this.release(task);
        }
        // Queued work the walk has passed would only be dropped when it is popped; while the window is full that may be never.
        for (let task = this.queue.peek(); task !== undefined && compareKeys(task.key, key) < 0; task = this.queue.peek())
            this.queue.pop();
    }
    stop() {
        this.stopped = true;
    }
    /** Once the calls already started have answered: find's reads do not outlive it. */
    async drained() {
        if (this.inFlight === 0)
            return;
        await new Promise((resolve) => { this.idle = resolve; });
    }
    pump() {
        while (!this.stopped && this.inFlight < this.calls && this.held < READ_AHEAD_ENTRIES) {
            const task = this.queue.pop();
            if (task === undefined)
                break;
            if (task.started || compareKeys(task.key, this.position) < 0)
                continue;
            if (task.windowed) {
                // A listing in flight holds one place, until it says how many entries it brings.
                task.held = 1;
                this.held += 1;
                this.holding.push(task);
            }
            task.start();
        }
    }
}
/** A file the walk reached, with its stats and listing read once, on first need or ahead of it. */
export class FindEntry {
    walker;
    key;
    path;
    absolute;
    name;
    depth;
    start;
    direntType;
    parent;
    lstatTask = null;
    followTask = null;
    listingTask = null;
    childEntries = null;
    statReported = false;
    constructor(walker, key, 
    /** The path as find prints it. */
    path, 
    /** The path the filesystem resolves. */
    absolute, 
    /** What -name matches: the last component. */
    name, depth, start, 
    /** The type readdir gave (links not followed); null for a start point, whose type comes from its stat. */
    direntType, parent) {
        this.walker = walker;
        this.key = key;
        this.path = path;
        this.absolute = absolute;
        this.name = name;
        this.depth = depth;
        this.start = start;
        this.direntType = direntType;
        this.parent = parent;
    }
    get lstatWork() {
        this.lstatTask ??= this.walker.statTask(this, false);
        return this.lstatTask;
    }
    get followWork() {
        this.followTask ??= this.walker.statTask(this, true);
        return this.followTask;
    }
    /** lstat(2): null when the file is gone. */
    lstat() {
        return this.lstatWork.result();
    }
    /** stat(2), links followed: null when nothing is at the end of them. */
    followed() {
        return this.followWork.result();
    }
    /** Whether this file is examined through its links (findutils' following_links). */
    get following() {
        return this.walker.options.symlinks === 'L' || (this.walker.options.symlinks === 'H' && this.depth === 0);
    }
    /** A start point written with a trailing slash names the directory a link leads to, as path resolution does. */
    get forcesFollow() {
        return this.depth === 0 && this.start.length > 1 && this.start.endsWith('/');
    }
    /** Queue the stat xstat will need, to be read ahead of the walk. */
    prefetchStat() {
        this.walker.scheduler.ahead(this.following || this.forcesFollow ? this.followWork : this.lstatWork);
    }
    /**
     * The stat find examines (findutils' xstat): the link itself under -P,
     * its target under -L (or -H at depth 0), the link again when it dangles.
     */
    async xstat() {
        if (this.following || this.forcesFollow) {
            const followed = await this.followed();
            if (followed.ok && followed.value !== null)
                return { ok: true, value: followed.value };
            if (followed.ok || followed.error.code === 'ENOTDIR') {
                if (this.forcesFollow)
                    return { ok: false, error: followed.ok ? syscallError('ENOENT', 'stat', this.path) : followed.error };
                return this.present(await this.lstat());
            }
            return followed;
        }
        return this.present(await this.lstat());
    }
    present(outcome) {
        if (!outcome.ok)
            return outcome;
        return outcome.value === null ? { ok: false, error: syscallError('ENOENT', 'lstat', this.path) } : { ok: true, value: outcome.value };
    }
    /**
     * The stat a predicate needs, or null after reporting why there is none
     * (once per file, as findutils' get_statinfo does).
     */
    async statForTest() {
        const outcome = await this.xstat();
        if (outcome.ok)
            return outcome.value;
        await this.reportStatError(outcome.error);
        return null;
    }
    async reportStatError(error) {
        if (this.statReported)
            return;
        this.statReported = true;
        if (this.walker.options.ignoreVanished && error.code === 'ENOENT')
            return;
        await this.walker.report(`${quote(this.path)}: ${VFS_STRERROR[error.code]}`);
    }
    get listingWork() {
        this.listingTask ??= this.walker.listingTask(this);
        return this.listingTask;
    }
    /** Queue the listing, to be read ahead of the walk. */
    prefetchListing() {
        this.walker.scheduler.ahead(this.listingWork);
    }
    /**
     * The directory's names, for the walk and for -empty. Without read-ahead
     * every call reads the directory again, as GNU's -empty and fts each do.
     */
    listing() {
        if (!this.walker.scheduler.enabled)
            return settle(() => this.walker.options.vfs.readdir(this.absolute));
        return this.listingWork.result();
    }
    /**
     * Let go of what was read for this file and below it, once the walk is
     * done with it: it stays only as an entry of its parent's listing, as an
     * FTSENT does until fts leaves the parent.
     */
    release() {
        this.childEntries = null;
        this.listingTask = null;
        this.lstatTask = null;
        this.followTask = null;
    }
    /** The entries of this directory's listing, made once for the walk and its read-ahead alike. */
    children(listing) {
        if (this.childEntries !== null)
            return this.childEntries;
        const prefix = this.path.endsWith('/') ? this.path.slice(0, -1) : this.path;
        this.childEntries = listing.map((dirent, index) => new FindEntry(this.walker, [...this.key, index], `${prefix}/${dirent.name}`, this.absolute === '/' ? `/${dirent.name}` : `${this.absolute}/${dirent.name}`, dirent.name, this.depth + 1, this.start, dirent.type, this));
        return this.childEntries;
    }
    /** The listing, taken by the walk to descend: it no longer holds a place in the read-ahead window. */
    async takeListing() {
        const outcome = await this.listing();
        if (this.listingTask !== null)
            this.walker.scheduler.release(this.listingTask);
        return outcome;
    }
    /**
     * Whether the walk stats this file itself, as fts does: a start point, a
     * directory (to know it can be entered, and where it is), a link it
     * follows, and an entry readdir cannot type (DT_UNKNOWN). Every other
     * file's type is what readdir said.
     */
    get statedByWalk() {
        return this.direntType === null || this.direntType === 'directory' || this.direntType === 'unknown'
            || (this.direntType === 'symlink' && this.following);
    }
    /** The type the walk sees: a stat's, for what the walk stats; readdir's otherwise. A failed stat leaves it unknown. */
    async walkType() {
        if (this.direntType !== null && !this.statedByWalk)
            return { ok: true, value: this.direntType };
        const outcome = await this.xstat();
        return outcome.ok ? { ok: true, value: outcome.value.type } : outcome;
    }
    /** The directory -execdir runs a command for this file in, and the name it gives the command (findutils' record_exec_dir). */
    get execDirectory() {
        if (this.parent !== null)
            return { directory: this.parent.absolute, argument: `./${this.name}` };
        const base = baseName(this.start);
        const argument = base.startsWith('/') ? base : `./${base}`;
        // gnulib's mdir_name: what precedes the last component, without its trailing slashes.
        const trimmed = this.start.replace(/\/+$/, '');
        const slash = trimmed.lastIndexOf('/');
        const directory = trimmed === '' ? '/' : slash === -1 ? '.' : trimmed.slice(0, slash).replace(/\/+$/, '') || '/';
        return { directory: resolve(this.walker.options.cwd, directory), argument };
    }
}
export class Walker {
    options;
    visitor;
    scheduler;
    readAheadDone = new WeakSet();
    failed = false;
    quit = false;
    newStart = false;
    constructor(options, visitor) {
        this.options = options;
        this.visitor = visitor;
        this.scheduler = new Scheduler(options.readAhead);
    }
    async event(depth) {
        const newStart = this.newStart;
        this.newStart = false;
        await this.visitor.event(depth, newStart);
    }
    /** Once every call the walk started, read ahead or not, has answered. */
    async settled() {
        this.scheduler.stop();
        await this.scheduler.drained();
    }
    /** 0, or 1 once anything has gone wrong. */
    get status() {
        return this.failed ? 1 : 0;
    }
    async report(message) {
        this.failed = true;
        await this.options.report(message);
    }
    /** A failure the walk caused without a diagnostic of its own (a command that failed under -exec … +). */
    fail() {
        this.failed = true;
    }
    statTask(entry, follow) {
        return this.scheduler.task(entry.key, () => this.options.vfs.stat(entry.absolute, { follow }));
    }
    listingTask(entry) {
        return this.scheduler.task(entry.key, async () => {
            const listing = await this.options.vfs.readdir(entry.absolute);
            // A listing read for -empty is not one the walk enters; only the walk's own are read below.
            if (this.options.readAheadSubtrees && (await this.descends(entry)))
                this.readAhead(entry, entry.children(listing));
            return listing;
        }, (listing) => listing.length);
    }
    /** Whether the walk descends into `entry`, by everything but -prune (which only the visit decides). */
    async descends(entry) {
        if (entry.depth >= this.options.maxDepth)
            return false;
        const type = await entry.walkType();
        if (!type.ok || type.value !== 'directory')
            return false;
        if (this.options.sameDevice || this.options.symlinks !== 'P') {
            const stat = await entry.xstat();
            if (!stat.ok)
                return false;
            if (this.options.sameDevice && stat.value.dev !== (await this.rootDevice(entry)))
                return false;
            if (this.options.symlinks !== 'P' && (await this.cycleWith(entry, stat.value)) !== null)
                return false;
        }
        return true;
    }
    async rootDevice(entry) {
        let root = entry;
        while (root.parent !== null)
            root = root.parent;
        const stat = await root.xstat();
        return stat.ok ? stat.value.dev : null;
    }
    /** The ancestor `stat` is the same directory as, when following links has led back to it. */
    async cycleWith(entry, stat) {
        for (let ancestor = entry.parent; ancestor !== null; ancestor = ancestor.parent) {
            const outcome = await ancestor.xstat();
            if (outcome.ok && outcome.value.dev === stat.dev && outcome.value.ino === stat.ino)
                return ancestor;
        }
        return null;
    }
    /** Walk every start point, until the last or until -quit or an abort ends the walk. */
    async run(startPoints) {
        const starts = startPoints.length > 0 ? startPoints : ['.'];
        for (let i = 0; i < starts.length && !this.quit; i++) {
            const start = starts[i];
            const trimmed = start.replace(/\/+$/, '');
            const entry = new FindEntry(this, [i], start, resolve(this.options.cwd, start), trimmed === '' ? (start === '' ? '' : '/') : trimmed.slice(trimmed.lastIndexOf('/') + 1), 0, start, null, null);
            this.newStart = true;
            // fts reports a start point that is not there before anything else; an empty name is never there.
            const stat = start === '' ? { ok: false, error: syscallError('ENOENT', 'stat', start) } : await entry.xstat();
            const failure = !stat.ok ? stat.error.code : start.length > 1 && start.endsWith('/') && stat.value.type !== 'directory' ? 'ENOTDIR' : null;
            if (failure !== null) {
                await this.event(0);
                await this.report(`${quote(start)}: ${VFS_STRERROR[failure]}`);
                continue;
            }
            await this.walk(entry);
        }
        this.scheduler.stop();
    }
    async walk(entry) {
        try {
            await this.walkEntry(entry);
        }
        finally {
            entry.release();
        }
    }
    async walkEntry(entry) {
        if (this.options.signal.aborted) {
            this.stopWalk();
            return;
        }
        this.scheduler.advance(entry.key);
        const { options } = this;
        const type = await entry.walkType();
        if (!type.ok) {
            // A file fts cannot stat is reported, and visited with its type unknown; a link loop is not visited.
            await entry.reportStatError(type.error);
            if (type.error.code === 'ELOOP')
                return;
        }
        const isDirectory = type.ok && type.value === 'directory';
        if (isDirectory && options.symlinks !== 'P') {
            const stat = await entry.xstat();
            const ancestor = stat.ok ? await this.cycleWith(entry, stat.value) : null;
            if (ancestor !== null) {
                await this.event(entry.depth);
                await this.report(`File system loop detected; ${quote(entry.path)} is part of the same file system loop as ${quote(ancestor.path)}.`);
                return;
            }
        }
        await this.event(entry.depth);
        const visited = entry.depth >= options.minDepth;
        let prune = false;
        if (!options.depthFirst && visited) {
            const result = await this.visitor.visit(entry);
            if (result === 'quit') {
                this.stopWalk();
                return;
            }
            prune = result === 'prune';
        }
        if (isDirectory && !prune && entry.depth < options.maxDepth && (await this.descends(entry))) {
            const listing = await entry.takeListing();
            if (!listing.ok) {
                await this.report(`${quote(entry.path)}: ${VFS_STRERROR[listing.error.code]}`);
            }
            else {
                const children = entry.children(listing.value);
                if (this.scheduler.enabled)
                    this.readAhead(entry, children);
                for (const child of children) {
                    await this.walk(child);
                    if (this.quit)
                        return;
                }
            }
            await this.event(entry.depth);
        }
        if (options.depthFirst && visited) {
            if ((await this.visitor.visit(entry)) === 'quit')
                this.stopWalk();
        }
    }
    /**
     * Queue what the walk will want from these children: the stats it takes
     * (and the expression's, when it reads them), and the listings of the
     * directories it will descend into. Under -xdev only the stat says whether
     * a directory is on this device, and when links are followed only the
     * stats of its ancestors say whether it is one of them; then, as for an
     * entry readdir cannot type, a probe queued in its place reads those first,
     * and never lists a directory on another device, one the walk will refuse
     * as a loop, or what is not a directory at all.
     */
    readAhead(parent, children) {
        if (this.readAheadDone.has(parent))
            return;
        this.readAheadDone.add(parent);
        const { options, scheduler } = this;
        const decidedByStats = options.sameDevice || options.symlinks !== 'P';
        for (const child of children) {
            if (options.prefetchStats || child.statedByWalk)
                child.prefetchStat();
            if (child.depth >= options.maxDepth)
                continue;
            const mayBeDirectory = child.direntType === 'directory' || child.direntType === 'unknown'
                || (child.direntType === 'symlink' && child.following);
            if (!mayBeDirectory)
                continue;
            if (!decidedByStats && child.direntType === 'directory') {
                child.prefetchListing();
                continue;
            }
            scheduler.ahead(scheduler.task(child.key, async () => {
                if (await this.descends(child))
                    child.prefetchListing();
            }));
        }
    }
    stopWalk() {
        this.quit = true;
        this.scheduler.stop();
    }
}
