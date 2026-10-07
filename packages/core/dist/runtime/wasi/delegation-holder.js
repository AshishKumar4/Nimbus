/**
 * A WASI process as a delegation's holder (spike/delegation/MEMO.md, P4a):
 * inside the subtrees it holds, the process decides its creates, writes,
 * mkdirs, unlinks, renames and attribute changes itself, against what its
 * resident store knows and what it decided, with no round trip, and logs
 * them as calls into the process's filesystem client (process-fs-client.ts,
 * P4b), which takes the subtrees, numbers the log and sends it, in order:
 * at each point where what it wrote could be observed (a socket send, an
 * fsync, the end of its run) and when the session recalls a subtree.
 *
 * What it decides is the session's answer, kept exactly:
 *   - A subtree is held once the process has mutated in it often enough to
 *     be worth it (the client's policy): the deepest existing directory
 *     holding the name it changes, a bounded number of them. Never the
 *     whole filesystem, a home directory itself, or the session's stores
 *     (the session refuses those), and never a subtree with a default ACL
 *     in it (its inheritance is the session's to apply): there, the process
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
 *   - The log keeps program order: each decision is logged as it is made,
 *     and a file's bytes, which change write by write, are logged whole (its
 *     latest) before the next decision is, or at the flush.
 *
 * A recall is answered by a loop per grant on the host side of the process:
 * a guest that waits in a syscall lets it run; one computing does not
 * (the documented limit, answered by the session's recall timeout).
 */
