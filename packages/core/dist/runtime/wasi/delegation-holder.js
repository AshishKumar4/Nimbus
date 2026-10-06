/**
 * A WASI process as a delegation's holder (spike/delegation/MEMO.md, P4a):
 * inside the subtrees it holds, the process decides its creates, writes,
 * mkdirs, unlinks, renames and attribute changes itself, against what its
 * resident store knows and what it decided, with no round trip, and sends
 * them later as one ordered log (a W7 v4 wave under the delegation's lease):
 * at each point where what it wrote could be observed (a socket send, an
 * fsync, the end of its run) and when the session recalls the subtree.
 *
 * What it decides is the session's answer, kept exactly:
 *   - A subtree is held only where the process mutates: the deepest existing
 *     directory holding the name it changes, at most MAX_DELEGATIONS_PER_PROCESS
 *     of them; past that, two are widened to their common ancestor. Never the
 *     whole filesystem, a home directory itself, or the session's stores
 *     (the session refuses those), and never a subtree with a default ACL in
 *     it (its inheritance is the session's to apply): there, the process
 *     writes through as before.
 *   - Refusals are the walk's own (resolve), and the cases decided here are
 *     the plain ones: a create where the parent is a writable directory, a
 *     mkdir, an unlink of a file or link, a rename of a file, or of a
 *     directory to a free name outside itself, within one held subtree. Any
 *     other mutation in a held subtree sends the log first and is the
 *     session's, as before.
 *   - A name made here is numbered from the grant's reserved inode range and
 *     keeps that number in the session; it is owned as the session makes a
 *     holder's names (the process's, a setgid directory's group), its mode
 *     the asked mode less the umask.
 *   - The log keeps program order for whatever prefix of it lands: a file
 *     made here is logged where it is made (empty), and its bytes where it
 *     was last written, under the name it had then.
 *
 * A recall is answered by a loop per grant on the host side of the process:
 * a guest that waits in a syscall lets it run; one computing does not
 * (the documented limit, answered by the session's recall timeout).
 */
