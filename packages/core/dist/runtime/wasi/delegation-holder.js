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
import { provisional as provisionalDecisions } from './provisional.js';
import { owned } from './inode-fold.js';
import { LINGER_MS, processFsClient } from '../../_shared/process-fs-client.js';
/** Descriptors this holder opens are numbered below every session descriptor. */
const FIRST_LOCAL_HANDLE = -1;
/** A file made or rewritten here: its bytes until they are sent. */
/** An attribute change by a descriptor: a mode, an owner (null or -1 kept), or times (FsTime). */
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
        // A cell goes with its name, but for bytes still unlogged or open.
        forgot: (key, entry) => {
            const inode = entry ? prov.inode(entry.dev, entry.ino) : undefined;
            if (inode?.cell === undefined || inode.key !== key || dirty.has(inode) || inode.descs > 0)
                return;
            prov.dropCell(inode);
        },
    });
    /** What it decided by name (OwnNames.decided). */
    const { decided } = names;
    let nextHandle = FIRST_LOCAL_HANDLE;
    /** Files written since their bytes were last logged, in the order last written. */
    const dirty = new Set();
    // Changes logged, numbered; and the last a completed send covered: a send covers only what was logged when it began.
    let changes = 0;
    let sentAt = 0;
    /** Log `op`, the process told it succeeded. */
    const acknowledged = (op) => client.submit(op, { acknowledged: true });
    /**
     * The grant of a subtree the process holds at `key`, which decides a
     * change there, counted toward taking one either way; undefined where none
     * does, or where a provisional decision of the process's on the name is
     * not yet the view's (provisional.ts decides there until it is). A caller
     * that cannot wait counts nothing here: its change is counted where it is
     * made (Provisional), never for one it cannot make now.
     */
    const deciding = (key) => {
        if (options.cannotWait?.() === true && client.held(key) === undefined)
            return undefined;
        const grant = client.holder(key);
        return grant === undefined || (provisionalActive && prov.touches(key)) ? undefined : grant;
    };
    /** Whether the process sees anything of its provisional decisions (ProvisionalHost.active). */
    let provisionalActive = false;
    /**
     * No grant decides `inode` from now on (its grant is shared, recalled or
     * gone, or the process is about to change a name or an access above it):
     * what it decided was logged; each open description of it is opened at
     * the session, in the log's order, with the access it was opened with,
     * its file's anchor (Provisional.unhold); its bytes are its content here.
     * `made`: the file is not made at the session yet, and its mode refuses
     * what its descriptions do (creat(2) of 0444): its first description's
     * open makes it (create, exclusive, its number), which keeps that access
     * as creat(2) does, and its bytes are written through that description.
     * A file that lost its name stays its descriptions' alone: nothing of it
     * is the session's.
     */
    const unhold = (inode, made) => {
        const cell = inode.cell;
        if (cell === undefined || cell.detached !== undefined)
            return;
        dirty.delete(inode);
        delete cell.logged;
        // A made file's cell keeps the mode its open asked, its umask beside it, until a chmod here decides it.
        const mode = cell.umask === undefined ? cell.mode : cell.mode & ~cell.umask;
        const entry = decided.get(inode.key) ?? store.entry(inode.key) ?? {
            type: 'file', dev: store.device, ino: inode.ino, nlink: 1, size: cell.length, atime: now(), mtime: now(), ctime: now(),
            mode: 0o100000 | mode, uid: store.cred.uid, gid: store.cred.gid, revision: 0, target: null,
        };
        // Each that may write: one opened only to read reads the content here, and needs none.
        const opened = prov.descriptorsOf(inode).filter((desc) => desc.description === undefined && desc.write);
        opened.forEach((desc, at) => {
            const description = desc.description = descriptionId();
            // The first makes the file when it is not made yet: the creating open, and the bytes written through it.
            const creating = made !== undefined && at === 0;
            const making = creating ? { create: true, exclusive: true, ino: made, ...(cell.umask === undefined ? {} : { umask: cell.umask }) } : {};
            const read = desc.read;
            void acknowledged({ type: 'call', call: { call: 'open', path: inode.key, mode: cell.mode, ...making, access: read ? 'readwrite' : 'write', description } })
                .then((answered) => prov.anchored(description, answered.receipt?.handle, read), () => { });
            if (creating && cell.length > 0) {
                acknowledged({ type: 'call', call: { call: 'write', path: inode.key, ino: made, description, offset: 0, data: owned(cell.bytes, cell.length) } });
            }
        });
        prov.unhold(inode, { ...entry, dev: inode.dev, ino: inode.ino, mode: (entry.mode & ~0o7777) | mode });
    };
    /** What is decided here, else what the view has, at `inode`'s name while that name leads to the file. */
    const atName = (inode) => {
        const entry = decided.get(inode.key) ?? store.entry(inode.key);
        return entry && entry.ino === inode.ino ? entry : undefined;
    };
    /** `inode`'s decided row, while its name leads to it, at `size` and changed now. */
    const resized = (inode, size) => {
        const entry = decided.get(inode.key);
        if (!entry || entry.ino !== inode.ino)
            return;
        // The decided row is the holder's own object: changed where it is, not copied per write.
        const at = now();
        entry.size = size;
        entry.mtime = at;
        entry.ctime = at;
        names.rewritten(inode.key);
    };
    /** Whether `inode`'s mode, as decided here, refuses one of its open descriptions what it was opened to do: only its creating open could have. */
    const refusedByMode = (inode) => {
        const entry = decided.get(inode.key);
        if (entry === undefined || entry === null || entry.ino !== inode.ino)
            return false;
        for (const desc of prov.descriptorsOf(inode)) {
            if (!modeAllows(entry, (desc.read ? 4 : 0) | (desc.write ? 2 : 0), store.cred))
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
        const open = prov.cells().filter((inode) => inode.cell.detached === undefined && inode.descs > 0
            && (keys === undefined || keys.some((key) => within(inode.key, key))));
        if (open.length === 0)
            return;
        drain();
        for (const inode of open)
            unhold(inode);
    };
    /**
     * Log each file's latest bytes, in the order last written, under the name
     * it has now: whole, or where the log holds what it was up to an offset,
     * from there (cut to its length first, where it shrank). `except`: one
     * whose bytes go unlogged with it (a file being unlinked). Every decision
     * drains first, before it decides anything: one the client refuses
     * (ENOMEM) decides nothing.
     */
    const drain = (except) => {
        if (dirty.size === 0)
            return;
        changes++;
        for (const inode of [...dirty]) {
            if (inode === except)
                continue;
            const file = inode.cell;
            const from = Math.min(file.changedFrom ?? 0, file.logged ?? 0);
            // A copy: the file's buffer keeps changing as the process writes. A
            // file made here makes its name with this write, with its number.
            const ino = file.made;
            // Its mode refuses its creating open what it writes: made by that open, and written through it.
            if (ino !== undefined && refusedByMode(inode)) {
                dirty.delete(inode);
                delete file.changedFrom;
                delete file.made;
                unhold(inode, ino);
                continue;
            }
            if (ino === undefined && from > 0) {
                if (file.length < file.logged)
                    acknowledged({ type: 'call', call: { call: 'ftruncate', path: inode.key, size: file.length } });
                if (file.length > from)
                    acknowledged({ type: 'call', call: { call: 'write', path: inode.key, offset: from, data: file.bytes.slice(from, file.length) } });
            }
            else {
                acknowledged({ type: 'call', call: { call: 'writeFile', path: inode.key, mode: file.mode, ...(ino === undefined ? {} : { ino }), ...(file.umask === undefined ? {} : { umask: file.umask }), data: file.bytes.slice(0, file.length) } });
            }
            // Unlogged until the log took it: one that refused it (the session
            // ended the process) leaves it for the settle's (logHeld).
            dirty.delete(inode);
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
        for (const inode of prov.cells())
            if (within(inode.key, root))
                unhold(inode);
        names.released(root);
        prov.answeredHeld(root);
        options.sent?.();
    };
    const client = processFsClient({
        session: options.session,
        now,
        ...(options.timers === undefined ? {} : { timers: options.timers }),
        ...(options.umask === undefined ? {} : { umask: options.umask }),
        ...(options.isHomeRoot === undefined ? {} : { isHomeRoot: options.isHomeRoot }),
        ...(options.grantAfter === undefined ? {} : { grantAfter: options.grantAfter }),
        ...(options.grantInos === undefined ? {} : { grantInos: options.grantInos }),
        ...(options.journal === undefined ? {} : { journal: options.journal }),
        ...(options.logged === undefined ? {} : { logged: options.logged }),
        released: dropDecisions,
        // Closing starts (a recall, an idle or renewing give-back): nothing more
        // is decided under it, and its files' descriptions write through from now
        // on, so the flush that follows covers everything accepted before.
        freezing: (root) => {
            drain();
            for (const inode of prov.cells())
                if (within(inode.key, root))
                    unhold(inode);
        },
        drain,
    });
    /** A file's bytes a grant decides here (its cell). */
    const heldContent = (entry) => {
        const cell = prov.inode(entry.dev, entry.ino)?.cell;
        return cell === undefined ? undefined : cell.bytes.slice(0, cell.length);
    };
    const prov = provisionalDecisions({
        // The store's, as it knows it when asked (it learns it at its first barrier).
        get device() { return store.device; },
        get cred() { return store.cred; },
        row: (key) => entryOf(key),
        children: (key) => names.children(key, store.children(key)),
        content: (key, revision) => {
            const entry = decided.get(key);
            return (entry ? heldContent(entry) : undefined) ?? store.content?.(key, revision);
        },
        reserve: (bytes) => store.reserve?.(bytes) ?? true,
        release: (bytes) => store.release?.(bytes),
        client,
        drain,
        sent: () => options.sent?.(),
        // Reads by name and by number consult them only while the process sees any.
        active: (on) => { provisionalActive = on; },
        held: (key) => client.held(key) !== undefined,
        count: (key) => { client.holder(key); },
        umask: () => options.umask?.() ?? 0o022,
        now,
        nextHandle: () => nextHandle--,
        unhold: (inode) => {
            drain();
            unhold(inode);
        },
        generation: (key) => names.generation(key),
        settled: (key, generation) => names.settled(key, generation),
        ...(store.mounted === undefined ? {} : { mounted: (key) => store.mounted(key) }),
        ...(store.unreported === undefined ? {} : { unreported: (key) => store.unreported(key) }),
        ...(store.keep === undefined ? {} : { keep: (key, row, bytes) => store.keep(key, row.revision, bytes) }),
        absorb: (key, file) => {
            const decision = decided.get(key);
            if (!decision || decision.dev !== file.dev || decision.ino !== file.ino)
                return undefined;
            // In place: the decision it is, not a new one (its generation and what was given back of it stand).
            decision.size = file.size;
            decision.mode = file.mode;
            decision.uid = file.uid;
            decision.gid = file.gid;
            decision.atime = file.atime;
            decision.mtime = file.mtime;
            decision.ctime = file.ctime;
            return decision;
        },
    });
    // The provisional decisions are the newest wherever they are pending: a held subtree decides nothing there (deciding).
    const composedEntry = (key) => {
        const mine = prov.entry(key);
        return mine !== undefined ? mine : names.entry(key);
    };
    /** entryOf, with the provisional decisions' word first: the store asked once, for both. */
    const composedRow = (key) => {
        const row = entryOf(key);
        const mine = prov.entry(key, row);
        return mine !== undefined ? mine : row;
    };
    const composedChildren = (key, base) => prov.children(key, names.children(key, base));
    const composedContent = (entry) => prov.content(entry) ?? heldContent(entry);
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
    const written = (inode, from = 0) => {
        const file = inode.cell;
        if (file.detached)
            return;
        file.changedFrom = Math.min(file.changedFrom ?? from, from);
        dirty.delete(inode);
        dirty.add(inode);
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
    /** `inode` lost its name (it was `entry`): what is written through its open descriptions stays theirs. */
    const detach = (inode, entry) => {
        const file = inode.cell;
        file.detached = { ...entry, nlink: 0, size: file.length };
        delete file.logged;
        dirty.delete(inode);
    };
    /** Descriptor `handleId` where its file's grant decides it (its cell), else undefined: the provisional decisions' to answer. */
    /** What a descriptor of a grant's file stats: its file at its name, at its cell's size; one whose name went, as it was then. */
    const heldEntry = (handle) => {
        const file = handle.inode.cell;
        if (file.detached !== undefined)
            return { ...file.detached, size: file.length };
        const entry = atName(handle.inode);
        if (!entry)
            throw fsError('EBADF', 'fstat', handle.path);
        return { ...entry, size: file.length };
    };
    const heldDesc = (handleId) => {
        const desc = prov.descriptor(handleId);
        if (desc === undefined)
            throw fsError('EBADF', 'fd', String(handleId));
        return desc.inode.cell === undefined ? undefined : desc;
    };
    /**
     * Room for `length` bytes of `file`: drawn from the storage its subtree's
     * grant reserved while one holds it. A file whose grant is being given back
     * (renewed, idle) or is gone grows as any write does: the session judges
     * its bytes when they reach it (a refusal then is the flush's error).
     */
    const room = (file, key, length) => {
        if (length <= file.bytes.byteLength)
            return true;
        const grant = client.held(key);
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
    /** An owner or group id a chown keeps (null, or -1 as fchown(2) spells it): null, as chownRefusal takes it. */
    /** `entry` as chmod, chown (the set-id bits chownedMode clears) and utimes leave it, its ctime now. */
    const changedBy = (entry, attrs) => ('mode' in attrs ? { ...entry, mode: (entry.mode & ~0o7777) | (attrs.mode & 0o7777), ctime: now() }
        : 'uid' in attrs ? { ...entry, uid: attrs.uid ?? entry.uid, gid: attrs.gid ?? entry.gid, mode: chownedMode(entry.mode, store.cred), ctime: now() }
            : { ...entry, atime: timeAt(attrs.atime, entry.atime, now()), mtime: timeAt(attrs.mtime, entry.mtime, now()), ctime: now() });
    const holder = {
        client,
        provisional: prov,
        // Composed with the provisional decisions while the process sees any (ProvisionalHost.active).
        entry: (key) => (provisionalActive ? composedEntry(key) : names.entry(key)),
        row: (key) => (provisionalActive ? composedRow(key) : entryOf(key)),
        children: (key, base) => (provisionalActive ? composedChildren(key, base) : names.children(key, base)),
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
            if (grant === undefined || client.held(from) === undefined)
                return false;
            const bytes = holder.content(source) ?? stored;
            if (bytes === undefined)
                return false;
            const known = target === null ? undefined : prov.inode(target.dev, target.ino);
            // Another's file there, or one this process holds open or changes outside a grant, is the session's to copy over.
            if (target !== null && ((store.cred.uid !== 0 && target.uid !== store.cred.uid) || (known !== undefined && (known.descs > 0 || known.cell === undefined))))
                return false;
            const umask = grant.umask;
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
                made = client.number(grant);
                if (made === undefined)
                    return false;
                const { uid, gid } = ownership(parent);
                const stamp = now();
                entry = { type: 'file', dev: store.device, ino: made, nlink: 1, size: bytes.byteLength, atime: stamp, mtime: stamp, ctime: stamp, mode: 0o100000 | mode, uid, gid, revision: 0, target: null };
            }
            else {
                if (!modeAllows(target, 2, store.cred))
                    throw fsError('EACCES', 'copyfile', path);
                entry = { ...target, size: bytes.byteLength, mode: (target.mode & ~0o7777) | mode, mtime: now(), ctime: now() };
            }
            // Its Inode: the file's, or one made for it where the budget has room; else the session copies.
            const inode = known ?? prov.inodeFor(to, { ...entry });
            if (inode === undefined)
                return false;
            // After everything decided before it, the destination's own bytes among them.
            drain();
            // Held here as an emptied file's written bytes are: in its cell (an
            // O_TRUNC open keeps it), what more they take drawn from what the
            // grant reserved (room); else the session copies.
            const file = inode.cell ?? { bytes: new Uint8Array(0), length: 0, mode };
            if (!room(file, to, bytes.byteLength)) {
                if (inode.cell === undefined)
                    prov.dropCell(inode);
                return false;
            }
            file.bytes.set(bytes);
            file.length = bytes.byteLength;
            file.logged = bytes.byteLength;
            file.mode = mode;
            if (target === null)
                names.note(parentKey(to), nameOf(to), 'file');
            names.decide(to, entry);
            prov.hold(inode, file);
            const description = descriptionId();
            changes++;
            acknowledged({ type: 'call', call: { call: 'open', path: to, mode: asked, access: 'write', ...(made === undefined ? {} : { ino: made, umask }), create: true, truncate: true, ...(keepMode ? { fchmod: mode } : {}), description } });
            acknowledged({ type: 'call', call: { call: 'write', path: to, ...(made === undefined ? {} : { ino: made }), description, offset: 0, data: bytes.slice() } });
            acknowledged({ type: 'call', call: { call: 'close', path: to, description } });
            return true;
        },
        logHeld: () => {
            client.seal();
            drain();
        },
        content: (entry) => (provisionalActive ? composedContent(entry) : heldContent(entry)),
        owns: (handleId) => prov.owns(handleId),
        open: (key, path, flags, initial = 0) => {
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
            let inode;
            if (current === null) {
                const parent = writableParent(key, path, 'open');
                if (parent === undefined)
                    return undefined;
                const ino = client.number(grant);
                if (ino === undefined)
                    return undefined;
                const asked = (flags.mode ?? 0o666) & 0o777;
                const umask = flags.umask ?? grant.umask;
                const { uid, gid } = ownership(parent);
                const stamp = now();
                const entry = {
                    type: 'file', dev: store.device, ino, nlink: 1, size: 0, atime: stamp, mtime: stamp, ctime: stamp,
                    mode: 0o100000 | (asked & ~umask), uid, gid, revision: 0, target: null,
                };
                drain();
                // Its mode was decided under this umask: the session applies the same one, and its number.
                const file = { bytes: new Uint8Array(0), length: 0, mode: asked, made: ino, umask };
                // Room for what it is opened to be written with, before anything is decided (its number unused if not).
                if (initial > 0 && !room(file, key, initial))
                    return undefined;
                inode = prov.inodeFor(key, { ...entry });
                if (inode === undefined)
                    return undefined;
                prov.hold(inode, file);
                names.decide(key, entry);
                names.note(parentKey(key), nameOf(key), 'file');
                // Made here: the name exists from now on, in the log's order. Logged
                // with its bytes, before the next decision (drain), as one call.
                written(inode);
            }
            else if (!flags.truncate) {
                // An existing file opened to write, not emptied (O_CREAT without
                // O_TRUNC): its bytes are kept, so only one whose bytes are here is
                // opened here; any other is the session's. Read permission too, when
                // it is opened to read.
                if (!modeAllows(current, flags.read ? 6 : 2, store.cred))
                    throw fsError('EACCES', 'open', path);
                inode = prov.inode(current.dev, current.ino);
                if (inode?.cell === undefined || inode.key !== key)
                    return undefined;
            }
            else {
                // An existing file emptied: decided here, its number the session's.
                if (!modeAllows(current, flags.read ? 6 : 2, store.cred))
                    throw fsError('EACCES', 'open', path);
                inode = prov.inode(current.dev, current.ino);
                // One the provisional decisions change is theirs to empty.
                if (inode !== undefined && inode.cell === undefined && (inode.state !== null || inode.records.length > 0))
                    return undefined;
                inode ??= prov.inodeFor(key, current);
                if (inode === undefined)
                    return undefined;
                const file = inode.cell ?? { bytes: new Uint8Array(0), length: 0, mode: current.mode & 0o7777 };
                if (initial > 0 && !room(file, key, initial)) {
                    if (inode.cell === undefined)
                        prov.dropCell(inode);
                    return undefined;
                }
                file.length = 0;
                prov.hold(inode, file);
                names.decide(key, { ...current, size: 0, mtime: now(), ctime: now() });
                written(inode);
            }
            return prov.heldDescriptor(inode, path, !!flags.read, false);
        },
        writeFile: (key, path, bytes, flags) => {
            // Its bytes' room drawn as it is opened: a write that cannot fail it.
            const handle = holder.open(key, path, flags, bytes.byteLength);
            if (handle === undefined)
                return undefined;
            holder.write(handle.id, 0, bytes);
            const held = heldDesc(handle.id);
            const revision = held === undefined ? undefined : heldEntry(held).revision;
            holder.close(handle.id);
            return revision;
        },
        setStatus: (handleId, status) => prov.setStatus(handleId, status),
        read: (handleId, offset, length) => {
            const handle = heldDesc(handleId);
            if (handle === undefined)
                return prov.read(handleId, offset, length);
            if (!handle.read)
                throw fsError('EBADF', 'read', handle.path);
            const file = handle.inode.cell;
            const start = Math.min(offset ?? handle.position, file.length);
            const chunk = file.bytes.slice(start, Math.min(file.length, start + length));
            if (offset === null)
                handle.position = start + chunk.byteLength;
            return chunk;
        },
        write: (handleId, offset, bytes) => {
            const handle = heldDesc(handleId);
            if (handle === undefined)
                return prov.write(handleId, offset, bytes);
            if (!handle.write)
                throw fsError('EBADF', 'write', handle.path);
            const inode = handle.inode;
            const file = inode.cell;
            const start = handle.append ? file.length : offset ?? handle.position;
            const end = start + bytes.byteLength;
            if (!room(file, inode.key, end))
                throw fsError('ENOSPC', 'write', handle.path);
            const from = Math.min(start, file.length);
            if (start > file.length)
                file.bytes.fill(0, file.length, start);
            file.bytes.set(bytes, start);
            file.length = Math.max(file.length, end);
            if (offset === null || handle.append)
                handle.position = end;
            resized(inode, file.length);
            written(inode, from);
            return bytes.byteLength;
        },
        seek: (handleId, offset, whence) => {
            const handle = heldDesc(handleId);
            if (handle === undefined)
                return prov.seek(handleId, offset, whence);
            const position = (whence === 'set' ? 0 : whence === 'current' ? handle.position : handle.inode.cell.length) + offset;
            if (position < 0)
                throw fsError('EINVAL', 'lseek', handle.path);
            handle.position = position;
            return position;
        },
        ftruncate: (handleId, size) => {
            const handle = heldDesc(handleId);
            if (handle === undefined)
                return prov.ftruncate(handleId, size);
            if (!handle.write)
                throw fsError('EINVAL', 'ftruncate', handle.path);
            const inode = handle.inode;
            const file = inode.cell;
            if (!room(file, inode.key, size))
                throw fsError('ENOSPC', 'ftruncate', handle.path);
            const from = Math.min(size, file.length);
            if (size > file.length)
                file.bytes.fill(0, file.length, size);
            file.length = size;
            resized(inode, size);
            written(inode, from);
        },
        fstat: (handleId) => {
            const handle = heldDesc(handleId);
            return handle === undefined ? prov.fstat(handleId) : heldEntry(handle);
        },
        close: (handleId) => prov.close(handleId),
        keyOf: (handleId) => prov.keyOf(handleId),
        dup: (handleId) => prov.dup(handleId),
        reopen: (handleId, flags) => {
            const handle = heldDesc(handleId);
            if (handle === undefined)
                return prov.reopen(handleId, flags);
            const inode = handle.inode;
            const file = inode.cell;
            if (flags.append)
                return undefined;
            const entry = file.detached ?? atName(inode);
            if (!entry)
                throw fsError('EBADF', 'open', handle.path);
            if (flags.create && flags.exclusive)
                throw fsError('EEXIST', 'open', handle.path);
            if (!modeAllows(entry, (flags.read ? 4 : 0) | (flags.write || flags.truncate ? 2 : 0), store.cred))
                throw fsError('EACCES', 'open', handle.path);
            // Its truncate is made before the descriptor exists: one whose room is not there is the session's.
            if (flags.truncate && !room(file, inode.key, 0))
                return undefined;
            const opened = prov.heldDescriptor(inode, handle.path, !!flags.read, false);
            prov.descriptor(opened.id).write = !!flags.write;
            if (flags.truncate) {
                file.length = 0;
                resized(inode, 0);
                written(inode, 0);
            }
            return {
                id: opened.id, path: handle.path, position: 0, closed: false,
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
            const ino = client.number(grant);
            if (ino === undefined)
                return false;
            const { uid, gid, setgid } = ownership(parent);
            const stamp = now();
            const umask = mask ?? grant.umask;
            const perm = (mode & 0o777 & ~umask) | (setgid ? 0o2000 : 0);
            drain();
            names.decide(key, {
                type: 'directory', dev: store.device, ino, nlink: 2, size: 0, atime: stamp, mtime: stamp, ctime: stamp,
                mode: 0o40000 | perm, uid, gid, revision: 0, target: null,
            });
            names.note(parentKey(key), nameOf(key), 'directory');
            names.madeDirectory(key);
            log({ type: 'call', call: { call: 'mkdir', path: key, mode: mode & 0o777, ino, umask } });
            return true;
        },
        unlink: (key, path) => {
            const current = entryOf(key);
            if (current === undefined || current === null || current.type === 'directory')
                return false;
            if (deciding(key) === undefined)
                return false;
            if (writableParent(key, path, 'unlink') === undefined)
                return false;
            const local = prov.inode(current.dev, current.ino);
            drain(local?.cell !== undefined && local.key === key ? local : undefined);
            names.decide(key, null);
            names.note(parentKey(key), nameOf(key), null);
            if (local?.cell !== undefined && local.key === key) {
                const made = local.cell.made;
                // Its bytes go with it: nothing of them is logged, now or through a
                // description still open on it.
                detach(local, current);
                if (local.descs === 0)
                    prov.dropCell(local);
                // Made here and never logged: the session never had the name.
                if (made !== undefined)
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
            const grant = deciding(from);
            if (grant === undefined || deciding(to) !== grant)
                return false;
            if (from === to)
                return true;
            if (writableParent(from, path, 'rename') === undefined || writableParent(to, path, 'rename') === undefined)
                return false;
            // What the names of its files grow by, admitted before anything is done; not made, given back.
            const files = prov.planMove(from, to, path);
            try {
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
                    const replaced = prov.inode(target.dev, target.ino);
                    if (replaced?.cell !== undefined && replaced.key === to) {
                        detach(replaced, target);
                        if (replaced.descs === 0)
                            prov.dropCell(replaced);
                    }
                }
                // Its files move with it: the name they are reached by, which the view will have.
                files.commit();
            }
            finally {
                files.cancel();
            }
            log({ type: 'rename', from, to });
            return true;
        },
        setattr: (key, attrs) => {
            const current = entryOf(key);
            if (current === undefined || current === null)
                return false;
            if (deciding(key) === undefined)
                return false;
            // Only the owner (or root) changes a mode, an owner or times here, as
            // chmod, chown and utimes allow it; anything else is the session's to judge.
            if (store.cred.uid !== 0 && store.cred.uid !== current.uid)
                return false;
            if ('uid' in attrs && chownRefusal(current, attrs.uid, attrs.gid, store.cred) !== null)
                return false;
            // A grant a confined principal may not make: the session's to judge.
            if ('mode' in attrs && confinedModeRefusal(current.mode, attrs.mode) !== null)
                return false;
            if ('mode' in attrs) {
                throughAt([key]);
                if (provisionalActive && prov.touches(key))
                    return false;
            }
            drain();
            const next = changedBy(current, attrs);
            names.decide(key, next);
            const local = prov.inode(current.dev, current.ino)?.cell;
            if (local !== undefined) {
                local.mode = next.mode & 0o7777;
                delete local.umask;
            }
            log({ type: 'setattr', path: key, attrs: 'uid' in attrs ? { uid: next.uid, gid: next.gid } : attrs });
            return true;
        },
        fsetattr: (handleId, change) => {
            const handle = heldDesc(handleId);
            if (handle === undefined) {
                prov.fsetattr(handleId, change);
                return false;
            }
            const inode = handle.inode;
            const file = inode.cell;
            const entry = file.detached ?? atName(inode);
            // Its times as it is decided (timeAt): now, explicit, or as they are.
            const at = now();
            const attrs = entry && 'atime' in change ? { atime: timeAt(change.atime, entry.atime, at), mtime: timeAt(change.mtime, entry.mtime, at) } : change;
            if (file.detached === undefined) {
                // By its name where its grant decides it; else no grant decides the file from now on: the provisional decisions', through its description.
                if (entry && holder.setattr(inode.key, attrs))
                    return true;
                drain();
                unhold(inode);
                prov.fsetattr(handleId, change);
                return false;
            }
            // Its name gone, the file is this process's alone: judged and changed
            // here, as the session judges a description, its confinement of the
            // principal too (judged confined once no grant there says).
            const detached = file.detached;
            const confined = client.held(inode.key)?.confined ?? true;
            const refused = 'mode' in attrs ? chmodRefusal(detached, store.cred) ?? (confined ? confinedModeRefusal(detached.mode, attrs.mode) : null)
                : 'uid' in attrs ? chownRefusal(detached, attrs.uid, attrs.gid, store.cred)
                    : utimesRefusal(detached, 'atime' in change && explicitTimes(change.atime, change.mtime), store.cred);
            if (refused !== null)
                throw fsError(refused, 'mode' in attrs ? 'fchmod' : 'uid' in attrs ? 'fchown' : 'futimes', '/' + inode.key);
            file.detached = changedBy(detached, attrs);
            file.mode = file.detached.mode & 0o7777;
            return true;
        },
        undecided: (key) => { names.undecide(key); },
        superseded: (key) => { names.superseded(key); },
        holds: (key) => client.held(key) !== undefined,
        barrierBegun: () => {
            prov.barrierBegun();
            return names.barrierBegun();
        },
        retire: (begun) => {
            names.retire(begun);
            prov.retire(begun);
        },
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
