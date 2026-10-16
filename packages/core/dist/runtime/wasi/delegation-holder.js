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
import { fsError } from '../beneath-walk.js';
import { chmodRefusal, chownedMode, chownRefusal, confinedModeRefusal, explicitTimes, modeAllows, timeAt, utimesRefusal } from '../../vfs/posix-access.js';
import { copiedPermissions, copyfileMode } from '../../vfs/vfs.js';
import { ownNames } from './own-names.js';
import { LINGER_MS, processFsClient } from '../../_shared/process-fs-client.js';
/** Descriptors this holder opens are numbered below every session descriptor. */
const FIRST_LOCAL_HANDLE = -1;
/** A decision no grant makes (HolderOptions.provisional). */
const PROVISIONAL = Symbol('provisional');
/** Where a provisional decision's numbers start: past any the session gives. */
const PROVISIONAL_INOS = 2 ** 50;
/** A new open description's id: unguessable, so no other process's call names it. */
const descriptionId = () => crypto.randomUUID().replaceAll('-', '');
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
    /** What it decided by name, until the view has it. */
    const names = ownNames({
        entry: (key) => store.entry(key),
        held: (key) => client.held(key) !== undefined,
        // A cell goes with its name, but for bytes still unlogged or open.
        forgot: (key, entry) => {
            const file = entry ? files.get(entry.ino) : undefined;
            if (file === undefined || file.key !== key || file.through !== undefined || dirty.has(file) || isOpen(file))
                return;
            files.delete(entry.ino);
            unreserve(file);
        },
    });
    /** Files whose bytes are here, by inode number. */
    const files = new Map();
    const handles = new Map();
    let nextHandle = FIRST_LOCAL_HANDLE;
    /** Files written since their bytes were last logged, in the order last written. */
    const dirty = new Set();
    // Changes logged, numbered; the last written through (the store answers for it once sent);
    // and the last a completed send covered: a send covers only what was logged when it began.
    let changes = 0;
    let throughLogged = 0;
    let sentAt = 0;
    /** Log `op`, the process told it succeeded: its names are this process's own until the view has them. */
    const acknowledged = (op) => {
        const answered = client.submit(op, { acknowledged: true });
        const keys = names.logged(op);
        void answered.then((answer) => names.answered(keys, answer.failed !== undefined), () => names.answered(keys, true));
        return answered;
    };
    /** What `file`'s cell took of the process's budget goes back. */
    const unreserve = (file) => {
        if (file.reserved === undefined)
            return;
        store.release?.(file.reserved);
        delete file.reserved;
    };
    /**
     * What decides a change at `key`: the grant of a subtree the process
     * holds there (counted toward taking one either way); else, for a caller
     * that cannot wait, PROVISIONAL: answered from this view and logged, the
     * session's to refuse.
     */
    const deciding = (key) => client.holder(key) ?? (options.provisional?.() === true ? PROVISIONAL : undefined);
    const umaskOf = (decider) => (decider === PROVISIONAL ? options.umask?.() ?? 0o022 : decider.umask);
    /** What a provisional decision makes is numbered here until the view has it, past any number the session gives. */
    let nextLocalIno = PROVISIONAL_INOS;
    const numberFor = (decider) => (decider === PROVISIONAL ? nextLocalIno++ : client.number(decider));
    /**
     * `file` stops being decided here (its grant is shared, recalled or gone,
     * or the process is about to change a name or an access above it): what
     * it holds was logged, and it writes through from now on. Each open
     * description of it is opened at the session, in the log's order, with
     * the access it was opened with. `made`: the file is not made at the
     * session yet, and its mode refuses what its descriptions do (creat(2) of
     * 0444): its first description's open makes it (create, exclusive, its
     * number), which keeps that access as creat(2) does, and its bytes are
     * written through that description.
     */
    const goThrough = (file, ino, made) => {
        if (file.through !== undefined)
            return;
        delete file.logged;
        const entry = names.decided(file.key) ?? store.entry(file.key);
        file.through = {
            ino,
            entry: entry ?? {
                type: 'file', dev: store.device, ino, nlink: 1, size: file.length, atime: now(), mtime: now(), ctime: now(),
                mode: 0o100000 | file.mode, uid: store.cred.uid, gid: store.cred.gid, revision: 0, target: null,
            },
        };
        const bytes = file.bytes.subarray(0, file.length);
        file.bytes = new Uint8Array(0);
        dirty.delete(file);
        const opened = [...new Set(handles.values())].filter((handle) => handle.file === file && handle.description === undefined);
        opened.forEach((handle, at) => {
            const description = handle.description = descriptionId();
            // The first makes the file when it is not made yet: the creating open, and the bytes written through it.
            const creating = made !== undefined && at === 0;
            const making = creating ? { create: true, exclusive: true, ino: made, ...(file.umask === undefined ? {} : { umask: file.umask }) } : {};
            const answer = acknowledged({ type: 'call', call: { call: 'open', path: file.key, mode: file.mode, ...making, ...(handle.readable ? { read: true } : {}), description } });
            handle.session = answer.then((answered) => answered.receipt?.handle, () => undefined);
            if (creating && bytes.byteLength > 0) {
                acknowledged({ type: 'call', call: { call: 'write', path: file.key, ino, description, offset: 0, data: bytes.slice() } });
            }
        });
    };
    /** Whether a description of `file` is open here. */
    const isOpen = (file) => {
        for (const handle of handles.values())
            if (handle.file === file)
                return true;
        return false;
    };
    /** The file a descriptor reads and writes now: an inode descriptor's cell here where there is one, else what it opened. */
    const liveFile = (handle) => (handle.inode === undefined ? handle.file : files.get(handle.inode) ?? handle.file);
    /**
     * A view's file as it is now: the entry its name gives it while that is
     * still its file (by its number), and its bytes there; else the last it
     * had, nlink 0. Bytes undefined where the store does not hold them.
     */
    const viewed = (file) => {
        const view = file.view;
        const now = entryOf(file.key);
        if (now && now.type === 'file' && now.dev === view.entry.dev && now.ino === view.entry.ino)
            view.entry = now;
        else if (view.entry.nlink !== 0)
            view.entry = { ...view.entry, nlink: 0 };
        const bytes = store.content?.(file.key, view.entry.revision);
        return { entry: view.entry, bytes: bytes !== undefined && bytes.byteLength === view.entry.size ? bytes : undefined };
    };
    /**
     * An inode descriptor's file made a cell here, of the store's bytes, to
     * write: what every descriptor of it and every call by name share from
     * now on. Undefined where the store does not hold them; ESTALE where no
     * name leads to the file any more.
     */
    const cellOf = (handle) => {
        const file = liveFile(handle);
        if (file.view === undefined)
            return file;
        const { entry, bytes } = viewed(file);
        if (entry.nlink === 0)
            throw fsError('ESTALE', 'write', handle.path);
        if (bytes === undefined)
            return undefined;
        const cell = { key: file.key, bytes: new Uint8Array(0), length: 0, mode: entry.mode & 0o7777, logged: bytes.byteLength };
        if (!room(cell, bytes.byteLength))
            throw fsError('ENOSPC', 'write', handle.path);
        cell.bytes.set(bytes);
        cell.length = bytes.byteLength;
        files.set(entry.ino, cell);
        return cell;
    };
    /** Whether `file`'s mode, as decided here, refuses one of its open descriptions what it was opened to do: only its creating open could have. */
    const refusedByMode = (file) => {
        const entry = names.decided(file.key);
        if (entry === undefined || entry === null)
            return false;
        for (const handle of handles.values()) {
            if (handle.file === file && !modeAllows(entry, handle.readable ? 6 : 2, store.cred))
                return true;
        }
        return false;
    };
    /**
     * The process is about to change a name or an access at or above `keys`
     * (anywhere, when absent): each file it holds open there goes through
     * first. With the grant exclusive, the session's state under it changes
     * only by what this process does; so switching before each such change
     * keeps the local open's view exact: the open sent now is decided against
     * the state the local open saw, never re-authorized against a later one.
     */
    const throughAt = (keys) => {
        const open = [];
        for (const [ino, file] of files) {
            if (file.through !== undefined || file.detached !== undefined || !isOpen(file))
                continue;
            if (keys === undefined || keys.some((key) => within(file.key, key)))
                open.push([ino, file]);
        }
        if (open.length === 0)
            return;
        drain();
        for (const [ino, file] of open)
            goThrough(file, ino);
    };
    /**
     * Log each file's latest bytes, in the order last written, under the name
     * it has now: whole, or where the log holds what it was up to an offset,
     * from there (cut to its length first, where it shrank).
     */
    const drain = () => {
        if (dirty.size > 0)
            changes++;
        for (const file of [...dirty]) {
            const from = Math.min(file.changedFrom ?? 0, file.logged ?? 0);
            // A copy: the file's buffer keeps changing as the process writes. A
            // file made here makes its name with this write, with its number.
            const ino = file.made;
            // Its mode refuses its creating open what it writes: made by that open, and written through it.
            if (ino !== undefined && refusedByMode(file)) {
                dirty.delete(file);
                delete file.changedFrom;
                delete file.made;
                goThrough(file, ino, ino);
                continue;
            }
            if (ino === undefined && from > 0) {
                if (file.length < file.logged)
                    acknowledged({ type: 'call', call: { call: 'ftruncate', path: file.key, size: file.length } });
                if (file.length > from)
                    acknowledged({ type: 'call', call: { call: 'write', path: file.key, offset: from, data: file.bytes.slice(from, file.length) } });
            }
            else {
                acknowledged({ type: 'call', call: { call: 'writeFile', path: file.key, mode: file.mode, ...(ino === undefined ? {} : { ino }), ...(file.umask === undefined ? {} : { umask: file.umask }), data: file.bytes.slice(0, file.length) } });
            }
            // Unlogged until the log took it: one that refused it (the session
            // ended the process) leaves it for the settle's (logHeld).
            dirty.delete(file);
            delete file.changedFrom;
            delete file.made;
            file.logged = file.length;
        }
    };
    /** Armed while a file's bytes are unlogged: logs them at the latest LINGER_MS after the first, as the client sends what lingers. */
    let lingerTimer = null;
    /**
     * The subtree at `root` is no longer held: what was decided there is sent,
     * and retires as anything of the process's own does, once a barrier
     * begun after its answer lands (retire). Its files' open descriptions
     * write through from now on: a peer may write the file, and a whole-file
     * write of what this process held would overwrite what the peer wrote.
     */
    const dropDecisions = (root) => {
        drain();
        for (const [ino, file] of files)
            if (within(file.key, root))
                goThrough(file, ino);
        names.released(root);
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
        // Closing starts (a recall, an idle or renewing give-back): nothing more
        // is decided under it, and its files' descriptions write through from now
        // on, so the flush that follows covers everything accepted before.
        freezing: (root) => {
            drain();
            for (const [ino, file] of files)
                if (within(file.key, root))
                    goThrough(file, ino);
        },
        drain,
    });
    /** Log a decision, after the bytes written before it. */
    const log = (op) => {
        drain();
        changes++;
        acknowledged(op);
    };
    /** What was logged up to `covered` reached the session: the store owes a barrier once something did. */
    const sentSome = (covered) => {
        if (covered <= sentAt)
            return;
        sentAt = covered;
        options.sent?.();
    };
    const entryOf = (key) => {
        const mine = names.entry(key);
        return mine !== undefined ? mine : store.entry(key);
    };
    /** The ownership a new name under `parent` takes: the process's, with a setgid directory's group. */
    const ownership = (parent) => {
        const setgid = (parent.mode & 0o2000) !== 0;
        return { uid: store.cred.uid, gid: setgid ? parent.gid : store.cred.gid, setgid };
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
    /**
     * The file's bytes changed, from `from` on: logged before the next
     * decision, at the flush, or LINGER_MS after the first unlogged change,
     * whichever comes first.
     */
    const written = (file, from = 0) => {
        if (file.detached)
            return;
        file.changedFrom = Math.min(file.changedFrom ?? from, from);
        dirty.delete(file);
        dirty.add(file);
        // A cell no grant holds (a provisional decision's, an inode descriptor's)
        // is logged at once, as a synchronous write is parked: what the log holds
        // unanswered is what it counts (fitsSync).
        if (client.held(file.key) === undefined) {
            drain();
            return;
        }
        lingerTimer ??= setTimeout(() => {
            lingerTimer = null;
            // No caller to answer here: a log that refuses (the session ended the
            // process) keeps the bytes unlogged, for the settle, and the next flush reports it.
            try {
                drain();
            }
            catch { /* the next flush reports it */ }
        }, LINGER_MS);
    };
    /**
     * `entry`'s file loses its name here (`local`, its cell, if it has one):
     * its inode descriptors keep what it holds until their last close, as a
     * file without a name does. One whose bytes the store does not hold reads
     * as a file no name leads to (ESTALE).
     */
    const orphan = (entry, local) => {
        for (const handle of handles.values()) {
            if (handle.inode !== entry.ino)
                continue;
            let file = local;
            if (file === undefined) {
                const bytes = store.content?.(handle.file.key, entry.revision);
                if (bytes === undefined || bytes.byteLength !== entry.size)
                    continue;
                file = local = { key: handle.file.key, bytes: bytes.slice(), length: bytes.byteLength, mode: entry.mode & 0o7777, detached: { ...entry, nlink: 0 } };
            }
            handle.file = file;
            delete handle.inode;
        }
    };
    /** `file` lost its name (it was `entry`): what is written through its open descriptions stays theirs. */
    const detach = (file, entry) => {
        file.detached = { ...entry, nlink: 0, size: file.length };
        delete file.logged;
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
     * grant reserved while one holds it; a provisional decision's from the
     * process's budget (HolderStore.reserve), given back when its cell goes.
     * A file whose grant is being given back (renewed, idle) or is gone grows
     * as any write does: the session judges its bytes when they reach it (a
     * refusal then is the flush's error).
     */
    const room = (file, length) => {
        if (length <= file.bytes.byteLength)
            return true;
        const grant = client.held(file.key);
        const size = Math.max(length, file.bytes.byteLength * 2, 4096);
        const more = size - file.bytes.byteLength;
        if (grant !== undefined && !client.draw(grant, more))
            return false;
        // A cell no grant holds (a provisional decision's, an inode descriptor's) takes what the process's budget has.
        if (grant === undefined) {
            if (store.reserve !== undefined && !store.reserve(more))
                return false;
            file.reserved = (file.reserved ?? 0) + more;
        }
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
    /** An owner or group id a chown keeps (null, or -1 as fchown(2) spells it): null, as chownRefusal takes it. */
    const kept = (id) => (id === -1 ? null : id);
    /** `entry` as chmod, chown (the set-id bits chownedMode clears) and utimes leave it, its ctime now. */
    const changedBy = (entry, attrs) => ('mode' in attrs ? { ...entry, mode: (entry.mode & ~0o7777) | (attrs.mode & 0o7777), ctime: now() }
        : 'uid' in attrs ? { ...entry, uid: kept(attrs.uid) ?? entry.uid, gid: kept(attrs.gid) ?? entry.gid, mode: chownedMode(entry.mode, store.cred), ctime: now() }
            : { ...entry, atime: attrs.atime, mtime: attrs.mtime, ctime: now() });
    const holder = {
        client,
        entry: (key) => names.entry(key),
        children: (key, base) => names.children(key, base),
        copyFile: (from, to, path, stored, keepMode) => {
            const source = entryOf(from);
            // The source as the session's copy reads it: a file it may read, no set-id bit (the session's to judge).
            if (source === undefined || source === null || source.type !== 'file' || (source.mode & 0o7000) !== 0)
                return false;
            if (!modeAllows(source, 4, store.cred))
                return false;
            const target = entryOf(to);
            if (target === undefined || (target !== null && target.type !== 'file'))
                return false;
            // Counted toward taking the destination's subtree, as any change there is.
            const grant = deciding(to);
            if (grant === undefined || (grant !== PROVISIONAL && client.held(from) === undefined))
                return false;
            const bytes = holder.content(source) ?? stored;
            if (bytes === undefined)
                return false;
            const known = target === null ? undefined : files.get(target.ino);
            // Another's file there, or one this process holds open, is the session's to copy over.
            if (target !== null && ((store.cred.uid !== 0 && target.uid !== store.cred.uid) || (known !== undefined && isOpen(known))))
                return false;
            const umask = umaskOf(grant);
            const asked = copiedPermissions(source.mode, false);
            // What the open leaves (cp(1)'s mode), and with keepMode its fchmod to the source's: one a confined principal may not grant is the session's.
            const opened = target === null ? asked & ~umask : target.mode & 0o7777;
            const mode = keepMode ? copyfileMode(source.mode, bytes.byteLength, store.cred.uid) : opened;
            if (keepMode && confinedModeRefusal(opened, mode) !== null)
                return false;
            let entry;
            let made;
            if (target === null) {
                const parent = writableParent(to, path, 'copyfile');
                if (parent === undefined)
                    return false;
                const ino = numberFor(grant);
                if (ino === undefined)
                    return false;
                // A grant's number is the session's too; a provisional one is the session's to give.
                if (grant !== PROVISIONAL)
                    made = ino;
                const { uid, gid } = ownership(parent);
                const stamp = now();
                entry = { type: 'file', dev: store.device, ino, nlink: 1, size: bytes.byteLength, atime: stamp, mtime: stamp, ctime: stamp, mode: 0o100000 | mode, uid, gid, revision: 0, target: null };
            }
            else {
                if (!modeAllows(target, 2, store.cred))
                    throw fsError('EACCES', 'copyfile', path);
                entry = { ...target, size: bytes.byteLength, mode: (target.mode & ~0o7777) | mode, mtime: now(), ctime: now() };
            }
            // After everything decided before it, the destination's own bytes among them.
            drain();
            // Held here as an emptied file's written bytes are: in its cell (an
            // O_TRUNC open keeps it), what more they take drawn from what the
            // grant reserved (room); else the session copies.
            const file = known !== undefined && known.through === undefined ? known : { key: to, bytes: new Uint8Array(0), length: 0, mode };
            if (!room(file, bytes.byteLength))
                return false;
            file.bytes.set(bytes);
            file.length = bytes.byteLength;
            file.logged = bytes.byteLength;
            file.mode = mode;
            if (target === null)
                names.note(parentKey(to), nameOf(to), 'file');
            names.decide(to, entry);
            files.set(entry.ino, file);
            const description = descriptionId();
            changes++;
            acknowledged({ type: 'call', call: { call: 'open', path: to, mode: asked, ...(made !== undefined ? { ino: made, umask } : grant === PROVISIONAL && target === null ? { umask } : {}), create: true, truncate: true, ...(keepMode ? { fchmod: mode } : {}), description } });
            acknowledged({ type: 'call', call: { call: 'write', path: to, ...(made === undefined ? {} : { ino: made }), description, offset: 0, data: bytes.slice() } });
            acknowledged({ type: 'call', call: { call: 'close', path: to, description } });
            return true;
        },
        logHeld: () => {
            client.seal();
            drain();
        },
        content: (entry) => {
            if (entry.dev !== store.device)
                return undefined;
            const file = files.get(entry.ino);
            // A file written through holds no bytes here: the session's are its.
            return file === undefined || file.through !== undefined ? undefined : file.bytes.slice(0, file.length);
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
            const grant = deciding(key);
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
                const ino = numberFor(grant);
                if (ino === undefined)
                    return undefined;
                const { uid, gid } = ownership(parent);
                const stamp = now();
                const asked = (flags.mode ?? 0o666) & 0o777;
                const umask = flags.umask ?? umaskOf(grant);
                const entry = {
                    type: 'file', dev: store.device, ino, nlink: 1, size: 0, atime: stamp, mtime: stamp, ctime: stamp,
                    mode: 0o100000 | (asked & ~umask), uid, gid, revision: 0, target: null,
                };
                names.decide(key, entry);
                names.note(parentKey(key), nameOf(key), 'file');
                // Its mode was decided under this umask: the session applies the same
                // one, and the number a grant reserved (a provisional one is the session's to give).
                file = { key, bytes: new Uint8Array(0), length: 0, mode: asked, ...(grant === PROVISIONAL ? {} : { made: ino }), umask };
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
                names.decide(key, { ...current, size: 0, mtime: now(), ctime: now() });
                written(file);
            }
            const id = nextHandle--;
            handles.set(id, { file, readable: !!flags.read, writable: true, append: false, position: 0, path });
            return { id, path };
        },
        openInode: (key, path, flags, entry) => {
            const write = flags.write === true || flags.append === true;
            const read = flags.read === true || !write;
            if (!modeAllows(entry, (read ? 4 : 0) | (write ? 2 : 0), store.cred))
                throw fsError('EACCES', 'open', path);
            const file = { key, bytes: new Uint8Array(0), length: 0, mode: entry.mode & 0o7777, view: { entry } };
            const id = nextHandle--;
            handles.set(id, { file, inode: entry.ino, readable: read, writable: write, append: flags.append === true, position: 0, path });
            return { id, path };
        },
        inodeOf: (handleId) => {
            const handle = handles.get(handleId);
            const file = handle === undefined ? undefined : liveFile(handle);
            if (file?.view === undefined)
                return undefined;
            const { entry } = viewed(file);
            return entry.nlink === 0 ? undefined : { key: file.key, entry };
        },
        writeFile: (key, path, bytes, flags) => {
            const provisional = client.held(key) === undefined;
            if (provisional) {
                client.fitsSync(bytes.byteLength, path);
                if (store.reserve !== undefined && !store.reserve(bytes.byteLength))
                    throw fsError('ENOSPC', 'write', path);
            }
            let handle;
            try {
                handle = holder.open(key, path, flags);
            }
            finally {
                if (provisional && handle === undefined)
                    store.release?.(bytes.byteLength);
            }
            if (handle === undefined)
                return undefined;
            const file = handleOf(handle.id).file;
            if (provisional) {
                // Its bytes are the ones reserved for them.
                unreserve(file);
                file.bytes = bytes.slice();
                file.reserved = bytes.byteLength;
                file.length = bytes.byteLength;
                const entry = names.decided(key);
                if (entry)
                    names.decide(key, { ...entry, size: file.length, mtime: now(), ctime: now() });
                written(file, 0);
            }
            else {
                holder.write(handle.id, 0, bytes);
            }
            const revision = holder.fstat(handle.id).revision;
            holder.close(handle.id);
            return revision;
        },
        openThrough: async (key, path, flags) => {
            const description = descriptionId();
            const call = {
                type: 'call',
                call: {
                    call: 'open', path: key, mode: (flags.mode ?? 0o666) & 0o7777,
                    ...(flags.umask === undefined ? {} : { umask: flags.umask }),
                    ...(flags.create ? { create: true } : {}),
                    ...(flags.truncate ? { truncate: true } : {}),
                    ...(flags.exclusive ? { exclusive: true } : {}),
                    ...(flags.followSymlinks === false ? { nofollow: true } : {}),
                    ...(flags.read ? { read: true } : {}),
                    description,
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
            handles.set(id, { file, readable: !!flags.read, writable: true, append: !!flags.append, position: 0, path, description, session: Promise.resolve(stat.handle) });
            return { id, path };
        },
        through: (handleId) => {
            const handle = handles.get(handleId);
            return handle !== undefined && liveFile(handle).through !== undefined;
        },
        sessionOf: (handleId) => handleOf(handleId).session ?? Promise.resolve(undefined),
        setStatus: (handleId, status) => {
            const handle = handleOf(handleId);
            if (status.append !== undefined)
                handle.append = status.append;
        },
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
            const file = liveFile(handle);
            let bytes = file.bytes;
            let size = file.length;
            if (file.view !== undefined) {
                const seen = viewed(file);
                if (seen.bytes === undefined)
                    return undefined;
                bytes = seen.bytes;
                size = seen.bytes.byteLength;
            }
            const start = Math.min(offset ?? handle.position, size);
            const chunk = bytes.slice(start, Math.min(size, start + length));
            if (offset === null)
                handle.position = start + chunk.byteLength;
            return chunk;
        },
        write: (handleId, offset, bytes) => {
            const handle = handleOf(handleId);
            if (!handle.writable)
                throw fsError('EBADF', 'write', handle.path);
            // A cell no grant holds is logged at once (written): first, before anything
            // is decided (an inode descriptor's cell is made after), whether its bytes
            // fit what the log holds unanswered.
            const live = liveFile(handle);
            if (live.through === undefined && client.held(live.key) === undefined)
                client.fitsSync(bytes.byteLength, handle.path);
            const file = cellOf(handle);
            if (file === undefined)
                return undefined;
            if (file.through !== undefined) {
                // Through: by the file's number, ordered with everything else; an
                // O_APPEND write lands at the file's end as the session has it then.
                const { ino } = file.through;
                const by = handle.description === undefined ? {} : { description: handle.description };
                if (handle.append) {
                    acknowledged({ type: 'call', call: { call: 'append', path: file.key, ino, ...by, data: bytes.slice() } });
                    file.length += bytes.byteLength;
                    handle.position = file.length;
                }
                else {
                    const at = offset ?? handle.position;
                    acknowledged({ type: 'call', call: { call: 'write', path: file.key, ino, ...by, offset: at, data: bytes.slice() } });
                    file.length = Math.max(file.length, at + bytes.byteLength);
                    if (offset === null)
                        handle.position = at + bytes.byteLength;
                }
                throughLogged = ++changes;
                return bytes.byteLength;
            }
            const start = handle.append ? file.length : offset ?? handle.position;
            const end = start + bytes.byteLength;
            if (!room(file, end))
                throw fsError('ENOSPC', 'write', handle.path);
            const from = Math.min(start, file.length);
            if (start > file.length)
                file.bytes.fill(0, file.length, start);
            file.bytes.set(bytes, start);
            file.length = Math.max(file.length, end);
            if (offset === null || handle.append)
                handle.position = end;
            const entry = names.decided(file.key);
            if (entry)
                names.decide(file.key, { ...entry, size: file.length, mtime: now(), ctime: now() });
            written(file, from);
            return bytes.byteLength;
        },
        seek: (handleId, offset, whence) => {
            const handle = handleOf(handleId);
            const file = liveFile(handle);
            const position = (whence === 'set' ? 0 : whence === 'current' ? handle.position : file.view === undefined ? file.length : viewed(file).entry.size) + offset;
            if (position < 0)
                throw fsError('EINVAL', 'lseek', handle.path);
            handle.position = position;
            return position;
        },
        ftruncate: (handleId, size) => {
            const handle = handleOf(handleId);
            if (!handle.writable)
                throw fsError('EINVAL', 'ftruncate', handle.path);
            const file = cellOf(handle);
            if (file === undefined)
                return false;
            if (file.through !== undefined) {
                acknowledged({ type: 'call', call: { call: 'ftruncate', path: file.key, ino: file.through.ino, ...(handle.description === undefined ? {} : { description: handle.description }), size } });
                file.length = size;
                throughLogged = ++changes;
                return true;
            }
            if (!room(file, size))
                throw fsError('ENOSPC', 'ftruncate', handle.path);
            const from = Math.min(size, file.length);
            if (size > file.length)
                file.bytes.fill(0, file.length, size);
            file.length = size;
            const entry = names.decided(file.key);
            if (entry)
                names.decide(file.key, { ...entry, size, mtime: now(), ctime: now() });
            written(file, from);
            return true;
        },
        fstat: (handleId) => {
            const handle = handleOf(handleId);
            const file = liveFile(handle);
            // Opened by its number, no cell here: the store's, while a name leads to it.
            if (file.view !== undefined)
                return viewed(file).entry;
            // Through: its stat at the open, with its size as this process made it.
            if (file.through !== undefined)
                return { ...file.through.entry, size: file.length };
            // Its name gone: the description's own file, as it was then.
            if (file.detached !== undefined)
                return { ...file.detached, size: file.length };
            const entry = names.decided(file.key) ?? store.entry(file.key);
            if (!entry)
                throw fsError('EBADF', 'fstat', handle.path);
            return { ...entry, size: file.length };
        },
        close: (handleId) => {
            const handle = handleOf(handleId);
            handles.delete(handleId);
            // A file that lost its name gives back what its cell took with its last descriptor.
            if (handle.file.detached !== undefined && !isOpen(handle.file))
                unreserve(handle.file);
            // The session's description closes with its last descriptor here (a dup shares it), in the log's order.
            if (handle.description === undefined)
                return;
            for (const other of handles.values())
                if (other === handle)
                    return;
            acknowledged({ type: 'call', call: { call: 'close', path: handle.file.key, description: handle.description } });
            throughLogged = ++changes;
        },
        keyOf: (handleId) => liveFile(handleOf(handleId)).key,
        dup: (handleId) => {
            const handle = handleOf(handleId);
            const id = nextHandle--;
            handles.set(id, handle);
            return { id, path: handle.path };
        },
        reopen: (handleId, flags) => {
            const handle = handleOf(handleId);
            const file = liveFile(handle);
            if (file.through !== undefined || flags.append)
                return undefined;
            const entry = file.view !== undefined ? viewed(file).entry : file.detached ?? names.decided(file.key) ?? store.entry(file.key);
            if (!entry)
                throw fsError('EBADF', 'open', handle.path);
            if (flags.create && flags.exclusive)
                throw fsError('EEXIST', 'open', handle.path);
            if (!modeAllows(entry, (flags.read ? 4 : 0) | (flags.write || flags.truncate ? 2 : 0), store.cred))
                throw fsError('EACCES', 'open', handle.path);
            const id = nextHandle--;
            handles.set(id, { file: handle.file, ...(handle.inode === undefined ? {} : { inode: handle.inode }), readable: !!flags.read, writable: !!flags.write, append: false, position: 0, path: handle.path });
            if (flags.truncate)
                holder.ftruncate(id, 0);
            return {
                id, path: handle.path, position: 0, closed: false,
                flags: { read: !!flags.read, write: !!flags.write, append: false, create: !!flags.create, exclusive: !!flags.exclusive, directory: false, truncate: !!flags.truncate, followSymlinks: true },
            };
        },
        mkdir: (key, path, mode, mask) => {
            if ((mode & 0o7000) !== 0)
                return false;
            const current = entryOf(key);
            if (current === undefined)
                return false;
            const grant = deciding(key);
            if (grant === undefined)
                return false;
            if (current !== null)
                throw fsError('EEXIST', 'mkdir', path);
            const parent = writableParent(key, path, 'mkdir');
            if (parent === undefined)
                return false;
            const ino = numberFor(grant);
            if (ino === undefined)
                return false;
            const { uid, gid, setgid } = ownership(parent);
            const stamp = now();
            const umask = mask ?? umaskOf(grant);
            const perm = (mode & 0o777 & ~umask) | (setgid ? 0o2000 : 0);
            names.decide(key, {
                type: 'directory', dev: store.device, ino, nlink: 2, size: 0, atime: stamp, mtime: stamp, ctime: stamp,
                mode: 0o40000 | perm, uid, gid, revision: 0, target: null,
            });
            names.note(parentKey(key), nameOf(key), 'directory');
            names.madeDirectory(key);
            log({ type: 'call', call: { call: 'mkdir', path: key, mode: mode & 0o777, ...(grant === PROVISIONAL ? {} : { ino }), umask } });
            return true;
        },
        unlink: (key, path) => {
            const current = entryOf(key);
            if (current === null && options.provisional?.() === true)
                throw fsError('ENOENT', 'unlink', path);
            if (current === undefined || current === null || current.type === 'directory')
                return false;
            if (deciding(key) === undefined)
                return false;
            if (writableParent(key, path, 'unlink') === undefined)
                return false;
            names.decide(key, null);
            names.note(parentKey(key), nameOf(key), null);
            const found = files.get(current.ino);
            const local = found !== undefined && found.key === key ? found : undefined;
            // Its bytes go with it: nothing of them is logged, now or through a
            // description still open on it.
            if (local !== undefined) {
                files.delete(current.ino);
                detach(local, current);
            }
            orphan(current, local);
            if (local !== undefined) {
                if (!isOpen(local))
                    unreserve(local);
                // Made here and never logged: the session never had the name.
                if (local.made !== undefined)
                    return true;
            }
            log({ type: 'call', call: { call: 'unlink', path: key } });
            return true;
        },
        rmdir: (key, path) => {
            if (options.provisional?.() !== true)
                return false;
            const current = entryOf(key);
            if (current === undefined)
                return false;
            if (current === null)
                throw fsError('ENOENT', 'rmdir', path);
            if (current.type !== 'directory')
                throw fsError('ENOTDIR', 'rmdir', path);
            const listed = holder.children(key, store.children(key));
            if (listed === undefined)
                return false;
            if (listed.length > 0)
                throw fsError('ENOTEMPTY', 'rmdir', path);
            if (deciding(key) === undefined || writableParent(key, path, 'rmdir') === undefined)
                return false;
            names.decide(key, null);
            names.note(parentKey(key), nameOf(key), null);
            names.removedDirectory(key);
            log({ type: 'call', call: { call: 'rmdir', path: key } });
            return true;
        },
        symlink: (key, path, target) => {
            if (options.provisional?.() !== true)
                return false;
            const current = entryOf(key);
            if (current === undefined)
                return false;
            if (current !== null)
                throw fsError('EEXIST', 'symlink', path);
            if (deciding(key) === undefined)
                return false;
            const parent = writableParent(key, path, 'symlink');
            if (parent === undefined)
                return false;
            const { uid, gid } = ownership(parent);
            const stamp = now();
            // Numbered here until the view has the session's (a symlink's op carries no number).
            names.decide(key, {
                type: 'symlink', dev: store.device, ino: nextLocalIno++, nlink: 1, size: new TextEncoder().encode(target).byteLength,
                atime: stamp, mtime: stamp, ctime: stamp, mode: 0o120777, uid, gid, revision: 0, target,
            });
            names.note(parentKey(key), nameOf(key), 'symlink');
            log({ type: 'call', call: { call: 'symlink', path: key, target } });
            return true;
        },
        rename: (from, to, path) => {
            const source = entryOf(from);
            const target = entryOf(to);
            if (source === null && options.provisional?.() === true)
                throw fsError('ENOENT', 'rename', path);
            if (source === undefined || source === null || target === undefined)
                return false;
            if (source.type === 'directory' && (target !== null || within(to, from)))
                return false;
            if (target !== null && (target.type === 'directory' || source.type === 'directory'))
                return false;
            const grant = deciding(from);
            if (grant === undefined || (client.held(to) ?? (grant === PROVISIONAL ? PROVISIONAL : undefined)) !== grant)
                return false;
            if (from === to)
                return true;
            if (writableParent(from, path, 'rename') === undefined || writableParent(to, path, 'rename') === undefined)
                return false;
            // What was written before the rename is logged under the name it had.
            drain();
            // What was decided under the source moves with it.
            names.move(from, to);
            names.decide(from, null);
            names.decide(to, { ...source, ctime: now() });
            names.note(parentKey(from), nameOf(from), null);
            names.note(parentKey(to), nameOf(to), source.type);
            // A file it replaces loses its name: its open descriptions keep its bytes.
            if (target !== null) {
                const found = files.get(target.ino);
                const replaced = found !== undefined && found.key === to ? found : undefined;
                if (replaced !== undefined) {
                    files.delete(target.ino);
                    detach(replaced, target);
                }
                orphan(target, replaced);
            }
            for (const file of files.values())
                if (within(file.key, from))
                    file.key = to + file.key.slice(from.length);
            // An inode descriptor's file is the one it opened, under its new name.
            for (const handle of handles.values()) {
                if (handle.file.view !== undefined && within(handle.file.key, from))
                    handle.file.key = to + handle.file.key.slice(from.length);
            }
            log({ type: 'rename', from, to });
            return true;
        },
        setattr: (key, attrs) => {
            const current = entryOf(key);
            if (current === null && options.provisional?.() === true)
                throw fsError('ENOENT', 'mode' in attrs ? 'chmod' : 'uid' in attrs ? 'chown' : 'utime', '/' + key);
            if (current === undefined || current === null)
                return false;
            const grant = deciding(key);
            if (grant === undefined)
                return false;
            if (grant === PROVISIONAL) {
                // Answered as this view judges it, the session's to refuse after (a
                // principal it confines): what the view refuses is refused now.
                const refused = 'mode' in attrs ? chmodRefusal(current, store.cred)
                    : 'uid' in attrs ? chownRefusal(current, kept(attrs.uid), kept(attrs.gid), store.cred)
                        : utimesRefusal(current, true, store.cred);
                if (refused !== null)
                    throw fsError(refused, 'mode' in attrs ? 'chmod' : 'uid' in attrs ? 'chown' : 'utime', '/' + key);
            }
            else {
                // Only the owner (or root) changes a mode, an owner or times here, as
                // chmod, chown and utimes allow it; anything else is the session's to judge.
                if (store.cred.uid !== 0 && store.cred.uid !== current.uid)
                    return false;
                if ('uid' in attrs && chownRefusal(current, kept(attrs.uid), kept(attrs.gid), store.cred) !== null)
                    return false;
                // A grant a confined principal may not make: the session's to judge.
                if ('mode' in attrs && confinedModeRefusal(current.mode, attrs.mode) !== null)
                    return false;
            }
            if ('mode' in attrs)
                throughAt([key]);
            const next = changedBy(current, attrs);
            names.decide(key, next);
            const local = files.get(current.ino);
            if (local !== undefined)
                local.mode = next.mode & 0o7777;
            log({ type: 'setattr', path: key, attrs: 'uid' in attrs ? { uid: next.uid, gid: next.gid } : attrs });
            return true;
        },
        fsetattr: (handleId, change) => {
            const file = liveFile(handleOf(handleId));
            if (file.through !== undefined)
                return false;
            const entry = file.detached ?? names.decided(file.key) ?? store.entry(file.key);
            if (entry === undefined || entry === null)
                return false;
            // Its times as it is decided (timeAt): now, explicit, or as they are.
            const at = now();
            const attrs = 'atime' in change ? { atime: timeAt(change.atime, entry.atime, at), mtime: timeAt(change.mtime, entry.mtime, at) } : change;
            if (file.detached === undefined)
                return holder.setattr(file.key, attrs);
            // Its name gone, the file is this process's alone: judged and changed
            // here, as the session judges a description, its confinement of the
            // principal too (judged confined once no grant there says).
            const confined = client.held(file.key)?.confined ?? true;
            const refused = 'mode' in attrs ? chmodRefusal(entry, store.cred) ?? (confined ? confinedModeRefusal(entry.mode, attrs.mode) : null)
                : 'uid' in attrs ? chownRefusal(entry, kept(attrs.uid), kept(attrs.gid), store.cred)
                    : utimesRefusal(entry, 'atime' in change && explicitTimes(change.atime, change.mtime), store.cred);
            if (refused !== null)
                throw fsError(refused, 'mode' in attrs ? 'fchmod' : 'uid' in attrs ? 'fchown' : 'futimes', '/' + file.key);
            file.detached = changedBy(entry, attrs);
            file.mode = file.detached.mode & 0o7777;
            return true;
        },
        undecided: (key) => { names.undecide(key); },
        restat: (handleId, stat) => {
            const through = handleOf(handleId).file.through;
            if (through !== undefined)
                through.entry = { ...stat, target: null };
        },
        holds: (key) => client.held(key) !== undefined,
        barrierBegun: () => names.barrierBegun(),
        retire: (begun) => names.retire(begun),
        pending: () => dirty.size > 0 || client.pending(),
        flush: async () => {
            drain();
            const covered = changes;
            await client.flush();
            sentSome(covered);
            failed();
        },
        send: async () => {
            drain();
            const covered = changes;
            await client.flush();
            sentSome(covered);
        },
        reportRecorded: () => failed(),
        throughPending: () => throughLogged > sentAt,
        changing: (keys) => throughAt(keys),
        settle: async () => {
            drain();
            const covered = changes;
            await client.settle();
            sentSome(covered);
        },
        stats: () => {
            const stats = client.stats();
            return { waves: stats.waves, ops: stats.ops, recalls: stats.recalls, grants: stats.grants, widened: stats.widened };
        },
    };
    return holder;
}