import { fsError, modeAllows } from '../beneath-walk.js';
import { processFsClient } from '../../_shared/process-fs-client.js';
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
export function delegationHolder(options) {
    const { store } = options;
    const now = options.now ?? Date.now;
    /** Decided entries (null: removed) and decided names per directory. */
    const decided = new Map();
    const added = new Map();
    const removed = new Map();
    /** Files whose bytes are here, by inode number. */
    const files = new Map();
    const handles = new Map();
    let nextHandle = FIRST_LOCAL_HANDLE;
    /** Files written since their bytes were last logged, in the order last written. */
    const dirty = new Set();
    /** Whether anything was logged since the store was last told the session changed (sent). */
    let unsent = false;
    /** `file` stops being decided here (its grant is shared, recalled or gone): what it holds was logged, and it writes through from now on. */
    const goThrough = (file, ino) => {
        if (file.through !== undefined)
            return;
        const entry = decided.get(file.key) ?? store.entry(file.key);
        file.through = {
            ino,
            entry: entry ?? {
                type: 'file', dev: store.device, ino, nlink: 1, size: file.length, atime: now(), mtime: now(), ctime: now(),
                mode: 0o100000 | file.mode, uid: store.cred.uid, gid: store.cred.gid, revision: 0, target: null,
            },
        };
        file.bytes = new Uint8Array(0);
        dirty.delete(file);
    };
    /** Log each file's latest bytes, in the order last written, under the name it has now. */
    const drain = () => {
        if (dirty.size > 0)
            unsent = true;
        for (const file of [...dirty]) {
            dirty.delete(file);
            // A copy: the file's buffer keeps changing as the process writes. A
            // file made here makes its name with this write, with its number.
            const ino = file.made;
            delete file.made;
            client.submit({ type: 'call', call: { call: 'writeFile', path: file.key, mode: file.mode, ...(ino === undefined ? {} : { ino }), ...(file.umask === undefined ? {} : { umask: file.umask }), data: file.bytes.slice(0, file.length) } }, { acknowledged: true });
        }
    };
    /**
     * Forget what was decided under `root`: sent, so the store (after its
     * barrier) answers. Its files' open descriptions write through from now
     * on: a peer may write the file, and a whole-file write of what this
     * process held would overwrite what the peer wrote.
     */
    const dropDecisions = (root) => {
        drain();
        for (const [ino, file] of files)
            if (within(file.key, root))
                goThrough(file, ino);
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
    const client = processFsClient({
        session: options.session,
        now,
        ...(options.isHomeRoot === undefined ? {} : { isHomeRoot: options.isHomeRoot }),
        ...(options.grantAfter === undefined ? {} : { grantAfter: options.grantAfter }),
        ...(options.grantInos === undefined ? {} : { grantInos: options.grantInos }),
        ...(options.journal === undefined ? {} : { journal: options.journal }),
        released: dropDecisions,
        drain,
    });
    /** Log a decision, after the bytes written before it. */
    const log = (op) => {
        drain();
        unsent = true;
        client.submit(op, { acknowledged: true });
    };
    /** The store owes a barrier only once something this process decided reached the session. */
    const sentSome = () => {
        if (!unsent)
            return;
        unsent = false;
        options.sent?.();
    };
    const entryOf = (key) => {
        const own = decided.get(key);
        return own !== undefined ? own : store.entry(key);
    };
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
    /** The file's bytes changed: logged whole before the next decision, or at the flush. */
    const written = (file) => {
        if (file.detached)
            return;
        dirty.delete(file);
        dirty.add(file);
    };
    /** `file` lost its name (it was `entry`): what is written through its open descriptions stays theirs. */
    const detach = (file, entry) => {
        file.detached = { ...entry, nlink: 0, size: file.length };
        dirty.delete(file);
    };
    const handleOf = (handleId) => {
        const handle = handles.get(handleId);
        if (handle === undefined)
            throw fsError('EBADF', 'fd', String(handleId));
        return handle;
    };
    /**
     * Room for `length` bytes of `file`: drawn from the storage its subtree's
     * grant reserved while one holds it. A file whose grant is being given back
     * (renewed, idle) or is gone grows as any write does: the session judges
     * its bytes when they reach it (a refusal then is the flush's error).
     */
    const room = (file, length) => {
        if (length <= file.bytes.byteLength)
            return true;
        const grant = client.held(file.key);
        const size = Math.max(length, file.bytes.byteLength * 2, 4096);
        if (grant !== undefined && !client.draw(grant, size - file.bytes.byteLength))
            return false;
        const next = new Uint8Array(size);
        next.set(file.bytes.subarray(0, file.length));
        file.bytes = next;
        return true;
    };
    /** What the session refused of what was decided here: the run fails, naming it. */
    const failed = () => {
        const failures = client.takeFailures();
        if (failures.length > 0) {
            // Its first refusal's errno is the call's (EACCES, ENOSPC, …), as the session said it.
            throw fsError(failures[0].errno, 'fsync', failures[0].path, undefined, {
                detail: `the session refused what this process decided: ${failures.map((failure) => `${failure.op} ${failure.path}: ${failure.message}`).join('; ')}`,
            });
        }
    };
    const holder = {
        client,
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
            const current = entryOf(key);
            if (current === undefined || (current !== null && current.type !== 'file'))
                return undefined;
            const grant = client.holder(key);
            if (grant === undefined)
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
                const ino = client.number(grant);
                if (ino === undefined)
                    return undefined;
                const { uid, gid } = ownership(parent);
                const stamp = now();
                const asked = (flags.mode ?? 0o666) & 0o777;
                const entry = {
                    type: 'file', dev: store.device, ino, nlink: 1, size: 0, atime: stamp, mtime: stamp, ctime: stamp,
                    mode: 0o100000 | (asked & ~grant.umask), uid, gid, revision: 0, target: null,
                };
                decided.set(key, entry);
                note(parentKey(key), nameOf(key), 'file');
                // Its mode was decided under this umask: the session applies the same one.
                file = { key, bytes: new Uint8Array(0), length: 0, mode: asked, made: ino, umask: grant.umask };
                files.set(ino, file);
                // Made here: the name exists from now on, in the log's order. Logged
                // with its bytes, before the next decision (drain), as one call.
                drain();
                written(file);
            }
            else if (!flags.truncate) {
                // An existing file opened to write, not emptied (O_CREAT without
                // O_TRUNC): its bytes are kept, so only one whose bytes are here is
                // opened here; any other is the session's. Read permission too, when
                // it is opened to read.
                if (!modeAllows(current, flags.read ? 6 : 2, store.cred))
                    throw fsError('EACCES', 'open', path);
                const local = files.get(current.ino);
                if (local === undefined || local.key !== key || local.through !== undefined)
                    return undefined;
                file = local;
            }
            else {
                // An existing file emptied: decided here, its number the session's.
                if (!modeAllows(current, flags.read ? 6 : 2, store.cred))
                    throw fsError('EACCES', 'open', path);
                // A description writing it through is the session's: decided here anew.
                const known = files.get(current.ino);
                file = known !== undefined && known.through === undefined ? known : { key, bytes: new Uint8Array(0), length: 0, mode: current.mode & 0o7777 };
                file.length = 0;
                files.set(current.ino, file);
                decided.set(key, { ...current, size: 0, mtime: now(), ctime: now() });
                written(file);
            }
            const id = nextHandle--;
            handles.set(id, { file, readable: !!flags.read, writable: true, append: false, position: 0, path });
            return { id, path };
        },
        openThrough: async (key, path, flags) => {
            const call = {
                type: 'call',
                call: {
                    call: 'open', path: key, mode: (flags.mode ?? 0o666) & 0o7777,
                    ...(flags.create ? { create: true } : {}),
                    ...(flags.truncate ? { truncate: true } : {}),
                    ...(flags.exclusive ? { exclusive: true } : {}),
                    ...(flags.followSymlinks === false ? { nofollow: true } : {}),
                },
            };
            // After what was decided before it, as every op is.
            drain();
            const answer = await client.submit(call);
            const stat = answer.receipt;
            if (stat === undefined)
                throw fsError('EIO', 'open', path);
            // A write through it has nothing of its own to be told: the session is current.
            options.sent?.();
            const entry = {
                type: 'file', dev: stat.dev, ino: stat.ino, nlink: 1, size: stat.size, atime: stat.mtimeMs, mtime: stat.mtimeMs, ctime: stat.ctimeMs,
                mode: stat.mode, uid: stat.uid, gid: stat.gid, revision: stat.revision ?? 0, target: null,
            };
            // One file per number: every description of it shares its size.
            const known = files.get(stat.ino);
            const file = known?.through !== undefined
                ? Object.assign(known, { key, length: stat.size, through: { ino: stat.ino, entry } })
                : { key, bytes: new Uint8Array(0), length: stat.size, mode: stat.mode & 0o7777, through: { ino: stat.ino, entry } };
            files.set(stat.ino, file);
            const id = nextHandle--;
            handles.set(id, { file, readable: !!flags.read, writable: true, append: !!flags.append, position: 0, path });
            return { id, path };
        },
        through: (handleId) => handles.get(handleId)?.file.through !== undefined,
        writing: (ino) => {
            const file = files.get(ino);
            if (file?.through === undefined)
                return undefined;
            for (const handle of handles.values())
                if (handle.file === file)
                    return file.length;
            return undefined;
        },
        readThrough: async (handleId, offset, length, read) => {
            const handle = handleOf(handleId);
            if (!handle.readable)
                throw fsError('EBADF', 'read', handle.path);
            // What this process wrote is the session's before it reads.
            await client.flush();
            const start = offset ?? handle.position;
            const chunk = await read(handle.file.key, start, length);
            if (offset === null)
                handle.position = start + chunk.byteLength;
            return chunk;
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
            if (file.through !== undefined) {
                // Through: by the file's number, ordered with everything else; an
                // O_APPEND write lands at the file's end as the session has it then.
                const { ino } = file.through;
                if (handle.append) {
                    client.submit({ type: 'call', call: { call: 'append', path: file.key, ino, data: bytes.slice() } }, { acknowledged: true });
                    file.length += bytes.byteLength;
                    handle.position = file.length;
                }
                else {
                    const at = offset ?? handle.position;
                    client.submit({ type: 'call', call: { call: 'write', path: file.key, ino, offset: at, data: bytes.slice() } }, { acknowledged: true });
                    file.length = Math.max(file.length, at + bytes.byteLength);
                    if (offset === null)
                        handle.position = at + bytes.byteLength;
                }
                unsent = true;
                return bytes.byteLength;
            }
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
            written(file);
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
            if (file.through !== undefined) {
                client.submit({ type: 'call', call: { call: 'ftruncate', path: file.key, ino: file.through.ino, size } }, { acknowledged: true });
                file.length = size;
                unsent = true;
                return;
            }
            if (!room(file, size))
                throw fsError('ENOSPC', 'ftruncate', handle.path);
            if (size > file.length)
                file.bytes.fill(0, file.length, size);
            file.length = size;
            const entry = decided.get(file.key);
            if (entry)
                decided.set(file.key, { ...entry, size, mtime: now(), ctime: now() });
            written(file);
        },
        fstat: (handleId) => {
            const handle = handleOf(handleId);
            // Through: its stat at the open, with its size as this process made it.
            if (handle.file.through !== undefined)
                return { ...handle.file.through.entry, size: handle.file.length };
            // Its name gone: the description's own file, as it was then.
            if (handle.file.detached !== undefined)
                return { ...handle.file.detached, size: handle.file.length };
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
            const current = entryOf(key);
            if (current === undefined)
                return false;
            const grant = client.holder(key);
            if (grant === undefined)
                return false;
            if (current !== null)
                throw fsError('EEXIST', 'mkdir', path);
            const parent = writableParent(key, path, 'mkdir');
            if (parent === undefined)
                return false;
            const ino = client.number(grant);
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
            log({ type: 'call', call: { call: 'mkdir', path: key, mode: mode & 0o777, ino, umask: grant.umask } });
            return true;
        },
        unlink: (key, path) => {
            const current = entryOf(key);
            if (current === undefined || current === null || current.type === 'directory')
                return false;
            if (client.holder(key) === undefined)
                return false;
            if (writableParent(key, path, 'unlink') === undefined)
                return false;
            decided.set(key, null);
            note(parentKey(key), nameOf(key), null);
            const local = files.get(current.ino);
            if (local !== undefined && local.key === key) {
                files.delete(current.ino);
                // Its bytes go with it: nothing of them is logged, now or through a
                // description still open on it.
                detach(local, current);
                // Made here and never logged: the session never had the name.
                if (local.made !== undefined)
                    return true;
            }
            log({ type: 'call', call: { call: 'unlink', path: key } });
            return true;
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
            const grant = client.holder(from);
            if (grant === undefined || client.held(to) !== grant)
                return false;
            if (from === to)
                return true;
            if (writableParent(from, path, 'rename') === undefined || writableParent(to, path, 'rename') === undefined)
                return false;
            // What was written before the rename is logged under the name it had.
            drain();
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
            decided.set(to, { ...source, ctime: now() });
            note(parentKey(from), nameOf(from), null);
            note(parentKey(to), nameOf(to), source.type);
            // A file it replaces loses its name: its open descriptions keep its bytes.
            if (target !== null) {
                const replaced = files.get(target.ino);
                if (replaced !== undefined && replaced.key === to) {
                    files.delete(target.ino);
                    detach(replaced, target);
                }
            }
            for (const file of files.values())
                if (within(file.key, from))
                    file.key = to + file.key.slice(from.length);
            log({ type: 'rename', from, to });
            return true;
        },
        setattr: (key, attrs) => {
            const current = entryOf(key);
            if (current === undefined || current === null)
                return false;
            if (client.holder(key) === undefined)
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
            const local = files.get(current.ino);
            if (local !== undefined && 'mode' in attrs)
                local.mode = attrs.mode & 0o7777;
            log({ type: 'setattr', path: key, attrs });
            return true;
        },
        holds: (key) => client.held(key) !== undefined,
        pending: () => dirty.size > 0 || client.pending(),
        flush: async () => {
            await client.flush();
            sentSome();
            failed();
        },
        send: async () => {
            await client.flush();
            sentSome();
        },
        settle: async () => {
            drain();
            await client.settle();
            sentSome();
        },
        stats: () => {
            const stats = client.stats();
            return { waves: stats.waves, ops: stats.ops, recalls: stats.recalls, grants: stats.grants, widened: stats.widened };
        },
    };
    return holder;
}
