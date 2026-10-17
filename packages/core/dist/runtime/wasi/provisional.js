/**
 * What a caller that cannot wait (ResidentFilesystem.synchronous) decides
 * where no subtree the process holds decides it (VFS-9 B stage 3, rev 5):
 * answered now from this process's view, logged as the operations it made,
 * and the session's to refuse.
 *
 * The log is the overlay. Every decision is a record in log order: a name
 * made, removed or moved, or an operation on an inode (write, append,
 * truncate, chmod, chown, utimes). What the process sees of a name or an
 * inode is its admitted baseline with its pending records folded over it
 * (inode-fold.ts). An answered record retires once a barrier begun after
 * its answer lands; a refused one leaves, and what it touched is folded
 * again from the baseline. A rename moves names, never records.
 *
 * One Inode per (dev, ino) this process has opened or changed here: every
 * descriptor's read, write, truncate, stat, seek, attribute change, reopen
 * and close goes through it. Its identity is checked against the row its
 * name leads to: a name that leads elsewhere leaves it what it retains, or
 * ESTALE, never another file's bytes or attributes. A descriptor that may
 * write is opened at the session as it was opened here, by a description of
 * its own, and writes by it.
 *
 * Every call plans what it will log and keep, judges all of it (refusals,
 * the client's synchronous cap on what it logs, the budget for what it
 * keeps), then commits: a refusal, or a call that cannot answer now, leaves
 * nothing. What is admitted is given back by the object that holds it.
 */
