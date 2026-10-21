/**
 * git/worktree/walk.ts — the worktree against the index, one directory at a
 * time (git's diff-files and read_directory in one pass).
 *
 * A directory's listing is merged with the index entries below it, which are
 * one contiguous range of the sorted index: a tracked file is lstat'd and
 * matched as read-cache.c ie_match_stat matches it, a tracked directory is
 * entered, and what the listing has and the index does not is untracked,
 * checked against the exclude rules. Only entries that changed, and the
 * untracked paths, come back; a clean entry costs its lstat and nothing
 * else. Content is read only where the stat cannot decide: stat fields other
 * than the size moved, the entry is racily clean, or it was smudged.
 *
 * What is held is the listing of each directory on the current path, so
 * memory follows the tree's depth and its widest directory, not its size.
 */
import { createHash } from 'node:crypto';
import { isVfsError, strerror } from '@nimbus-sh/core/vfs/vfs-error.js';
import { objectIdPrefix, oidToHex } from '../pack/format.js';
import { EMPTY_BLOB, S_IFGITLINK, S_IFLNK, S_IFMT, S_IFREG, decodePath, objectId } from './dircache.js';
import { utf8Length } from '@nimbus-sh/platform/utf8.js';
export function newCounters() {
    return { readdirs: 0, lstats: 0, scans: 0, scanned: 0, filesRead: 0, bytesRead: 0, objectsRead: 0 };
}
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
/** The bytes git would store for the worktree file or link at `path` (convert_to_git's share of it). */
export async function worktreeBlob(tree, path, type) {
    tree.counters.filesRead++;
    if (type === 'symlink')
        return encoder.encode(await tree.fs.readlink(path));
    const data = await tree.fs.readFile(path);
    tree.counters.bytesRead += data.length;
    if (!tree.autocrlf)
        return data;
    try {
        return encoder.encode(textDecoder.decode(data).replace(/\r\n/g, '\n'));
    }
    catch {
        return data;
    }
}
/** A file is hashed this many bytes at a time, past this size: a big file is never held whole to be compared. */
const HASH_CHUNK = 1 << 20;
/** The id of the blob git would store for the file or link at `path`, `st` its lstat. */
export async function worktreeBlobId(tree, path, st) {
    if (st.type !== 'file' || tree.autocrlf || st.size <= HASH_CHUNK) {
        return objectId('blob', await worktreeBlob(tree, path, st.type));
    }
    tree.counters.filesRead++;
    const hash = createHash('sha1').update(objectIdPrefix('blob', st.size));
    for (let offset = 0; offset < st.size;) {
        const chunk = await tree.fs.readRange(path, offset, Math.min(HASH_CHUNK, st.size - offset));
        // Shorter than its stat said: the file changed under the read, and so is not the blob.
        if (chunk.length === 0)
            return '';
        hash.update(chunk);
        offset += chunk.length;
        tree.counters.bytesRead += chunk.length;
    }
    return oidToHex(hash.digest());
}
/** The index mode of a worktree file (ce_mode_from_stat): without a trusted exec bit a file keeps `indexMode`. */
export function modeFromStat(stat, indexMode, filemode) {
    if (stat.type === 'symlink')
        return S_IFLNK;
    if (!filemode && indexMode !== undefined && (indexMode & S_IFMT) === S_IFREG)
        return indexMode;
    return stat.mode & 0o100 ? 0o100755 : 0o100644;
}
// ce_match_stat_basic's verdicts.
const MTIME = 1;
const CTIME = 2;
const OWNER = 4;
const MODE = 8;
const INODE = 16;
const DATA = 32;
const TYPE = 64;
/** ce_match_stat_basic, in whole seconds (git without USE_NSEC), dev ignored (without USE_STDEV): 0 when the stat matches. */
export function matchStat(dc, i, st, filemode) {
    const mode = dc.mode(i);
    let changed = 0;
    switch (mode & S_IFMT) {
        case S_IFREG:
            if (st.type !== 'file')
                changed |= TYPE;
            if (filemode && ((mode ^ st.mode) & 0o100))
                changed |= MODE;
            break;
        case S_IFLNK:
            if (st.type !== 'symlink')
                changed |= TYPE;
            break;
        case S_IFGITLINK:
            return st.type === 'directory' ? 0 : TYPE;
    }
    if (dc.mtimeSeconds(i) !== Math.floor(st.mtimeMs / 1000) % 0x100000000)
        changed |= MTIME;
    if (dc.ctimeSeconds(i) !== Math.floor(st.ctimeMs / 1000) % 0x100000000)
        changed |= CTIME;
    if (dc.uid(i) !== st.uid % 0x100000000 || dc.gid(i) !== st.gid % 0x100000000)
        changed |= OWNER;
    if (dc.ino(i) !== st.ino % 0x100000000)
        changed |= INODE;
    if (dc.size(i) !== st.size % 0x100000000)
        changed |= DATA;
    // A racily smudged entry: size 0 for a blob that is not empty.
    if (dc.size(i) === 0 && dc.oid(i) !== EMPTY_BLOB)
        changed |= DATA;
    return changed;
}
const KIND_M = 1;
const KIND_D = 2;
const KIND_T = 3;
const KIND_D_DIRECTORY = 4;
/**
 * The entries that differ from the worktree, by entry number: one byte an
 * index entry, and the ids of the files the walk hashed. With every file of
 * a 96,000-file tree changed, this is 96 KB and the hashed half's ids, where
 * an object (and its lstat) per entry held about 30 MiB. A consumer that
 * needs a changed file's stat takes it again.
 */
