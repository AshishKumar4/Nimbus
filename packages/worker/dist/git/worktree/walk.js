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
import { EMPTY_BLOB, S_IFGITLINK, S_IFLNK, S_IFMT, S_IFREG, decodePath, objectId } from './dircache.js';
export function newCounters() {
    return { readdirs: 0, lstats: 0, filesRead: 0, bytesRead: 0, objectsRead: 0 };
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
/**
 * refresh_cache_ent for one entry the worktree holds: null when it matches
 * (its stat refreshed in `dc` when the content had to decide), else how it
 * differs.
 */
export async function compareEntry(tree, dc, i, path, st) {
    const changed = matchStat(dc, i, st, tree.filemode);
    if (changed & TYPE)
        return { change: 'T', stat: st };
    if (changed & MODE)
        return { change: 'M', stat: st };
    if ((dc.mode(i) & S_IFMT) === S_IFGITLINK) {
        dc.markUptodate(i);
        return null;
    }
    const racy = changed === 0 && dc.isRacy(i);
    if (changed === 0 && !racy) {
        dc.markUptodate(i);
        return null;
    }
    // The size moved on an entry that recorded one: modified, with nothing read.
    if ((changed & DATA) && dc.size(i) !== 0)
        return { change: 'M', stat: st };
    const oid = objectId('blob', await worktreeBlob(tree, path, st.type));
    if (oid !== dc.oid(i))
        return { change: 'M', stat: st, oid };
    dc.refresh(i, st);
    return null;
}
/** One listing name's tracked kinds: a file entry, a directory of entries, a gitlink. */
const TRACKED_FILE = 1;
const TRACKED_DIR = 2;
const TRACKED_GITLINK = 4;
/**
 * diff-files and read_directory over the whole worktree (or `specs`):
 * every tracked entry that differs, and what is untracked. Unmerged entries
 * (stage > 0) are left to the caller; skip-worktree and assume-unchanged
 * entries are never looked at, as git never looks at them.
 */
export async function scanWorktree(tree, dc, options) {
    const specs = (options.specs ?? []).includes('') ? [] : options.specs ?? [];
    const inScope = (path) => specs.length === 0 || specs.some((spec) => path === spec || path.startsWith(`${spec}/`));
    const onTheWay = (dir) => specs.some((spec) => spec.startsWith(`${dir}/`));
    const result = { dirty: new Map(), untracked: [] };
    const join = (dir, name) => (dir ? `${dir}/${name}` : name);
    const list = async (dir) => {
        tree.counters.readdirs++;
        return await tree.fs.list(dir);
    };
    const excluded = async (path, isDir) => options.excludes !== null && await options.excludes.isExcluded(path, isDir);
    /** -unormal's probe: anything untracked and not ignored below `dir`, a nested repository included. */
    const holdsUntracked = async (dir) => {
        for (const { name, type } of await list(dir)) {
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
            if ((await list(path)).some((entry) => entry.name === '.git') || await holdsUntracked(path))
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
        const entries = await list(path);
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
                result.dirty.set(i, { change: 'D', stat: null });
        }
    };
    const walk = async (dir, lo, hi) => {
        const listing = new Map();
        for (const { name, type } of await list(dir))
            if (name !== '.git')
                listing.set(name, type);
        const tracked = new Map();
        const skip = dir ? encoder.encode(dir).length + 1 : 0;
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
                    if (listing.get(name) === 'directory')
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
            if (dc.stage(i) === 0 && !dc.skipWorktree(i) && !dc.assumeValid(i) && inScope(path)) {
                const type = listing.get(name);
                if (type === undefined || (type === 'directory' && !gitlink)) {
                    result.dirty.set(i, type === undefined ? { change: 'D', stat: null } : { change: 'D', stat: null, directory: true });
                }
                else {
                    tree.counters.lstats++;
                    const st = await tree.fs.lstat(path);
                    const dirty = st === null ? { change: 'D', stat: null } : await compareEntry(tree, dc, i, path, st);
                    if (dirty)
                        result.dirty.set(i, dirty);
                }
            }
            i = next;
        }
        if (options.untracked === 'no')
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
    await walk('', 0, dc.count);
    return result;
}