import { fsError } from '../beneath-walk.js';
import { chmodRefusal, chownRefusal, explicitTimes, modeAllows, utimesRefusal } from '../../vfs/posix-access.js';
import { copiedPermissions, copyfileMode } from '../../vfs/vfs.js';
import { applyOp, copyState, foldOps } from './inode-fold.js';
/** Where a provisional file's own numbers start: past any the session gives. */
const LOCAL_INOS = 2 ** 50;
/** What one record of a name or an inode costs the process's budget, besides the bytes it keeps. */
const RECORD_COST = 160;
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
/** A new open description's id: unguessable, so no other process's call names it. */
const descriptionId = () => crypto.randomUUID().replaceAll('-', '');
export function provisional(host) {
    const inodes = new Map();
    const descs = new Map();
    /** The overlay: the names the pending name records made, removed or moved, and the listings' changes, replayed over the view. */
    const layer = new Map();
    const added = new Map();
    const removed = new Map();
    const nameRecords = [];
    /** The inodes whose own content or attributes the process sees (a fold), by the name that reaches them. */
    const touched = new Map();
    let ids = 0;
    let barriers = 0;
    let localIno = LOCAL_INOS;
    let wasActive = false;
    /** Told the host when the process starts or stops seeing anything of its decisions here. */
    const activity = () => {
        const on = layer.size > 0 || touched.size > 0;
        if (on === wasActive)
            return;
        wasActive = on;
        host.active(on);
    };
    const identity = (dev, ino) => `${dev}:${ino}`;
    /** `bytes` of the budget, before anything is published: ENOSPC where it has no room. */
    const admit = (bytes, syscall, path) => {
        if (bytes > 0 && !host.reserve(bytes))
            throw fsError('ENOSPC', syscall, path);
    };
    /** The row a name leads to now, this process's own first. */
    const rowAt = (key) => {
        const own = provisionalEntry(key);
        return own !== undefined ? own : host.row(key);
    };
    /** An inode as this process sees it. */
    const entryOf = (inode) => {
        const s = inode.state;
        const row = inode.row;
        const nlink = inode.unnamed ? 0 : row.nlink;
        return s === null
            ? (nlink === row.nlink ? row : { ...row, nlink })
            : { ...row, size: s.size, mode: s.mode, uid: s.uid, gid: s.gid, atime: s.atime, mtime: s.mtime, ctime: s.ctime, nlink };
    };
    const provisionalEntry = (key) => {
        if (layer.size === 0 && touched.size === 0)
            return undefined;
        if (layer.has(key)) {
            const inode = layer.get(key);
            return inode === null ? null : entryOf(inode);
        }
        // A file whose content this process changed, while its name still leads to it in the view.
        const changed = touched.get(key);
        if (changed !== undefined) {
            const row = host.row(key);
            if (row && row.dev === changed.dev && row.ino === changed.ino)
                return entryOf(changed);
        }
        if (layer.size === 0)
            return undefined;
        // A directory made here has no names but the ones made in it.
        const dir = parentKey(key);
        const made = layer.get(dir);
        return made && made.local && !added.get(dir)?.has(nameOf(key)) ? null : undefined;
    };
    /** The one Inode of the file `row` (at `key`) names. */
    const inodeAt = (key, row) => {
        const id = identity(row.dev, row.ino);
        let inode = inodes.get(id);
        if (inode === undefined) {
            inode = { dev: row.dev, ino: row.ino, type: row.type, key, origin: key, row, base: null, state: null, records: [], answeredAt: 0, unnamed: false, local: false, descs: 0, reserved: 0 };
            inodes.set(id, inode);
        }
        return inode;
    };
    /**
     * Whether `inode` is still the file at its name: the row there names it
     * (or the view cannot say, and it was). One whose name leads elsewhere is
     * unnamed while it does: it serves what it retains, never another file's.
     */
    const named = (inode) => {
        const row = rowAt(inode.key);
        if (row === undefined)
            return !inode.unnamed;
        inode.unnamed = row === null || row.dev !== inode.dev || row.ino !== inode.ino;
        if (!inode.unnamed && inode.state === null && !inode.local)
            inode.row = row;
        return !inode.unnamed;
    };
    /** What an inode's first record takes as its baseline: its row, and its bytes where the view holds them (by the name the view has it at). */
    const baseline = (inode) => {
        const row = inode.row;
        const held = inode.type === 'file' ? host.content(inode.origin, row.revision) : undefined;
        const bytes = held !== undefined && held.byteLength === row.size ? held.slice() : null;
        return { bytes, size: row.size, mode: row.mode, uid: row.uid, gid: row.gid, atime: row.atime, mtime: row.mtime, ctime: row.ctime };
    };
    /** What `inode` keeps of the budget's bytes now: its baseline's and its fold's buffers. */
    const footprint = (inode) => (inode.base?.bytes?.byteLength ?? 0) + (inode.state?.bytes?.byteLength ?? 0);
    /** What `inode` will keep once `ops` more are folded into it (its baseline taken first, where it has none): judged before they are. */
    const projected = (inode, ops) => {
        const base = inode.base ?? baseline(inode);
        let capacity = inode.state === null ? (base.bytes === null ? 0 : base.size) : (inode.state.bytes?.byteLength ?? 0);
        const known = inode.state === null ? base.bytes !== null : inode.state.bytes !== null;
        let size = inode.state?.size ?? base.size;
        for (const op of ops) {
            const end = op.kind === 'write' ? op.offset + op.data.byteLength : op.kind === 'append' ? size + op.data.byteLength : op.kind === 'truncate' ? op.size : size;
            if (known && end > capacity)
                capacity = Math.max(end, capacity * 2, 4096);
            if (op.kind !== 'chmod' && op.kind !== 'chown' && op.kind !== 'utimes')
                size = op.kind === 'truncate' ? op.size : Math.max(size, end);
        }
        return (base.bytes?.byteLength ?? 0) + (known ? capacity : 0);
    };
    /** `inode`'s charge brought to what it keeps now: what it no longer keeps goes back (it was admitted as projected). */
    const trim = (inode) => {
        const keeps = footprint(inode) + inode.records.length * RECORD_COST;
        if (keeps < inode.reserved) {
            host.release(inode.reserved - keeps);
            inode.reserved = keeps;
        }
    };
    /** What `ops` on `inode` cost before they are made: admitted, its charge raised. */
    const admitOps = (inode, ops, syscall, path) => {
        const need = projected(inode, ops) + (inode.records.length + ops.length) * RECORD_COST - inode.reserved;
        admit(need, syscall, path);
        if (need > 0)
            inode.reserved += need;
    };
    /** Fold `op` into `inode` (its baseline taken first): its record, kept until it retires. */
    const fold = (inode, op) => {
        if (inode.base === null) {
            inode.base = baseline(inode);
            inode.state = copyState(inode.base);
        }
        touched.set(inode.key, inode);
        activity();
        const record = { id: ++ids, op, answered: false };
        inode.records.push(record);
        inode.state = applyOp(inode.state, op);
        return record;
    };
    /** `inode` has nothing pending, nothing open and no name here: it goes, and what it held goes back. */
    const release = (inode) => {
        if (inode.records.length > 0 || inode.descs > 0)
            return;
        for (const value of layer.values())
            if (value === inode)
                return;
        // What the process sees of a file it changed stays until the view has it (retire), but where no name leads to it.
        if (inode.state !== null && named(inode))
            return;
        if (touched.get(inode.key) === inode)
            touched.delete(inode.key);
        inode.base = null;
        inode.state = null;
        host.release(inode.reserved);
        inode.reserved = 0;
        inodes.delete(identity(inode.dev, inode.ino));
        activity();
    };
    /**
     * Log `op` acknowledged, after what a held subtree decided before it, its
     * fate to `settle`: refused only where the session never applied it (an
     * unknown fate counts as answered: only a fresh barrier retires it).
     */
    const logged = (op, settle) => {
        host.drain();
        const settled = (refused, answer) => {
            settle(refused, answer);
            host.sent();
        };
        void host.client.submit(op, { acknowledged: true }).then((answer) => settled(answer.failed?.refused === true, answer), () => settled(false, undefined));
    };
    /** `records` of `inode` met their op's fate: a refused one leaves and the rest fold again from the baseline; an answered one is stamped. */
    const settleRecords = (inode, records, refused) => {
        let changed = false;
        for (const record of records) {
            const at = inode.records.indexOf(record);
            if (at < 0)
                continue;
            if (refused) {
                inode.records.splice(at, 1);
                changed = true;
            }
            else {
                record.answered = true;
                inode.answeredAt = barriers;
            }
        }
        if (changed)
            inode.state = foldOps(inode.base, inode.records.map((pending) => pending.op));
        // What is answered with nothing pending before it is the baseline's now: a later refusal folds from there.
        while (inode.records.length > 0 && inode.records[0].answered)
            inode.base = applyOp(inode.base, inode.records.shift().op);
        trim(inode);
    };
    /** Log the op that made `records` of `inode`, its fate theirs. */
    const loggedOn = (inode, records, op) => {
        logged(op, (refused) => settleRecords(inode, records, refused));
    };
    /** The overlay rebuilt: every name record still pending replayed over the view, in log order. */
    const replay = () => {
        for (const inode of inodes.values())
            inode.key = inode.origin;
        layer.clear();
        added.clear();
        removed.clear();
        for (const record of nameRecords)
            record.replay();
        touched.clear();
        for (const inode of inodes.values())
            if (inode.state !== null)
                touched.set(inode.key, inode);
        activity();
    };
    /**
     * Log a name record: replayed now, stamped by its answer, replayed away by
     * its refusal (`settled` told its fate too), and counted toward taking a
     * subtree at its names, as a change decided there is.
     */
    const loggedName = (op, keys, apply, settled, retired) => {
        const record = { id: ++ids, keys, replay: apply, ...(retired === undefined ? {} : { retired }), answered: false, answeredAt: 0 };
        nameRecords.push(record);
        apply();
        for (const key of keys)
            host.count(key);
        logged(op, (refused, answer) => {
            if (refused) {
                const at = nameRecords.indexOf(record);
                if (at >= 0)
                    nameRecords.splice(at, 1);
                host.release(RECORD_COST);
                replay();
            }
            else {
                record.answered = true;
                record.answeredAt = barriers;
            }
            settled?.(refused, answer);
        });
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
    /** `key` names `inode` from now on (null: nothing). */
    const place = (key, placed) => {
        let inode = placed;
        while (inode?.mergedInto !== undefined)
            inode = inode.mergedInto;
        layer.set(key, inode);
        note(parentKey(key), nameOf(key), inode === null ? null : inode.type);
        if (inode !== null) {
            if (touched.get(inode.key) === inode)
                touched.delete(inode.key);
            inode.key = key;
            inode.unnamed = false;
            if (inode.state !== null)
                touched.set(key, inode);
        }
        activity();
    };
    /** The parent of `key`, when the process may make a name in it: a known, writable, searchable directory of the session's filesystem. */
    const writableParent = (key, path, syscall) => {
        const parent = rowAt(parentKey(key));
        if (parent === undefined || parent === null || parent.dev !== host.device)
            return undefined;
        if (parent.type !== 'directory')
            throw fsError('ENOTDIR', syscall, path);
        if (!modeAllows(parent, 3, host.cred))
            throw fsError('EACCES', syscall, path);
        return parent;
    };
    const ownership = (parent) => {
        const setgid = (parent.mode & 0o2000) !== 0;
        return { uid: host.cred.uid, gid: setgid ? parent.gid : host.cred.gid, setgid };
    };
    /** A file, directory or link made here: numbered by this process until its creating open's answer numbers it (canonicalize). */
    const made = (key, type, mode, parent, target = null) => {
        const { uid, gid } = ownership(parent);
        const at = host.now();
        const row = {
            type, dev: host.device, ino: localIno++, nlink: type === 'directory' ? 2 : 1, size: target === null ? 0 : new TextEncoder().encode(target).byteLength,
            atime: at, mtime: at, ctime: at, mode, uid, gid, revision: 0, target,
        };
        const inode = { dev: row.dev, ino: row.ino, type, key, origin: key, row, base: null, state: null, records: [], answeredAt: 0, unnamed: false, local: true, descs: 0, reserved: RECORD_COST };
        if (type === 'file') {
            inode.base = { bytes: new Uint8Array(0), size: 0, mode, uid, gid, atime: at, mtime: at, ctime: at };
            inode.state = copyState(inode.base);
            touched.set(key, inode);
            activity();
        }
        inodes.set(identity(row.dev, row.ino), inode);
        return inode;
    };
    /**
     * The session numbered a file made here (its creating open's answer): it
     * is that inode from now on. Where this process already has an Inode for
     * it, the made one merges into it: its descriptors, its names, and its
     * records spliced in log order over that inode's baseline.
     */
    const canonicalize = (local, answer) => {
        const receipt = answer?.receipt;
        if (!local.local || receipt === undefined)
            return;
        const { dev, ino } = receipt;
        inodes.delete(identity(local.dev, local.ino));
        local.local = false;
        const known = inodes.get(identity(dev, ino));
        if (known === undefined) {
            local.dev = dev;
            local.ino = ino;
            local.row = { ...local.row, dev, ino };
            inodes.set(identity(dev, ino), local);
            return;
        }
        local.mergedInto = known;
        for (const desc of descs.values())
            if (desc.inode === local)
                desc.inode = known;
        known.descs += local.descs;
        for (const [key, value] of layer)
            if (value === local)
                layer.set(key, known);
        known.base ??= baseline(known);
        known.records = [...known.records, ...local.records].sort((a, b) => a.id - b.id);
        known.state = foldOps(known.base, known.records.map((record) => record.op));
        known.reserved += local.reserved;
        trim(known);
    };
    /** A new descriptor of `inode` with its own rights; `description` its open at the session where it may write. */
    const descriptor = (inode, path, flags, description) => {
        const id = host.nextHandle();
        const write = flags.write === true || flags.append === true;
        descs.set(id, { inode, read: flags.read === true || !write, write, append: flags.append === true, position: 0, path, ...(description === undefined ? {} : { description }) });
        inode.descs++;
        return { id, path };
    };
    const descOf = (handleId) => {
        const desc = descs.get(handleId);
        if (desc === undefined)
            throw fsError('EBADF', 'fd', String(handleId));
        return desc;
    };
    /** An inode's bytes now: its fold's, else the view's while its name leads to it. Undefined where none are held here; ESTALE where no name leads to it and it retains none. */
    const bytesOf = (inode, syscall, path) => {
        if (inode.state !== null) {
            if (inode.state.bytes === null) {
                // Its baseline's bytes not held when it took its first record: held now, the records fold over them.
                const held = !inode.unnamed && named(inode) ? host.content(inode.origin, inode.row.revision) : undefined;
                if (held === undefined || held.byteLength !== inode.row.size)
                    return undefined;
                inode.base = { ...inode.base, bytes: held.slice() };
                inode.state = foldOps(inode.base, inode.records.map((record) => record.op));
            }
            return { bytes: inode.state.bytes, size: inode.state.size };
        }
        if (!named(inode))
            throw fsError('ESTALE', syscall, path);
        const held = host.content(inode.origin, inode.row.revision);
        return held !== undefined && held.byteLength === inode.row.size ? { bytes: held, size: held.byteLength } : undefined;
    };
    /** What a descriptor's call names its file by: its description, else its number. */
    const by = (desc) => (desc.description !== undefined ? { description: desc.description } : { ino: desc.inode.ino });
    /**
     * A content operation by a descriptor, judged then made: its file still
     * its own (or retained), its logged bytes under the client's cap, what it
     * keeps admitted; then folded and logged as it was made.
     */
    const contentOp = (desc, op, call, logs, syscall) => {
        const inode = desc.inode;
        if (inode.state === null && !named(inode))
            throw fsError('ESTALE', syscall, desc.path);
        host.client.fitsSync(logs, desc.path);
        admitOps(inode, [op], syscall, desc.path);
        loggedOn(inode, [fold(inode, op)], call);
    };
    const judgeAttrs = (row, attrs, syscall, path) => {
        const refused = 'mode' in attrs ? chmodRefusal(row, host.cred)
            : 'uid' in attrs ? chownRefusal(row, attrs.uid, attrs.gid, host.cred)
                : utimesRefusal(row, explicitTimes(attrs.atime, attrs.mtime), host.cred);
        if (refused !== null)
            throw fsError(refused, syscall, path);
    };
    const attrOp = (attrs, at) => ('mode' in attrs ? { kind: 'chmod', mode: attrs.mode, at }
        : 'uid' in attrs ? { kind: 'chown', uid: attrs.uid, gid: attrs.gid, by: host.cred.uid, at }
            : { kind: 'utimes', atime: attrs.atime, mtime: attrs.mtime, at });
    /**
     * A file opened to write here, planned and judged whole: made (O_CREAT on
     * nothing) or emptied (O_TRUNC), its open logged as it was made with a
     * description of its own, then `bytes` written by it and, with `close`,
     * closed. `chmod`: the mode its open sets (a copy's keepMode).
     */
    const openToWrite = (key, path, flags, row, bytes, close, chmod) => {
        const read = flags.read === true;
        const umask = flags.umask ?? host.umask();
        const asked = (flags.mode ?? 0o666) & 0o777;
        // Judged whole first.
        let parent;
        if (row === null) {
            if (!flags.create)
                throw fsError('ENOENT', 'open', path);
            // Set-id and sticky bits asked at creation are the session's to grant or strip.
            if (((flags.mode ?? 0o666) & 0o7000) !== 0)
                return undefined;
            parent = writableParent(key, path, 'open');
            if (parent === undefined)
                return undefined;
        }
        else {
            if (row.type === 'directory')
                throw fsError('EISDIR', 'open', path);
            if (row.type !== 'file')
                return undefined;
            if (flags.create && flags.exclusive)
                throw fsError('EEXIST', 'open', path);
            if (!modeAllows(row, (read ? 4 : 0) | 2, host.cred))
                throw fsError('EACCES', 'open', path);
        }
        const at = host.now();
        const ops = [];
        // A made file's O_TRUNC changes nothing here, but is the session's if the name turns out to be another's file (canonicalize).
        if (flags.truncate)
            ops.push({ kind: 'truncate', size: 0, at });
        if (bytes !== null && bytes.byteLength > 0)
            ops.push({ kind: 'write', offset: 0, data: bytes, at });
        if (chmod !== undefined)
            ops.push({ kind: 'chmod', mode: chmod, at });
        host.client.fitsSync(bytes?.byteLength ?? 0, path);
        const inode = row === null ? null : inodeAt(key, row);
        const written = bytes !== null && bytes.byteLength > 0 ? Math.max(bytes.byteLength, 4096) : 0;
        if (inode !== null)
            admitOps(inode, ops, 'open', path);
        else
            admit(RECORD_COST * (2 + ops.length) + written, 'open', path);
        // Made.
        const description = descriptionId();
        const open = {
            type: 'call', call: {
                call: 'open', path: key, mode: row === null ? asked : row.mode & 0o7777,
                ...(row === null ? { umask, create: true } : {}),
                ...(flags.exclusive && row === null ? { exclusive: true } : {}),
                ...(flags.truncate ? { truncate: true } : {}),
                ...(flags.followSymlinks === false ? { nofollow: true } : {}),
                ...(read ? { read: true } : {}),
                ...(chmod === undefined ? {} : { fchmod: chmod }),
                description,
            },
        };
        let target;
        if (row === null) {
            target = made(key, 'file', 0o100000 | (asked & ~umask), parent);
            target.reserved += RECORD_COST * ops.length + written;
        }
        else {
            target = inode;
        }
        // The open's own effects (its truncate, its fchmod) are its records; its writes are theirs.
        const opened = ops.filter((op) => op.kind !== 'write').map((op) => fold(target, op));
        if (row === null) {
            loggedName(open, [key], () => place(key, target), (refused, answer) => {
                settleRecords(target, opened, refused);
                if (!refused)
                    canonicalize(target, answer);
            });
        }
        else {
            host.count(key);
            loggedOn(target, opened, open);
        }
        for (const op of ops) {
            if (op.kind !== 'write')
                continue;
            loggedOn(target, [fold(target, op)], { type: 'call', call: { call: 'write', path: key, description, offset: op.offset, data: op.data.slice() } });
        }
        const handle = descriptor(target, path, { ...flags, write: true }, description);
        descOf(handle.id).write = flags.write === true || flags.append === true || bytes !== null;
        if (close)
            provisional.close(handle.id);
        return handle;
    };
    const provisional = {
        owns: (handleId) => descs.size > 0 && descs.has(handleId),
        touches: (key) => (layer.size > 0 || touched.size > 0) && (layer.has(key) || layer.has(parentKey(key)) || touched.has(key)),
        setStatus: (handleId, status) => {
            const desc = descOf(handleId);
            if (status.append !== undefined)
                desc.append = status.append;
        },
        entry: provisionalEntry,
        children: (key, base) => {
            if (layer.size === 0)
                return base;
            const made = added.get(key);
            const gone = removed.get(key);
            if (made === undefined && gone === undefined)
                return base;
            const dir = layer.get(key);
            if (base === undefined && !(dir && dir.local))
                return undefined;
            const out = new Map();
            for (const child of base ?? [])
                if (!gone?.has(child.name))
                    out.set(child.name, child.type);
            for (const [name, type] of made ?? [])
                out.set(name, type);
            return [...out].map(([name, type]) => ({ name, type }));
        },
        open: (key, path, flags, row) => {
            const write = flags.write === true || flags.append === true;
            // One that makes or empties its file, or may write it, is opened at the session as here.
            if (write || flags.truncate || (row === null && flags.create)) {
                const handle = openToWrite(key, path, flags, row, null, false);
                if (handle !== undefined)
                    descOf(handle.id).write = write;
                return handle;
            }
            if (row === null)
                throw fsError('ENOENT', 'open', path);
            // Read-only: metadata only, nothing read and nothing logged.
            if (row.type === 'directory' || row.type !== 'file')
                return undefined;
            if (!modeAllows(row, 4, host.cred))
                throw fsError('EACCES', 'open', path);
            return descriptor(inodeAt(key, row), path, flags, undefined);
        },
        writeFile: (key, path, bytes, row, umask) => openToWrite(key, path, { write: true, create: true, truncate: true, mode: 0o666, ...(umask === undefined ? {} : { umask }) }, row, bytes, true) !== undefined,
        read: (handleId, offset, length) => {
            const desc = descOf(handleId);
            if (!desc.read)
                throw fsError('EBADF', 'read', desc.path);
            const held = bytesOf(desc.inode, 'read', desc.path);
            if (held === undefined)
                return undefined;
            const start = Math.min(offset ?? desc.position, held.size);
            const chunk = held.bytes.slice(start, Math.min(held.size, start + length));
            if (offset === null)
                desc.position = start + chunk.byteLength;
            return chunk;
        },
        write: (handleId, offset, bytes) => {
            const desc = descOf(handleId);
            if (!desc.write)
                throw fsError('EBADF', 'write', desc.path);
            const at = host.now();
            const data = bytes.slice();
            if (desc.append) {
                contentOp(desc, { kind: 'append', data, at }, { type: 'call', call: { call: 'append', path: desc.inode.key, ...by(desc), data: data.slice() } }, data.byteLength, 'write');
                desc.position = desc.inode.state.size;
            }
            else {
                const start = offset ?? desc.position;
                contentOp(desc, { kind: 'write', offset: start, data, at }, { type: 'call', call: { call: 'write', path: desc.inode.key, ...by(desc), offset: start, data: data.slice() } }, data.byteLength, 'write');
                if (offset === null)
                    desc.position = start + data.byteLength;
            }
            return bytes.byteLength;
        },
        ftruncate: (handleId, size) => {
            const desc = descOf(handleId);
            if (!desc.write)
                throw fsError('EINVAL', 'ftruncate', desc.path);
            contentOp(desc, { kind: 'truncate', size, at: host.now() }, { type: 'call', call: { call: 'ftruncate', path: desc.inode.key, ...by(desc), size } }, 0, 'ftruncate');
        },
        seek: (handleId, offset, whence) => {
            const desc = descOf(handleId);
            const position = (whence === 'set' ? 0 : whence === 'current' ? desc.position : entryOf(desc.inode).size) + offset;
            if (position < 0)
                throw fsError('EINVAL', 'lseek', desc.path);
            desc.position = position;
            return position;
        },
        fstat: (handleId) => {
            const desc = descOf(handleId);
            named(desc.inode);
            return entryOf(desc.inode);
        },
        fsetattr: (handleId, change) => {
            const desc = descOf(handleId);
            const inode = desc.inode;
            // An owner kept is null here, as fchown(2)'s -1.
            const attrs = ('uid' in change ? { uid: change.uid === -1 ? null : change.uid, gid: change.gid === -1 ? null : change.gid } : change);
            const syscall = 'mode' in attrs ? 'fchmod' : 'uid' in attrs ? 'fchown' : 'futimes';
            // The file it opened, by the name that still leads to it: no op reaches a file by a description, so one without a name is out of reach.
            if (!named(inode))
                throw fsError('ESTALE', syscall, desc.path);
            judgeAttrs(entryOf(inode), attrs, syscall, desc.path);
            const op = attrOp(attrs, host.now());
            admitOps(inode, [op], syscall, desc.path);
            host.count(inode.key);
            loggedOn(inode, [fold(inode, op)], { type: 'setattr', path: inode.key, attrs });
        },
        close: (handleId) => {
            const desc = descOf(handleId);
            descs.delete(handleId);
            for (const other of descs.values())
                if (other === desc)
                    return;
            desc.inode.descs--;
            if (desc.description !== undefined)
                logged({ type: 'call', call: { call: 'close', path: desc.inode.key, description: desc.description } }, () => { });
            release(desc.inode);
        },
        dup: (handleId) => {
            const desc = descOf(handleId);
            const id = host.nextHandle();
            descs.set(id, desc);
            return { id, path: desc.path };
        },
        reopen: (handleId, flags) => {
            const desc = descOf(handleId);
            const inode = desc.inode;
            if (flags.append)
                return undefined;
            if (flags.create && flags.exclusive)
                throw fsError('EEXIST', 'open', desc.path);
            if (inode.state === null && !named(inode))
                throw fsError('ESTALE', 'open', desc.path);
            const read = flags.read === true;
            const write = flags.write === true;
            if (!modeAllows(entryOf(inode), (read ? 4 : 0) | (write || flags.truncate ? 2 : 0), host.cred))
                throw fsError('EACCES', 'open', desc.path);
            // Its truncate, judged and made before the descriptor exists.
            let description;
            if (write || flags.truncate) {
                if (!named(inode))
                    throw fsError('ESTALE', 'open', desc.path);
                description = descriptionId();
                const open = { type: 'call', call: { call: 'open', path: inode.key, mode: entryOf(inode).mode & 0o7777, ...(flags.truncate ? { truncate: true } : {}), ...(read ? { read: true } : {}), description } };
                if (flags.truncate) {
                    const op = { kind: 'truncate', size: 0, at: host.now() };
                    admitOps(inode, [op], 'open', desc.path);
                    loggedOn(inode, [fold(inode, op)], open);
                }
                else {
                    logged(open, () => { });
                }
            }
            const handle = descriptor(inode, desc.path, { ...flags, read }, description);
            descOf(handle.id).write = write;
            return { ...handle, position: 0, closed: false, flags: { read, write, append: false, create: !!flags.create, exclusive: !!flags.exclusive, directory: false, truncate: !!flags.truncate, followSymlinks: true } };
        },
        inodeOf: (handleId) => {
            const desc = descs.get(handleId);
            if (desc === undefined || !named(desc.inode))
                return undefined;
            // The view's name and row: the bytes its records fold over.
            return { key: desc.inode.origin, entry: desc.inode.row };
        },
        keyOf: (handleId) => descOf(handleId).inode.key,
        mkdir: (key, path, mode, row, mask) => {
            if (row === undefined || (mode & 0o7000) !== 0)
                return false;
            if (row !== null)
                throw fsError('EEXIST', 'mkdir', path);
            const parent = writableParent(key, path, 'mkdir');
            if (parent === undefined)
                return false;
            const umask = mask ?? host.umask();
            const perm = (mode & 0o777 & ~umask) | (ownership(parent).setgid ? 0o2000 : 0);
            admit(RECORD_COST * 2, 'mkdir', path);
            const inode = made(key, 'directory', 0o40000 | perm, parent);
            loggedName({ type: 'call', call: { call: 'mkdir', path: key, mode: mode & 0o777, umask } }, [key], () => {
                place(key, inode);
                added.set(key, added.get(key) ?? new Map());
            });
            return true;
        },
        unlink: (key, path, row) => {
            if (row === undefined)
                return false;
            if (row === null)
                throw fsError('ENOENT', 'unlink', path);
            if (row.type === 'directory')
                return false;
            if (writableParent(key, path, 'unlink') === undefined)
                return false;
            // Its descriptors keep what it holds: its bytes, where only the view has them, admitted for their lifetime first.
            const inode = inodes.get(identity(row.dev, row.ino));
            const keeps = inode !== undefined && inode.descs > 0 && inode.base === null;
            const kept = keeps ? baseline(inode) : null;
            admit(RECORD_COST + (kept?.bytes?.byteLength ?? 0) * 2, 'unlink', path);
            if (kept !== null) {
                inode.base = kept;
                inode.state = copyState(kept);
                inode.reserved += footprint(inode);
            }
            loggedName({ type: 'call', call: { call: 'unlink', path: key } }, [key], () => place(key, null));
            return true;
        },
        rmdir: (key, path, row) => {
            if (row === undefined)
                return false;
            if (row === null)
                throw fsError('ENOENT', 'rmdir', path);
            if (row.type !== 'directory')
                throw fsError('ENOTDIR', 'rmdir', path);
            const listed = provisional.children(key, host.children(key));
            if (listed === undefined)
                return false;
            if (listed.length > 0)
                throw fsError('ENOTEMPTY', 'rmdir', path);
            if (writableParent(key, path, 'rmdir') === undefined)
                return false;
            admit(RECORD_COST, 'rmdir', path);
            loggedName({ type: 'call', call: { call: 'rmdir', path: key } }, [key], () => {
                place(key, null);
                added.delete(key);
                removed.delete(key);
            });
            return true;
        },
        symlink: (key, path, target, row) => {
            if (row === undefined)
                return false;
            if (row !== null)
                throw fsError('EEXIST', 'symlink', path);
            const parent = writableParent(key, path, 'symlink');
            if (parent === undefined)
                return false;
            admit(RECORD_COST * 2, 'symlink', path);
            const inode = made(key, 'symlink', 0o120777, parent, target);
            loggedName({ type: 'call', call: { call: 'symlink', path: key, target } }, [key], () => place(key, inode));
            return true;
        },
        rename: (from, to, path, source, target) => {
            if (source === undefined || target === undefined)
                return false;
            if (source === null)
                throw fsError('ENOENT', 'rename', path);
            if (source.type === 'directory' && (target !== null || within(to, from)))
                return false;
            if (target !== null && (target.type === 'directory' || source.type === 'directory'))
                return false;
            if (from === to)
                return true;
            if (writableParent(from, path, 'rename') === undefined || writableParent(to, path, 'rename') === undefined)
                return false;
            // A file it replaces keeps, for its descriptors, what it holds: admitted first.
            const replaced = target === null ? undefined : inodes.get(identity(target.dev, target.ino));
            const keeps = replaced !== undefined && replaced.descs > 0 && replaced.base === null;
            const kept = keeps ? baseline(replaced) : null;
            admit(RECORD_COST * 2 + (kept?.bytes?.byteLength ?? 0) * 2, 'rename', path);
            if (kept !== null) {
                replaced.base = kept;
                replaced.state = copyState(kept);
                replaced.reserved += footprint(replaced);
            }
            const moving = layer.get(from) ?? inodeAt(from, source);
            moving.reserved += RECORD_COST;
            loggedName({ type: 'rename', from, to }, [from, to], () => {
                // What is beneath the source moves with it: names, never records.
                for (const [key, value] of [...layer]) {
                    if (key === from || !within(key, from))
                        continue;
                    layer.delete(key);
                    const moved = to + key.slice(from.length);
                    layer.set(moved, value);
                    if (value !== null)
                        value.key = moved;
                }
                for (const map of [added, removed]) {
                    for (const [key, value] of [...map])
                        if (within(key, from)) {
                            map.delete(key);
                            map.set(to + key.slice(from.length), value);
                        }
                }
                place(from, null);
                place(to, moving);
            }, undefined, () => {
                // The view has it moved: what was beneath the source starts beneath the destination.
                for (const inode of inodes.values())
                    if (within(inode.origin, from))
                        inode.origin = to + inode.origin.slice(from.length);
            });
            return true;
        },
        setattr: (key, path, attrs, row) => {
            if (row === undefined)
                return false;
            const syscall = 'mode' in attrs ? 'chmod' : 'uid' in attrs ? 'chown' : 'utime';
            if (row === null)
                throw fsError('ENOENT', syscall, path);
            judgeAttrs(row, attrs, syscall, path);
            const inode = layer.get(key) ?? inodeAt(key, row);
            const op = attrOp(attrs, host.now());
            admitOps(inode, [op], syscall, path);
            host.count(key);
            loggedOn(inode, [fold(inode, op)], { type: 'setattr', path: key, attrs });
            return true;
        },
        copyFile: (to, path, source, bytes, target, keepMode) => {
            // The source as the session's copy reads it: a file it may read, no set-id bit (the session's to judge).
            if (source.type !== 'file' || (source.mode & 0o7000) !== 0 || !modeAllows(source, 4, host.cred))
                return false;
            if (target !== null && target.type !== 'file')
                return false;
            const own = inodes.get(identity(source.dev, source.ino));
            const held = own === undefined ? undefined : bytesOf(own, 'copyfile', path);
            const data = held !== undefined ? held.bytes.slice(0, held.size) : bytes;
            if (data === undefined)
                return false;
            const umask = host.umask();
            const asked = copiedPermissions(source.mode, false);
            const opened = target === null ? asked & ~umask : target.mode & 0o7777;
            const mode = keepMode ? copyfileMode(source.mode, data.byteLength, host.cred.uid) : opened;
            return openToWrite(to, path, { write: true, create: true, truncate: true, mode: asked, umask }, target, data, true, keepMode ? mode : undefined) !== undefined;
        },
        content: (entry) => {
            if (touched.size === 0)
                return undefined;
            const inode = inodes.get(identity(entry.dev, entry.ino));
            if (inode === undefined || inode.state === null || inode.state.bytes === null)
                return undefined;
            return inode.state.bytes.slice(0, inode.state.size);
        },
        barrierBegun: () => ++barriers,
        retire: (begun) => {
            // A name record answered before the barrier began is the view's now; one under a held subtree waits for it to be given back.
            const kept = nameRecords.filter((record) => {
                if (!record.answered || record.answeredAt >= begun)
                    return true;
                record.retired?.();
                host.release(RECORD_COST);
                return false;
            });
            if (kept.length < nameRecords.length) {
                nameRecords.splice(0, nameRecords.length, ...kept);
                replay();
            }
            for (const inode of [...inodes.values()]) {
                // Rebased: its records all answered before the barrier began, it is the view's again (unnamed, it keeps what it holds).
                if (inode.records.length > 0 || inode.answeredAt >= begun || host.held(inode.key))
                    continue;
                if (inode.unnamed && inode.descs > 0)
                    continue;
                if (inode.state !== null && !inode.local) {
                    inode.base = null;
                    inode.state = null;
                    if (touched.get(inode.key) === inode)
                        touched.delete(inode.key);
                    trim(inode);
                }
                release(inode);
            }
            activity();
        },
    };
    return provisional;
}