export class DirtySet {
    kinds;
    oids = new Map();
    size = 0;
    constructor(entries) {
        this.kinds = new Uint8Array(entries);
    }
    set(i, dirty) {
        if (this.kinds[i] === 0)
            this.size++;
        this.kinds[i] = dirty.change === 'M' ? KIND_M : dirty.change === 'T' ? KIND_T : dirty.directory ? KIND_D_DIRECTORY : KIND_D;
        if (dirty.oid)
            this.oids.set(i, dirty.oid);
    }
    has(i) {
        return i >= 0 && i < this.kinds.length && this.kinds[i] !== 0;
    }
    get(i) {
        const kind = this.has(i) ? this.kinds[i] : 0;
        if (kind === 0)
            return undefined;
        const change = kind === KIND_M ? 'M' : kind === KIND_T ? 'T' : 'D';
        return { change, oid: this.oids.get(i), directory: kind === KIND_D_DIRECTORY || undefined };
    }
    /** The entries in index order. */
    *keys() {
        for (let i = 0; i < this.kinds.length; i++)
            if (this.kinds[i] !== 0)
                yield i;
    }
    *[Symbol.iterator]() {
        for (const i of this.keys())
            yield [i, this.get(i)];
    }
}
/**
 * refresh_cache_ent for one entry the worktree holds: null when it matches
 * (its stat refreshed in `dc` when the content had to decide), else how it
 * differs.
 */
export async function compareEntry(tree, dc, i, path, st, uncleanIsDirty = false, updates = dc) {
    const changed = matchStat(dc, i, st, tree.filemode);
    if (changed & TYPE)
        return { change: 'T' };
    if (changed & MODE)
        return { change: 'M' };
    if ((dc.mode(i) & S_IFMT) === S_IFGITLINK) {
        updates.markUptodate(i);
        return null;
    }
    const racy = changed === 0 && dc.isRacy(i);
    if (changed === 0 && !racy) {
        updates.markUptodate(i);
        return null;
    }
    if (tree.counters.why && tree.counters.why.length < 20) {
        tree.counters.why.push(`${path}: ${racy ? 'racy ' : ''}changed=${changed} size ${dc.size(i)}/${st.size} `
            + `mtime ${dc.mtimeSeconds(i)}/${Math.floor(st.mtimeMs / 1000)} ctime ${dc.ctimeSeconds(i)}/${Math.floor(st.ctimeMs / 1000)} `
            + `ino ${dc.ino(i)}/${st.ino} owner ${dc.uid(i)}:${dc.gid(i)}/${st.uid}:${st.gid} index ${dc.timestamp}`);
    }
    // The size moved on an entry that recorded one: modified, with nothing read. And, for git add,
    // any entry whose stat does not prove it clean: add_files_to_cache (DIFF_RACY_IS_MODIFIED) adds it again.
    if (((changed & DATA) && dc.size(i) !== 0) || uncleanIsDirty)
        return { change: 'M' };
    const oid = await worktreeBlobId(tree, path, st);
    if (oid !== dc.oid(i))
        return { change: 'M', oid: oid || undefined };
    updates.refresh(i, st);
    return null;
}
/**
 * The updates of a walk over a scan, kept until the scan has answered to its
 * end: a scan the tree changed under is walked again, from the index as it
 * was. An up-to-date entry costs its number; a refresh, its stat.
 */
