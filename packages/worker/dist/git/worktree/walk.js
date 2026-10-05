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
import { strerror } from '@nimbus-sh/core/vfs/vfs-error.js';
import { oidToHex } from '../pack/format.js';
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
/** A file is hashed this many bytes at a time, past this size: a big file is never held whole to be compared. */
const HASH_CHUNK = 1 << 20;
/** The id of the blob git would store for the file or link at `path`, `st` its lstat. */
export async function worktreeBlobId(tree, path, st) {
    if (st.type !== 'file' || tree.autocrlf || st.size <= HASH_CHUNK) {
        return objectId('blob', await worktreeBlob(tree, path, st.type));
    }
    tree.counters.filesRead++;
    const hash = createHash('sha1').update(encoder.encode(`blob ${st.size}\0`));
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
/**
 * refresh_cache_ent for one entry the worktree holds: null when it matches
 * (its stat refreshed in `dc` when the content had to decide), else how it
 * differs.
 */
export async function compareEntry(tree, dc, i, path, st, uncleanIsDirty = false) {
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
    if (tree.counters.why && tree.counters.why.length < 20) {
        tree.counters.why.push(`${path}: ${racy ? 'racy ' : ''}changed=${changed} size ${dc.size(i)}/${st.size} `
            + `mtime ${dc.mtimeSeconds(i)}/${Math.floor(st.mtimeMs / 1000)} ctime ${dc.ctimeSeconds(i)}/${Math.floor(st.ctimeMs / 1000)} `
            + `ino ${dc.ino(i)}/${st.ino} owner ${dc.uid(i)}:${dc.gid(i)}/${st.uid}:${st.gid} index ${dc.timestamp}`);
    }
    // The size moved on an entry that recorded one: modified, with nothing read. And, for git add,
    // any entry whose stat does not prove it clean: add_files_to_cache (DIFF_RACY_IS_MODIFIED) adds it again.
    if (((changed & DATA) && dc.size(i) !== 0) || uncleanIsDirty)
        return { change: 'M', stat: st };
    const oid = await worktreeBlobId(tree, path, st);
    if (oid !== dc.oid(i))
        return { change: 'M', stat: st, oid: oid || undefined };
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
    const result = { dirty: new Map(), untracked: [], unmerged: [], errors: { tracked: [], untracked: [] } };
    const join = (dir, name) => (dir ? `${dir}/${name}` : name);
    const list = async (dir) => {
        tree.counters.readdirs++;
        return await tree.fs.list(dir);
    };
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
        tree.counters.lstats++;
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
                result.dirty.set(i, { change: 'D', stat: null });
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
                    let type = listing?.get(name);
                    if (listing === null) {
                        tree.counters.lstats++;
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
                    result.dirty.set(i, type === undefined ? { change: 'D', stat: null } : { change: 'D', stat: null, directory: true });
                }
                else {
                    const st = await lstat(path);
                    if (st !== undefined) {
                        const dirty = st === null ? { change: 'D', stat: null }
                            : st.type === 'directory' && !gitlink ? { change: 'D', stat: null, directory: true }
                                : await compareEntry(tree, dc, i, path, st, options.uncleanIsDirty);
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
    await walk('', 0, dc.count);
    return result;
}