import { fsError, modeAllows } from '../beneath-walk.js';
import { encodeWriteBatchStream, w7ChunkCount } from '@nimbus-sh/platform/w7-frame.js';
import { pathsOverlap } from '../../vfs/path.js';
/** The most subtrees one process holds at once; past it, two are widened to their common ancestor. */
export const MAX_DELEGATIONS_PER_PROCESS = 8;
/** Inode numbers and storage bytes one grant asks for. */
const GRANT_INOS = 4096;
const GRANT_BYTES = 64 * 1024 * 1024;
/** How long one recall poll waits before asking again. */
const RECALL_POLL_MS = 20_000;
/** Descriptors this holder opens are numbered below every session descriptor. */
const FIRST_LOCAL_HANDLE = -1;
function parentKey(key) {
    const at = key.lastIndexOf('/');
    return at < 0 ? '' : key.slice(0, at);
}
function nameOf(key) {
    return key.slice(key.lastIndexOf('/') + 1);
}
function within(key, root) {
    return key === root || key.startsWith(`${root}/`);
}
function commonAncestor(left, right) {
    const a = left.split('/');
    const b = right.split('/');
    const out = [];
    for (let index = 0; index < Math.min(a.length, b.length) && a[index] === b[index]; index++)
        out.push(a[index]);
    return out.join('/');
}
export function delegationHolder(options) {
    const { session, store } = options;
    const now = options.now ?? Date.now;
    const grants = [];
    /** Decided entries (null: removed) and decided names per directory. */
    const decided = new Map();
    const added = new Map();
    const removed = new Map();
    /** Files whose bytes are here, by inode number. */
    const files = new Map();
    const handles = new Map();
    let nextHandle = FIRST_LOCAL_HANDLE;
    /** The log, in the order the process decided; a file's bytes (`content`) are taken when it is sent, under the name it had when last written. */
    const log = [];
    const counters = { waves: 0, ops: 0, recalls: 0, grants: 0, widened: 0 };
    let sending = null;
    const entryOf = (key) => {
        const own = decided.get(key);
        return own !== undefined ? own : store.entry(key);
    };
    const heldGrant = (key) => grants.find((grant) => !grant.ended && grant.mode === 'held' && within(key, grant.root));
    const allowedRoot = (root) => root !== '' && !(options.isHomeRoot?.(root) ?? false);
    /** The held grant a mutation at `key` is decided under, taking or widening one; undefined: the session decides it. */
    const claim = async (key) => {
        const held = heldGrant(key);
        if (held !== undefined)
            return held;
        // A subtree another process holds, or this one shares, is written through.
        if (grants.some((grant) => !grant.ended && pathsOverlap(key, grant.root)))
            return undefined;
        let root = parentKey(key);
        if (!allowedRoot(root))
            return undefined;
        const live = grants.filter((grant) => !grant.ended);
        if (live.length >= MAX_DELEGATIONS_PER_PROCESS) {
            // Full: the grant nearest to it and this one become their common ancestor.
            let best;
            let bestRoot = '';
            for (const grant of live) {
                const shared = commonAncestor(grant.root, root);
                if (best === undefined || shared.length > bestRoot.length) {
                    best = grant;
                    bestRoot = shared;
                }
            }
            if (best === undefined || !allowedRoot(bestRoot))
                return undefined;
            const merged = live.filter((grant) => within(grant.root, bestRoot));
            await flush();
            for (const grant of merged)
                await end(grant);
            counters.widened++;
            root = bestRoot;
        }
        let granted;
        try {
            granted = await session.acquire('/' + root, { reads: true, inos: GRANT_INOS, bytes: GRANT_BYTES });
        }
        catch {
            // EBUSY (someone else's lease), EPERM (the session's own), ENOSPC: written through.
            return undefined;
        }
        const range = granted.inos;
        const grant = {
            root: granted.root,
            owner: granted.owner,
            nextIno: range?.first ?? 0,
            endIno: range?.end ?? 0,
            bytesLeft: granted.bytes ?? 0,
            umask: granted.umask ?? 0o022,
            mode: 'held',
            ended: false,
        };
        grants.push(grant);
        counters.grants++;
        void answerRecalls(grant);
        return within(key, grant.root) ? grant : undefined;
    };
    /** A grant's recalls, for as long as it lasts: send what was decided, then do what was asked. */
    const answerRecalls = async (grant) => {
        while (!grant.ended) {
            let kind;
            try {
                kind = await session.awaitRecall(grant.owner, RECALL_POLL_MS);
            }
            catch {
                // ESTALE: the session ended it (revoked for an unanswered recall, or the process is ending).
                forget(grant);
                return;
            }
            if (kind === null)
                continue;
            counters.recalls++;
            try {
                await flush();
            }
            catch {
                // A wave the session refused: the recall is answered all the same; the refusal fails the run.
            }
            if (kind === 'share')
                grant.mode = 'shared';
            dropDecisions(grant.root);
            try {
                await session.recalled(grant.owner, kind);
            }
            catch { /* ended meanwhile */ }
            if (kind === 'revoke') {
                forget(grant);
                return;
            }
        }
    };
    /** Forget what was decided under `root`: sent, so the store (after its barrier) answers. */
    const dropDecisions = (root) => {
        for (const key of [...decided.keys()])
            if (within(key, root))
                decided.delete(key);
        for (const key of [...added.keys()])
            if (within(key, root))
                added.delete(key);
        for (const key of [...removed.keys()])
            if (within(key, root))
                removed.delete(key);
        options.sent?.();
    };
    const forget = (grant) => {
        grant.ended = true;
        const at = grants.indexOf(grant);
        if (at >= 0)
            grants.splice(at, 1);
    };
    const end = async (grant) => {
        if (grant.ended)
            return;
        forget(grant);
        dropDecisions(grant.root);
        try {
            await session.release(grant.owner);
        }
        catch { /* already ended */ }
    };
    const number = (grant) => (grant.nextIno < grant.endIno ? grant.nextIno++ : undefined);
    /** The ownership a new name under `parent` takes: the process's, with a setgid directory's group. */
    const ownership = (parent) => {
        const setgid = (parent.mode & 0o2000) !== 0;
        return { uid: store.cred.uid, gid: setgid ? parent.gid : store.cred.gid, setgid };
    };
    const note = (dir, name, type) => {
        if (type === null) {
            added.get(dir)?.delete(name);
            let gone = removed.get(dir);
            if (gone === undefined)
                removed.set(dir, gone = new Set());
            gone.add(name);
        }
        else {
            removed.get(dir)?.delete(name);
            let made = added.get(dir);
            if (made === undefined)
                added.set(dir, made = new Map());
            made.set(name, type);
        }
    };
    /** The parent of `key`, when the process may make a name in it: a known, writable, searchable directory of the session's filesystem. */
    const writableParent = (key, path, syscall) => {
        const parent = entryOf(parentKey(key));
        if (parent === undefined || parent === null || parent.dev !== store.device)
            return undefined;
        if (parent.type !== 'directory')
            throw fsError('ENOTDIR', syscall, path);
        if (!modeAllows(parent, 3, store.cred))
            throw fsError('EACCES', syscall, path);
        return parent;
    };
    /** Log the file's bytes where it was last written: one entry per file, moved to the end at each write. */
    const logContent = (file) => {
        const at = log.findIndex((item) => 'content' in item && item.content === file);
        if (at >= 0)
            log.splice(at, 1);
        log.push({ content: file, key: file.key });
    };
    /** A file op for `key` with `data`; numbered here, the session is told the number. */
    const fileOp = (key, entry, data, numbered) => ({
        type: 'file',
        inode: {
            path: key, parentPath: parentKey(key), kind: 'file', isDir: false,
            size: data.byteLength, mtime: entry.mtime, mode: entry.mode & 0o7777, chunkCount: w7ChunkCount(data.byteLength),
            ...(numbered ? { ino: entry.ino } : {}),
        },
        data,
    });
    const handleOf = (handleId) => {
        const handle = handles.get(handleId);
        if (handle === undefined)
            throw fsError('EBADF', 'fd', String(handleId));
        return handle;
    };
    const room = (file, length) => {
        if (length <= file.bytes.byteLength)
            return true;
        const grant = heldGrant(file.key);
        const size = Math.max(length, file.bytes.byteLength * 2, 4096);
        const more = size - file.bytes.byteLength;
        if (grant === undefined || grant.bytesLeft < more)
            return false;
        grant.bytesLeft -= more;
        const next = new Uint8Array(size);
        next.set(file.bytes.subarray(0, file.length));
        file.bytes = next;
        return true;
    };
    /** Send the log, in order, as waves under each grant's lease. */
    const flush = () => {
        if (sending !== null)
            return sending.then(() => (log.length > 0 ? flush() : undefined));
        if (log.length === 0)
            return Promise.resolve();
        sending = (async () => {
            const items = log.splice(0, log.length);
            // One wave per grant, in log order: the log is split where the grant changes.
            let wave = [];
            let owner = null;
            const send = async () => {
                if (wave.length === 0 || owner === null)
                    return;
                const ops = wave;
                wave = [];
                counters.waves++;
                counters.ops += ops.length;
                const result = await session.sendWave(encodeWriteBatchStream({ inodes: [], chunks: [], ops }), owner);
                if (!result.ok)
                    throw new Error(result.error?.message ?? 'the session refused the delegation\'s wave');
            };
            for (const item of items) {
                const key = 'op' in item ? keyOfOp(item.op) : item.key;
                const grant = grants.find((candidate) => within(key, candidate.root));
                if (grant === undefined)
                    continue;
                if (owner !== grant.owner) {
                    await send();
                    owner = grant.owner;
                }
                if ('op' in item) {
                    wave.push(item.op);
                    continue;
                }
                // The file as it is now (its latest bytes), under the name it had when last written.
                const entry = decided.get(item.content.key) ?? store.entry(item.content.key);
                if (!entry || entry.type !== 'file')
                    continue;
                wave.push(fileOp(item.key, entry, item.content.bytes.slice(0, item.content.length), item.content.numbered));
            }
            await send();
            options.sent?.();
        })().finally(() => { sending = null; });
        return sending;
    };
    const holder = {
        entry: (key) => decided.get(key),
        children: (key, base) => {
            const made = added.get(key);
            const gone = removed.get(key);
            if (made === undefined && gone === undefined)
                return base;
            // A directory made here has no names but the ones made in it; one the
            // store has not listed is listed first (undefined asks for that).
            const madeHere = store.entry(key) === null || (store.entry(key) === undefined && decided.get(key)?.type === 'directory');
            if (base === undefined && !madeHere)
                return undefined;
            const out = new Map();
            for (const child of base ?? [])
                if (!gone?.has(child.name))
                    out.set(child.name, child.type);
            for (const [name, type] of made ?? [])
                out.set(name, type);
            return [...out].map(([name, type]) => ({ name, type }));
        },
        content: (entry) => {
            if (entry.dev !== store.device)
                return undefined;
            const file = files.get(entry.ino);
            return file === undefined ? undefined : file.bytes.slice(0, file.length);
        },
        owns: (handleId) => handles.has(handleId),
        open: (key, path, flags) => {
            if (!flags.write || flags.append)
                return undefined;
            if (!flags.create && !flags.truncate)
                return undefined;
            // Set-id and sticky bits asked at creation are the session's to grant or strip.
            if (((flags.mode ?? 0o666) & 0o7000) !== 0)
                return undefined;
            const existing = entryOf(key);
            if (existing === undefined)
                return undefined;
            if (existing !== null && existing.type !== 'file')
                return undefined;
            return claim(key).then((grant) => {
                if (grant === undefined)
                    return undefined;
                const current = entryOf(key);
                if (current === undefined || (current !== null && current.type !== 'file'))
                    return undefined;
                if (current !== null && flags.exclusive && flags.create)
                    throw fsError('EEXIST', 'open', path);
                if (current === null && !flags.create)
                    throw fsError('ENOENT', 'open', path);
                let file;
                if (current === null) {
                    const parent = writableParent(key, path, 'open');
                    if (parent === undefined)
                        return undefined;
                    const ino = number(grant);
                    if (ino === undefined)
                        return undefined;
                    const { uid, gid } = ownership(parent);
                    const stamp = now();
                    const entry = {
                        type: 'file', dev: store.device, ino, nlink: 1, size: 0, atime: stamp, mtime: stamp, ctime: stamp,
                        mode: 0o100000 | ((flags.mode ?? 0o666) & 0o777 & ~grant.umask), uid, gid, revision: 0, target: null,
                    };
                    decided.set(key, entry);
                    note(parentKey(key), nameOf(key), 'file');
                    file = { key, bytes: new Uint8Array(0), length: 0, numbered: true };
                    files.set(ino, file);
                    // Made here: the name exists from now on, empty, in the log's order.
                    log.push({ op: fileOp(key, entry, new Uint8Array(0), true) });
                }
                else {
                    // An existing file emptied: decided here, its number the session's.
                    if (!modeAllows(current, 2, store.cred))
                        throw fsError('EACCES', 'open', path);
                    file = files.get(current.ino) ?? { key, bytes: new Uint8Array(0), length: 0, numbered: false };
                    file.length = 0;
                    files.set(current.ino, file);
                    decided.set(key, { ...current, size: 0, mtime: now(), ctime: now() });
                    logContent(file);
                }
                const id = nextHandle--;
                handles.set(id, { file, readable: !!flags.read, writable: true, append: false, position: 0, path });
                return { id, path };
            });
        },
        read: (handleId, offset, length) => {
            const handle = handleOf(handleId);
            if (!handle.readable)
                throw fsError('EBADF', 'read', handle.path);
            const start = Math.min(offset ?? handle.position, handle.file.length);
            const chunk = handle.file.bytes.slice(start, Math.min(handle.file.length, start + length));
            if (offset === null)
                handle.position = start + chunk.byteLength;
            return chunk;
        },
        write: (handleId, offset, bytes) => {
            const handle = handleOf(handleId);
            const file = handle.file;
            const start = offset ?? handle.position;
            const end = start + bytes.byteLength;
            if (!room(file, end))
                throw fsError('ENOSPC', 'write', handle.path);
            if (start > file.length)
                file.bytes.fill(0, file.length, start);
            file.bytes.set(bytes, start);
            file.length = Math.max(file.length, end);
            if (offset === null)
                handle.position = end;
            const entry = decided.get(file.key);
            if (entry)
                decided.set(file.key, { ...entry, size: file.length, mtime: now(), ctime: now() });
            logContent(file);
            return bytes.byteLength;
        },
        seek: (handleId, offset, whence) => {
            const handle = handleOf(handleId);
            const position = (whence === 'set' ? 0 : whence === 'current' ? handle.position : handle.file.length) + offset;
            if (position < 0)
                throw fsError('EINVAL', 'lseek', handle.path);
            handle.position = position;
            return position;
        },
        ftruncate: (handleId, size) => {
            const handle = handleOf(handleId);
            const file = handle.file;
            if (!room(file, size))
                throw fsError('ENOSPC', 'ftruncate', handle.path);
            if (size > file.length)
                file.bytes.fill(0, file.length, size);
            file.length = size;
            const entry = decided.get(file.key);
            if (entry)
                decided.set(file.key, { ...entry, size, mtime: now(), ctime: now() });
            logContent(file);
        },
        fstat: (handleId) => {
            const handle = handleOf(handleId);
            const entry = decided.get(handle.file.key) ?? store.entry(handle.file.key);
            if (!entry)
                throw fsError('EBADF', 'fstat', handle.path);
            return { ...entry, size: handle.file.length };
        },
        close: (handleId) => { handleOf(handleId); handles.delete(handleId); },
        keyOf: (handleId) => handleOf(handleId).file.key,
        dup: (handleId) => {
            const handle = handleOf(handleId);
            const id = nextHandle--;
            handles.set(id, handle);
            return { id, path: handle.path };
        },
        mkdir: (key, path, mode) => {
            if ((mode & 0o7000) !== 0)
                return false;
            const existing = entryOf(key);
            if (existing === undefined)
                return false;
            return claim(key).then((grant) => {
                if (grant === undefined)
                    return false;
                const current = entryOf(key);
                if (current === undefined)
                    return false;
                if (current !== null)
                    throw fsError('EEXIST', 'mkdir', path);
                const parent = writableParent(key, path, 'mkdir');
                if (parent === undefined)
                    return false;
                const ino = number(grant);
                if (ino === undefined)
                    return false;
                const { uid, gid, setgid } = ownership(parent);
                const stamp = now();
                const perm = (mode & 0o777 & ~grant.umask) | (setgid ? 0o2000 : 0);
                decided.set(key, {
                    type: 'directory', dev: store.device, ino, nlink: 2, size: 0, atime: stamp, mtime: stamp, ctime: stamp,
                    mode: 0o40000 | perm, uid, gid, revision: 0, target: null,
                });
                note(parentKey(key), nameOf(key), 'directory');
                added.set(key, added.get(key) ?? new Map());
                log.push({ op: { type: 'directory', inode: { path: key, parentPath: parentKey(key), kind: 'directory', isDir: true, size: 0, mtime: stamp, mode: perm, chunkCount: 0, ino } } });
                return true;
            });
        },
        unlink: (key, path) => {
            const existing = entryOf(key);
            if (existing === undefined || existing === null || existing.type === 'directory')
                return false;
            return claim(key).then((grant) => {
                if (grant === undefined)
                    return false;
                const current = entryOf(key);
                if (current === undefined || current === null || current.type === 'directory')
                    return false;
                if (writableParent(key, path, 'unlink') === undefined)
                    return false;
                decided.set(key, null);
                note(parentKey(key), nameOf(key), null);
                const local = files.get(current.ino);
                if (local !== undefined && local.key === key)
                    files.delete(current.ino);
                log.push({ op: { type: 'delete', path: key } });
                return true;
            });
        },
        rename: (from, to, path) => {
            const source = entryOf(from);
            const target = entryOf(to);
            if (source === undefined || source === null || target === undefined)
                return false;
            if (source.type === 'directory' && (target !== null || within(to, from)))
                return false;
            if (target !== null && (target.type === 'directory' || source.type === 'directory'))
                return false;
            return claim(from).then((grant) => {
                if (grant === undefined || heldGrant(to) !== grant)
                    return false;
                if (from === to)
                    return true;
                if (writableParent(from, path, 'rename') === undefined || writableParent(to, path, 'rename') === undefined)
                    return false;
                const moved = entryOf(from);
                if (moved === undefined || moved === null)
                    return false;
                // What was decided under the source moves with it.
                for (const [key, value] of [...decided]) {
                    if (key !== from && within(key, from)) {
                        decided.delete(key);
                        decided.set(to + key.slice(from.length), value);
                    }
                }
                for (const map of [added, removed]) {
                    for (const [key, value] of [...map])
                        if (within(key, from)) {
                            map.delete(key);
                            map.set(to + key.slice(from.length), value);
                        }
                }
                decided.set(from, null);
                decided.set(to, { ...moved, ctime: now() });
                note(parentKey(from), nameOf(from), null);
                note(parentKey(to), nameOf(to), moved.type);
                for (const file of files.values())
                    if (within(file.key, from))
                        file.key = to + file.key.slice(from.length);
                log.push({ op: { type: 'rename', from, to } });
                return true;
            });
        },
        setattr: (key, attrs) => {
            const existing = entryOf(key);
            if (existing === undefined || existing === null)
                return false;
            return claim(key).then((grant) => {
                if (grant === undefined)
                    return false;
                const current = entryOf(key);
                if (current === undefined || current === null)
                    return false;
                // Only the owner (or root) changes a mode or times here; anything else is the session's to refuse.
                if (store.cred.uid !== 0 && store.cred.uid !== current.uid)
                    return false;
                if ('uid' in attrs)
                    return false;
                const next = 'mode' in attrs
                    ? { ...current, mode: (current.mode & ~0o7777) | (attrs.mode & 0o7777), ctime: now() }
                    : { ...current, atime: attrs.atime, mtime: attrs.mtime, ctime: now() };
                decided.set(key, next);
                log.push({ op: { type: 'setattr', path: key, attrs } });
                return true;
            });
        },
        holds: (key) => heldGrant(key) !== undefined,
        pending: () => log.length > 0,
        flush: () => flush(),
        settle: async () => {
            try {
                await flush();
            }
            finally {
                for (const grant of [...grants])
                    await end(grant);
            }
        },
        stats: () => ({ ...counters }),
    };
    return holder;
}
/** The path an op of the log lands at, for the grant it is sent under. */
function keyOfOp(op) {
    switch (op.type) {
        case 'delete':
        case 'truncate':
        case 'setattr': return op.path;
        case 'directory':
        case 'file': return op.inode.path;
        case 'rename': return op.from;
    }
}