class HeldIndexUpdates {
    uptodate = new Int32Array(64);
    count = 0;
    refreshed = [];
    markUptodate(i) {
        if (this.count === this.uptodate.length) {
            const grown = new Int32Array(this.uptodate.length * 2);
            grown.set(this.uptodate);
            this.uptodate = grown;
        }
        this.uptodate[this.count++] = i;
    }
    refresh(i, stat) {
        this.refreshed.push({ i, stat });
    }
    applyTo(dc) {
        for (let k = 0; k < this.count; k++)
            dc.markUptodate(this.uptodate[k]);
        for (const { i, stat } of this.refreshed)
            dc.refresh(i, stat);
    }
}
/** One listing name's tracked kinds: a file entry, a directory of entries, a gitlink. */
const TRACKED_FILE = 1;
const TRACKED_DIR = 2;
const TRACKED_GITLINK = 4;
/** How many times a worktree's scan is tried when the tree changes under it, before the walk by name. */
const SCAN_ATTEMPTS = 3;
/** A failure of the worktree's scan itself (not of a comparison): `changed` (EAGAIN) is tried again, else the walk asks by name. */
class ScanFailure extends Error {
    changed;
    constructor(changed) {
        super(changed ? 'the worktree changed under its scan' : 'worktree scan failed');
        this.changed = changed;
    }
}
/**
 * diff-files and read_directory over the whole worktree (or `specs`):
 * every tracked entry that differs, and what is untracked. Unmerged entries
 * (stage > 0) are left to the caller; skip-worktree and assume-unchanged
 * entries are never looked at, as git never looks at them.
 *
 * A worktree with a `scan` is read in that one ordered pass, merged with
 * the index as it goes; it is asked by name where the scan cannot answer (a
 * top it does not list as a readdir of the top does, a tree that changed
 * under it SCAN_ATTEMPTS times, a scan that failed).
 */
export async function scanWorktree(tree, dc, options) {
    const scan = tree.scan;
    if (scan !== undefined) {
        for (let attempt = 0; attempt < SCAN_ATTEMPTS; attempt++) {
            // Each attempt reads the .gitignore files afresh: one may have changed with the tree.
            options.excludes?.forget();
            try {
                const merged = await compare(tree, dc, options, scan);
                if (merged !== null)
                    return merged;
                break;
            }
            catch (error) {
                if (!(error instanceof ScanFailure))
                    throw error;
                if (!error.changed)
                    break;
            }
        }
        options.excludes?.forget();
    }
    const byName = await compare(tree, dc, options, null);
    if (byName === null)
        throw new Error('the walk by name always answers');
    return byName;
}
/** The comparison over the scan merged with the index, or (`scan` null) by name; null when the scan's top is not the top's listing. */
async function compare(tree, dc, options, scan) {
    const specs = (options.specs ?? []).includes('') ? [] : options.specs ?? [];
    const inScope = (path) => specs.length === 0 || specs.some((spec) => path === spec || path.startsWith(`${spec}/`));
    const onTheWay = (dir) => specs.some((spec) => spec.startsWith(`${dir}/`));
    const result = { dirty: new DirtySet(dc.count), untracked: [], unmerged: [], errors: { tracked: [], untracked: [] } };
    const join = (dir, name) => (dir ? `${dir}/${name}` : name);
    /** What the comparisons change in the index: at once by name, held until a scan has answered to its end. */
    const held = scan === null ? null : new HeldIndexUpdates();
    const updates = held ?? dc;
    const list = async (dir) => await tree.fs.list(dir);
    /** A directory's listing, or null when it cannot be read: the untracked scan warns, as read_directory does. */
    const listOrWarn = async (dir) => {
        try {
            return await list(dir);
        }
        catch (error) {
            if (options.untracked !== 'no')
                result.errors.untracked.push(`warning: could not open directory '${dir}/': ${strerror(error)}`);
            return null;
        }
    };
    /** An entry's lstat; a failure other than absence is reported (`<path>: <strerror>`) and the entry left alone. */
    const lstat = async (path) => {
        try {
            return await tree.fs.lstat(path);
        }
        catch (error) {
            result.errors.tracked.push(`${path}: ${strerror(error)}`);
            return undefined;
        }
    };
    const excluded = async (path, isDir) => options.excludes !== null && await options.excludes.isExcluded(path, isDir);
    /** -unormal's probe: anything untracked and not ignored below `dir`, a nested repository included. */
    const holdsUntracked = async (dir) => {
        for (const { name, type } of await listOrWarn(dir) ?? []) {
            if (name === '.git')
                continue;
            const path = join(dir, name);
            if (type !== 'directory') {
                if (type !== 'other' && !await excluded(path, false))
                    return true;
                continue;
            }
            if (await excluded(path, true))
                continue;
            if ((await listOrWarn(path) ?? []).some((entry) => entry.name === '.git') || await holdsUntracked(path))
                return true;
        }
        return false;
    };
    /**
     * An untracked path. A directory is listed whole ('dir/'), unless the
     * index holds a file at its name (`shadowed`): git drops such a name from
     * what it lists (index_name_is_other), though not the files below it.
     */
    const untracked = async (path, type, shadowed = false) => {
        if (type === 'other')
            return;
        const ignored = await excluded(path, type === 'directory');
        if (ignored && !options.ignoredToo)
            return;
        if (type !== 'directory') {
            if (inScope(path))
                result.untracked.push(path);
            return;
        }
        // A nested repository is listed as its directory, never entered.
        const entries = await listOrWarn(path) ?? [];
        if (entries.some((entry) => entry.name === '.git')) {
            if (inScope(path) && !shadowed)
                result.untracked.push(`${path}/`);
            return;
        }
        if (options.untracked === 'normal' && inScope(path) && !ignored) {
            if (!shadowed && await holdsUntracked(path))
                result.untracked.push(`${path}/`);
            return;
        }
        for (const entry of entries) {
            if (entry.name === '.git')
                continue;
            const child = join(path, entry.name);
            if (inScope(child) || (entry.type === 'directory' && onTheWay(child)))
                await untracked(child, entry.type);
        }
    };
    const deleted = (lo, hi) => {
        for (let i = lo; i < hi; i++) {
            if (dc.stage(i) !== 0 || dc.skipWorktree(i) || dc.assumeValid(i))
                continue;
            if (inScope(dc.path(i)))
                result.dirty.set(i, { change: 'D' });
        }
    };
    /** Entries [lo, hi) below a directory the walk could not reach: each one's lstat failed as the directory's did. */
    const unreachable = (lo, hi, error) => {
        for (let i = lo; i < hi; i++) {
            if (dc.stage(i) !== 0 || dc.skipWorktree(i) || dc.assumeValid(i) || !inScope(dc.path(i)))
                continue;
            result.errors.tracked.push(`${dc.path(i)}: ${error}`);
        }
    };
    const walk = async (dir, lo, hi) => {
        // A directory that cannot be listed (chmod 111) still holds its tracked entries: each is looked at by its
        // lstat, as git's diff-files looks, and nothing in it is untracked.
        let listing = new Map();
        const entries = await listOrWarn(dir);
        if (entries === null)
            listing = null;
        else
            for (const { name, type } of entries)
                if (name !== '.git')
                    listing.set(name, type);
        const tracked = new Map();
        const skip = dir ? utf8Length(dir) + 1 : 0;
        for (let i = lo; i < hi;) {
            const rest = dc.pathBytes(i).subarray(skip);
            const slash = rest.indexOf(0x2f);
            if (slash >= 0) {
                // A directory: the run of entries below it.
                const name = decodePath(rest.subarray(0, slash));
                const path = join(dir, name);
                const [, end] = dc.rangeUnder(path, i, hi);
                tracked.set(name, (tracked.get(name) ?? 0) | TRACKED_DIR);
                if (inScope(path) || onTheWay(path)) {
                    let type = listing?.get(name);
                    if (listing === null) {
                        try {
                            type = (await tree.fs.lstat(path))?.type;
                        }
                        catch (error) {
                            unreachable(i, end, strerror(error));
                            i = end;
                            continue;
                        }
                    }
                    if (type === 'directory')
                        await walk(path, i, end);
                    else
                        deleted(i, end);
                }
                i = end;
                continue;
            }
            const name = dc.path(i).slice(dir ? dir.length + 1 : 0);
            const path = join(dir, name);
            const gitlink = (dc.mode(i) & S_IFMT) === S_IFGITLINK;
            tracked.set(name, (tracked.get(name) ?? 0) | (gitlink ? TRACKED_GITLINK : TRACKED_FILE));
            let next = i + 1;
            while (next < hi && dc.stage(next) !== 0 && dc.path(next) === dc.path(i))
                next++;
            if (dc.stage(i) !== 0) {
                if (options.unmerged && inScope(path)) {
                    const type = listing === null ? undefined : listing.get(name);
                    const st = listing !== null && type === undefined ? null : await lstat(path);
                    if (st !== undefined)
                        result.unmerged.push({ path, lo: i, hi: next, stat: st });
                }
            }
            else if (!dc.skipWorktree(i) && !dc.assumeValid(i) && inScope(path)) {
                const type = listing === null ? undefined : listing.get(name);
                if (listing !== null && (type === undefined || (type === 'directory' && !gitlink))) {
                    result.dirty.set(i, type === undefined ? { change: 'D' } : { change: 'D', directory: true });
                }
                else {
                    const st = await lstat(path);
                    if (st !== undefined) {
                        const dirty = st === null ? { change: 'D' }
                            : st.type === 'directory' && !gitlink ? { change: 'D', directory: true }
                                : await compareEntry(tree, dc, i, path, st, options.uncleanIsDirty, updates);
                        if (dirty)
                            result.dirty.set(i, dirty);
                    }
                }
            }
            i = next;
        }
        if (options.untracked === 'no' || listing === null)
            return;
        for (const [name, type] of listing) {
            const kinds = tracked.get(name) ?? 0;
            // A gitlink owns whatever is at its path; a file entry a non-directory, a directory of entries a directory.
            if (kinds & TRACKED_GITLINK)
                continue;
            if (kinds & (type === 'directory' ? TRACKED_DIR : TRACKED_FILE))
                continue;
            const path = join(dir, name);
            if (inScope(path) || (type === 'directory' && onTheWay(path)))
                await untracked(path, type, (kinds & TRACKED_FILE) !== 0);
        }
    };
    if (scan === null) {
        await walk('', 0, dc.count);
        return result;
    }
    return await merge(scan) ? result : null;
    /**
     * The walk over the ordered scan: one cursor, advanced in step with the
     * index, which is in the same byte order. A directory's own entry comes
     * first, then (perhaps after siblings whose names sort before its `/`) the
     * run of what it holds; each run is one contiguous range, so the walk
     * holds only the directories it is in and the entry under the cursor. A
     * tracked entry is compared from the stat the scan gave; what the index
     * does not hold is judged untracked as the cursor passes it.
     */
    async function merge(source) {
        let top;
        try {
            top = await tree.fs.list('');
        }
        catch {
            return false;
        }
        const cursor = new ScanCursor(source());
        const topNames = [];
        await trackedDir('', TOP, 0, dc.count, topNames);
        const names = (listing) => [...listing].sort().join('/');
        if (names(topNames) !== names(top.map(({ name }) => name)))
            return false;
        // The scan answered to its end on one tree: what it proved goes into the index.
        held?.applyTo(dc);
        return true;
        /** The scan's `run`, passed over. */
        async function skipUnder(run) {
            for (let entry = await cursor.peek(); entry !== null && under(entry, run); entry = await cursor.peek())
                cursor.take();
        }
        /**
         * The run under `prefix` (the directory `dir`), child by child in the
         * scan's order: `onEntry` at each child's own entry (`before` first takes
         * what of the index sorts before it), then `onDir` once a child
         * directory's own run begins (or, empty, once it is passed), which must
         * consume that run. `onEntry`'s answer for a directory is handed to its
         * `onDir`.
         */
        async function children(run, dir, before, onEntry, onDir) {
            const skip = run.bytes.length;
            const pending = [];
            const open = async (name, path, entry, key, seen) => {
                before(key);
                await onDir(name, path, entry, runOf(run, name, key), key, seen);
            };
            // The directories whose runs sort before `limit` (all, when null) are empty: each is opened as such.
            const flush = async (limit) => {
                while (pending.length > 0 && (limit === null || compareBytes(pending[0].key, limit) < 0)) {
                    const next = pending[0];
                    pending.shift();
                    await open(next.name, next.path, next.entry, next.key, next.seen);
                }
            };
            for (let entry = await cursor.peek(); entry !== null && under(entry, run); entry = await cursor.peek()) {
                const rest = bytesOf(entry).subarray(skip);
                const slash = rest.indexOf(0x2f);
                if (slash < 0) {
                    await flush(rest);
                    before(rest);
                    cursor.take();
                    const name = entry.path.slice(dir ? dir.length + 1 : 0);
                    const path = join(dir, name);
                    const seen = await onEntry(name, path, entry, rest);
                    if (entry.stat.type === 'directory') {
                        const key = concatBytes(rest, SLASH);
                        let at = pending.length;
                        while (at > 0 && compareBytes(pending[at - 1].key, key) > 0)
                            at--;
                        pending.splice(at, 0, { name, path, key, entry, seen });
                    }
                    continue;
                }
                const key = rest.subarray(0, slash + 1);
                await flush(key);
                const at = pending.findIndex((p) => compareBytes(p.key, key) === 0);
                if (at >= 0) {
                    const [opened] = pending.splice(at, 1);
                    await open(opened.name, opened.path, opened.entry, opened.key, opened.seen);
                }
                else {
                    // A run whose directory's own entry the scan did not give: the directory, as it holds what it holds.
                    const name = decodePath(rest.subarray(0, slash));
                    await open(name, join(dir, name), null, key.slice(), undefined);
                }
            }
            await flush(null);
        }
        /** A tracked directory: its index entries [lo, hi) merged with its run under `prefix`. */
        async function trackedDir(dir, run, lo, hi, topNames) {
            const skip = run.bytes.length;
            let ix = lo;
            /** The index entry at `i` as one name of this directory sorts: a file's name, a directory's `name/`. */
            const itemKey = (i) => {
                const rest = dc.pathBytes(i).subarray(skip);
                const slash = rest.indexOf(0x2f);
                return slash >= 0 ? rest.subarray(0, slash + 1) : rest;
            };
            /** Index entries the worktree has nothing for, up to `key` (all, when null): as the walk by name finds them absent. */
            const absentBefore = (key) => {
                while (ix < hi && (key === null || compareBytes(itemKey(ix), key) < 0)) {
                    const rest = dc.pathBytes(ix).subarray(skip);
                    const slash = rest.indexOf(0x2f);
                    if (slash >= 0) {
                        const path = join(dir, decodePath(rest.subarray(0, slash)));
                        const [, end] = dc.rangeUnder(path, ix, hi);
                        if (inScope(path) || onTheWay(path))
                            deleted(ix, end);
                        ix = end;
                        continue;
                    }
                    const path = dc.path(ix);
                    let next = ix + 1;
                    while (next < hi && dc.stage(next) !== 0 && dc.path(next) === path)
                        next++;
                    if (dc.stage(ix) !== 0) {
                        if (options.unmerged && inScope(path))
                            result.unmerged.push({ path, lo: ix, hi: next, stat: null });
                    }
                    else if (!dc.skipWorktree(ix) && !dc.assumeValid(ix) && inScope(path)) {
                        result.dirty.set(ix, { change: 'D' });
                    }
                    ix = next;
                }
            };
            await children(run, dir, absentBefore, async (name, path, entry, key) => {
                topNames?.push(name);
                if (name === '.git')
                    return 0;
                let kinds = 0;
                if (ix < hi && compareBytes(itemKey(ix), key) === 0) {
                    // A tracked file (or gitlink) at this name: compared from the scan's stat.
                    const gitlink = (dc.mode(ix) & S_IFMT) === S_IFGITLINK;
                    let next = ix + 1;
                    while (next < hi && dc.stage(next) !== 0 && dc.path(next) === dc.path(ix))
                        next++;
                    if (dc.stage(ix) !== 0) {
                        if (options.unmerged && inScope(path))
                            result.unmerged.push({ path, lo: ix, hi: next, stat: entry.stat });
                    }
                    else if (!dc.skipWorktree(ix) && !dc.assumeValid(ix) && inScope(path)) {
                        const dirty = entry.stat.type === 'directory' && !gitlink ? { change: 'D', directory: true }
                            : await compareEntry(tree, dc, ix, path, entry.stat, options.uncleanIsDirty, updates);
                        if (dirty)
                            result.dirty.set(ix, dirty);
                    }
                    kinds = gitlink ? TRACKED_GITLINK : TRACKED_FILE;
                    ix = next;
                }
                if (entry.stat.type === 'directory' || kinds !== 0)
                    return kinds;
                // A gitlink owns whatever is at its path, a file entry a non-directory: anything else here is untracked.
                if (options.untracked !== 'no' && inScope(path))
                    await untracked(path, entry.stat.type);
                return kinds;
            }, async (name, path, entry, below, key, seen) => {
                const kinds = seen ?? 0;
                let runLo = ix;
                let runHi = ix;
                if (ix < hi && compareBytes(itemKey(ix), key) === 0) {
                    [runLo, runHi] = dc.rangeUnder(path, ix, hi);
                    ix = runHi;
                }
                if (name === '.git' || (kinds & TRACKED_GITLINK) !== 0)
                    return await skipUnder(below);
                const reached = inScope(path) || onTheWay(path);
                if (runHi > runLo && reached && !entry?.byName)
                    return await trackedDir(path, below, runLo, runHi);
                // The rest is asked by name, as the walk by name asks it: what the scan cannot list, and a
                // directory the index holds nothing in. That is read_directory's: its listing order decides what
                // -unormal's probe stops at, and a nested repository is known before anything in it is looked at.
                await skipUnder(below);
                if (!reached)
                    return;
                if (runHi > runLo)
                    await walk(path, runLo, runHi);
                else if (options.untracked !== 'no')
                    await untracked(path, 'directory', (kinds & TRACKED_FILE) !== 0);
            });
            absentBefore(null);
        }
    }
}
/** The byte `/`. */
const SLASH = new Uint8Array([0x2f]);
const TOP = { text: '', bytes: new Uint8Array(0) };
/** The run of the directory `name/` (`key`, its bytes) inside `run`. */
function runOf(run, name, key) {
    return { text: `${run.text}${name}/`, bytes: concatBytes(run.bytes, key) };
}
function bytesOf(entry) {
    entry.encoded ??= encoder.encode(entry.path);
    return entry.encoded;
}
/** The scan, one entry looked at before it is taken; a failure of the scan's own is a ScanFailure. */
class ScanCursor {
    entries;
    head;
    constructor(source) {
        this.entries = source[Symbol.asyncIterator]();
    }
    async peek() {
        if (this.head === undefined) {
            let next;
            try {
                next = await this.entries.next();
            }
            catch (error) {
                throw new ScanFailure(isVfsError(error, 'EAGAIN'));
            }
            const value = next.done ? null : next.value;
            this.head = value === null ? null : { path: value.path, stat: value.stat, byName: value.byName, encoded: null };
        }
        return this.head;
    }
    take() {
        this.head = undefined;
    }
}
/** Whether `entry` is in `run` (strictly below its directory). */
function under(entry, run) {
    return entry.path.length > run.text.length && entry.path.startsWith(run.text);
}
function compareBytes(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++)
        if (a[i] !== b[i])
            return a[i] - b[i];
    return a.length - b.length;
}
function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}
