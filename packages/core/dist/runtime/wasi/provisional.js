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
import { chmodRefusal, chownRefusal, explicitTimes, modeAllows, stickyRefusal, utimesRefusal } from '../../vfs/posix-access.js';
import { refusesDirectory } from '../../vfs/open-rules.js';
import { copiedPermissions, copyfileMode } from '../../vfs/vfs.js';
import { applyOp, copyState, foldOps, isModeChange, isOwnerChange, isTimesChange, owned } from './inode-fold.js';
import { arrayBufferByteLength, arrayCopy, arrayIncludes, arrayIndexOf, arraySort, bytesView, dataDescriptor, Error, mapFind, mapKeyList, mapValueList, mathMax, mathMin, objectCreate, objectFreeze, objectKeys, ownValue, promiseThen, reflectDefineProperty, SafeList, SafeMap, SafeSet, setList, setOfList, stringLastIndexOf, stringOf, stringSlice, stringStartsWith, SymbolConstructor, typedArrayBuffer, typedArrayByteLength, typedArraySet, Uint8ArrayConstructor, } from '../../_shared/primordials.js';
/** Where a provisional file's own numbers start: past any the session gives. */
const LOCAL_INOS = 2 ** 50;
/** What one record of a name or an inode costs the process's budget, besides the bytes it keeps. */
const RECORD_COST = 160;
/** What an Inode object keeps beside its names, buffers and records. */
const INODE_COST = 320;
/** What a string keeps: two bytes a code unit. */
const stringCost = (text) => text.length * 2;
/** What a buffer keeps alive: all of what it is a view of. */
const retained = (bytes) => (bytes === null || bytes === undefined ? 0 : arrayBufferByteLength(typedArrayBuffer(bytes)));
/** The bytes an operation carries, which its record keeps until it retires. */
/** The session's revision right after an answered op, where its answer says (ProcessFsAnswer.mutation). */
const mutationAfter = (answer) => {
    const mutation = answer === undefined ? undefined : ownValue(answer, 'mutation');
    return mutation === undefined ? undefined : mutation.after;
};
const payloadOf = (op) => (op.kind === 'write' || op.kind === 'append' ? typedArrayByteLength(op.data) : 0);
function parentKey(key) {
    const at = stringLastIndexOf(key, '/');
    return at < 0 ? '' : stringSlice(key, 0, at);
}
function nameOf(key) {
    return stringSlice(key, stringLastIndexOf(key, '/') + 1);
}
function within(key, root) {
    return key === root || stringStartsWith(key, `${root}/`);
}
/** A new open description's id: unguessable, so no other process's call names it. */
const descriptionId = () => {
    const id = crypto.randomUUID();
    let out = '';
    for (let i = 0; i < id.length; i++)
        if (id[i] !== '-')
            out += id[i];
    return out;
};
/** An inode with none: one shared empty list each, frozen, until it has one of its own. */
const NO_RECORDS = objectFreeze([]);
const NO_RETAINED = objectFreeze([]);
/** What a whole-file write on a mount answers in place of a descriptor: it was logged as one writeFile, nothing opened. */
const WHOLE_WRITTEN = SymbolConstructor('written whole');
export function provisional(host) {
    /** Every file this process has open or changed, one Inode each, by device and number. */
    const table = new SafeMap();
    /** The same Inodes by what holds them: a grant (its cell), or these decisions. What visits one kind visits only it. */
    const held = new SafeSet();
    const loose = new SafeSet();
    const inodeAtNumber = (dev, ino) => {
        const numbers = table.get(dev);
        return numbers === undefined ? undefined : numbers.get(ino);
    };
    const addInode = (inode) => {
        let numbers = table.get(inode.dev);
        if (numbers === undefined)
            table.set(inode.dev, numbers = new SafeMap());
        numbers.set(inode.ino, inode);
        (inode.cell === undefined ? loose : held).add(inode);
    };
    const removeInode = (inode) => {
        const numbers = table.get(inode.dev);
        if (numbers === undefined || numbers.get(inode.ino) !== inode)
            return;
        numbers.delete(inode.ino);
        if (numbers.size === 0)
            table.delete(inode.dev);
        held.delete(inode);
        loose.delete(inode);
    };
    /** `inode`'s grant's cell from now on, or (undefined) none: a grant decides it, or no longer. */
    const setCell = (inode, cell) => {
        if (cell === undefined)
            inode.cell = undefined;
        else
            inode.cell = cell;
        if (inodeAtNumber(inode.dev, inode.ino) !== inode)
            return;
        (cell === undefined ? held : loose).delete(inode);
        (cell === undefined ? loose : held).add(inode);
    };
    /** Every Inode: a copy, so what visits may add or remove. */
    const everyInode = () => {
        const every = setList(held);
        loose.forEach((inode) => { every[every.length] = inode; });
        return every;
    };
    /** Renames planned and not yet settled (planMove). */
    const pendingMoves = new SafeSet();
    /** What a name `key` (the view's `origin`) beneath a pending rename's source grows by once it is made: both beneath its destination. */
    const pendingGrowth = (key, origin) => {
        if (pendingMoves.size === 0)
            return 0;
        let total = 0;
        pendingMoves.forEach(({ from, to }) => { if (within(key, from))
            total += mathMax(0, 2 * stringCost(to + stringSlice(key, from.length)) - stringCost(key) - stringCost(origin)); });
        return total;
    };
    /** Every descriptor of those files, held and provisional alike. */
    const descs = new SafeMap();
    /** Each answered session description's descriptor and the read access its open asked for. */
    const sessions = new SafeMap();
    /** The overlay: the names the pending name records made, removed or moved, and the listings' changes, replayed over the view. */
    const layer = new SafeMap();
    const added = new SafeMap();
    const removed = new SafeMap();
    const nameRecords = [];
    /** The inodes whose own content or attributes the process sees (a fold): every name the view has them at shows them. */
    const touched = new SafeSet();
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
    /**
     * The view's name for what `key` names beneath a directory this process
     * moved (its Inode's origin, until the view has the move), or undefined
     * where no directory above `key` was moved here.
     */
    const viewNameBeneathMoved = (key) => {
        for (let at = stringLastIndexOf(key, '/'); at > 0; at = stringLastIndexOf(key, '/', at - 1)) {
            const dir = stringSlice(key, 0, at);
            if (!layer.has(dir))
                continue;
            const inode = layer.get(dir);
            if (inode === null || inode.local)
                return undefined;
            if (inode.origin !== dir)
                return inode.origin + stringSlice(key, at);
        }
        return undefined;
    };
    const provisionalEntry = (key, known) => {
        if (layer.size === 0 && touched.size === 0)
            return undefined;
        if (layer.has(key)) {
            const inode = layer.get(key);
            return inode === null ? null : entryOf(inode);
        }
        // Beneath a directory moved here: what the view has beneath it where it was.
        if (layer.size > 0) {
            const viewed = viewNameBeneathMoved(key);
            if (viewed !== undefined)
                return host.row(viewed);
        }
        // A file whose content this process changed, at any name the view has it at.
        if (touched.size > 0) {
            const row = known !== undefined ? known : host.row(key);
            const changed = row ? inodeAtNumber(row.dev, row.ino) : undefined;
            if (changed !== undefined && changed.state !== null && !changed.local && changed.cell === undefined
                && changed.heldAt === undefined && changed.records.length === 0 && mapFind(layer, (placed) => placed === changed) === undefined) {
                // A retained fold is only the fallback while no name leads to its inode.
                // The view found it again (a peer's rename): its retired content is the view's.
                renamed(changed, key, key, true);
                changed.row = row;
                changed.base = changed.state = null;
                touched.delete(changed);
                fit(changed);
                activity();
                return undefined;
            }
            if (changed !== undefined && changed.state !== null)
                return entryOf(changed);
        }
        if (layer.size === 0)
            return undefined;
        // A directory made here has no names but the ones made in it.
        const dir = parentKey(key);
        const made = layer.get(dir);
        if (!made || !made.local)
            return undefined;
        const madeIn = added.get(dir);
        return madeIn === undefined || !madeIn.has(nameOf(key)) ? null : undefined;
    };
    /**
     * What an op by name expects at it (W7Expected): the file `row` is, or
     * none. One this process made that the session has not numbered yet is
     * named by the description its open made it through (nothing for a
     * directory or link made here: no description names those).
     */
    const expecting = (row, key) => {
        if (ownValue(host, 'mounted')?.(key) === true)
            return {};
        if (row === null)
            return { expect: null };
        const inode = inodeAtNumber(row.dev, row.ino);
        if (inode?.local !== true)
            return { expect: row.ino };
        return inode.made === undefined ? {} : { expect: { made: inode.made } };
    };
    /** The Inode `inode` is now: itself, or the owner a merge made it part of (canonicalize). */
    const canonical = (inode) => {
        let at = inode;
        while (at.merged !== undefined)
            at = at.merged;
        return at;
    };
    /** The one Inode of the file `row` (at `key`) names. */
    const inodeAt = (key, row) => {
        let inode = inodeAtNumber(row.dev, row.ino);
        if (inode === undefined) {
            inode = { dev: row.dev, ino: row.ino, type: row.type, key, origin: key, row, base: null, state: null, records: NO_RECORDS, recordsCost: 0, unnamed: false, local: false, descs: 0, retained: NO_RETAINED, answers: 0, reserved: 0, lost: undefined, merged: undefined, pin: undefined, cell: undefined, heldAt: undefined, made: undefined, over: undefined };
            addInode(inode);
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
        const found = row !== null && row.dev === inode.dev && row.ino === inode.ino;
        inode.unnamed = !found;
        if (found && inode.state === null && !inode.local)
            inode.row = row;
        return found;
    };
    /**
     * The view's row and bytes of `inode`, by the name the view has it at
     * (origin: the name every row the view admits of it moves, admitted),
     * where that name still leads to it: never another file's that a name came
     * to lead to since.
     */
    const viewed = (inode) => {
        if (inode.lost)
            return undefined;
        const name = inode.origin;
        const row = host.row(name);
        if (!row || row.dev !== inode.dev || row.ino !== inode.ino)
            return undefined;
        const held = inode.type === 'file' ? host.content(name, row.revision) : undefined;
        return { name, row, bytes: held !== undefined && typedArrayByteLength(held) === row.size ? held : undefined };
    };
    /**
     * The bytes `inode`'s pin answers with, where the view has `seen` of it:
     * only those of `revision` (the row's) while a name the view has leads to
     * it; any, theirs for its lifetime, once none does.
     */
    const pinned = (inode, seen, revision) => {
        const pin = inode.pin;
        if (pin === undefined)
            return undefined;
        if (seen === undefined)
            return inode.local || named(inode) ? undefined : pin.bytes;
        return pin.revision === revision ? pin.bytes : undefined;
    };
    /** Whether the view can say nothing of `inode` now: no row at the name it has it at (not listed again since a barrier began it anew), or it is lost. */
    const unknown = (inode) => !inode.local && inode.state === null && (inode.lost === true || host.row(inode.origin) === undefined);
    /** What an inode's records fold over: the view's version of it where the view still has it, else its row as last known, its bytes not held. */
    const baseline = (inode) => {
        const seen = inode.local ? undefined : viewed(inode);
        if (seen !== undefined) {
            inode.row = seen.row;
            const generation = host.generation(seen.name);
            if (generation !== undefined)
                inode.over = { key: seen.name, generation };
        }
        const row = inode.row;
        const held = seen?.bytes ?? pinned(inode, seen, row.revision);
        const bytes = held === undefined ? (row.size === 0 ? new Uint8ArrayConstructor(0) : null) : owned(held);
        return { bytes, size: row.size, mode: row.mode, uid: row.uid, gid: row.gid, atime: row.atime, mtime: row.mtime, ctime: row.ctime };
    };
    /** What `inode` keeps of the budget now: itself and its names, its baseline's and fold's buffers, its records and their bytes, its anchors. */
    const cost = (inode) => {
        let total = INODE_COST + stringCost(inode.key) + stringCost(inode.origin) + (pendingMoves.size === 0 || inode.cell?.detached !== undefined ? 0 : pendingGrowth(inode.key, inode.origin))
            + (inode.row.target === null ? 0 : stringCost(inode.row.target)) + retained(inode.base?.bytes) + (inode.state === inode.base ? 0 : retained(inode.state?.bytes))
            + retained(inode.pin?.bytes) + inode.recordsCost;
        return total;
    };
    /** What a record keeps of the budget: itself and what its op carries (an extended one's room, as the state's bytes count theirs). */
    const recordCost = (record) => RECORD_COST + (record.room === undefined ? payloadOf(record.op) : typedArrayByteLength(record.room));
    /** What `ops` keep as records: each one, and what it carries. */
    const opsCost = (ops) => {
        let sum = 0;
        for (let i = 0; i < ops.length; i++)
            sum += RECORD_COST + payloadOf(ops[i]);
        return sum;
    };
    /** `inode`'s records less `leaving` (a set of them), each gone. */
    const dropRecords = (inode, leaving) => {
        if (leaving.size === 0)
            return;
        const kept = new SafeList();
        for (let i = 0; i < inode.records.length; i++) {
            const record = inode.records[i];
            if (!leaving.has(record)) {
                kept[kept.length] = record;
                continue;
            }
            record.gone = true;
            inode.recordsCost -= recordCost(record);
        }
        inode.records = kept;
    };
    /** The ops of `records`, in order. */
    const opsOf = (records) => {
        const ops = new SafeList();
        for (let i = 0; i < records.length; i++)
            ops[i] = records[i].op;
        return ops;
    };
    /**
     * What `inode` will keep once `ops` more are folded into it, judged before
     * they are and without allocating: its baseline taken first where it has
     * none (the view's bytes of it, where held), its fold's buffer grown as a
     * fold grows it, and their records.
     */
    const projectedCost = (inode, ops) => {
        if (ops.length === 0)
            return cost(inode);
        let baseBytes = inode.base === null ? 0 : retained(inode.base.bytes);
        let capacity = inode.state === null || inode.state.bytes === null ? 0 : typedArrayByteLength(inode.state.bytes);
        let known = inode.state !== null && inode.state.bytes !== null;
        let size = inode.state?.size ?? inode.row.size;
        if (inode.base === null) {
            // A grant's file: its cell's bytes are what the first record folds over (fold: unhold).
            const seen = inode.local || inode.cell !== undefined ? undefined : viewed(inode);
            const held = inode.cell !== undefined ? bytesView(inode.cell.bytes, 0, inode.cell.length)
                : seen?.bytes ?? pinned(inode, seen, seen?.row.revision ?? inode.row.revision);
            known = held !== undefined || inode.row.size === 0;
            baseBytes = held === undefined ? 0 : typedArrayByteLength(held);
            capacity = baseBytes;
            size = held === undefined ? inode.row.size : typedArrayByteLength(held);
        }
        let total = cost(inode) - retained(inode.base?.bytes) - retained(inode.state?.bytes) + baseBytes;
        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            if (op.kind === 'truncate' && op.size === 0)
                known = true;
            const end = op.kind === 'write' ? op.offset + typedArrayByteLength(op.data) : op.kind === 'append' ? size + typedArrayByteLength(op.data) : op.kind === 'truncate' ? op.size : size;
            if (known && end > capacity)
                capacity = mathMax(end, capacity * 2, 4096);
            if (op.kind === 'truncate')
                size = op.size;
            else if (op.kind === 'write' || op.kind === 'append')
                size = mathMax(size, end);
            total += RECORD_COST + payloadOf(op);
        }
        return total + (known ? capacity : 0);
    };
    /**
     * `inode`'s charge brought to what it keeps (cost): what it no longer keeps
     * goes back; what it came to keep in an answer or a barrier (a fold again,
     * a baseline filled, a merge) is taken, and where the budget has no room
     * the bytes it cannot keep it does not: its content becomes unknown, the
     * view's to give again. Its records and what they carry were admitted when
     * they were made, so what is left always fits.
     */
    const fit = (inode) => {
        let need = cost(inode) - inode.reserved;
        if (need > 0 && !host.reserve(need)) {
            inode.pin = undefined;
            if (inode.base !== null)
                inode.base = { ...inode.base, bytes: null };
            if (inode.state !== null)
                inode.state = foldOps(inode.base ?? { ...inode.state, bytes: null }, opsOf(inode.records));
            need = cost(inode) - inode.reserved;
            if (need > 0 && !host.reserve(need))
                need = 0;
        }
        if (need < 0)
            host.release(-need);
        inode.reserved += need;
    };
    /**
     * `inode`'s names here (`key`) and in the view (`origin`) from now on, the
     * one way they change: what they grow by admitted, or already admitted by
     * the change's plan (planMove, a rename's). Where the budget has no room
     * for them, it keeps the names it has and is lost (its names a cache, not
     * its identity): what reaches it by a name is the view's to say. It is
     * lost no more only where a location is accepted as current (`current`:
     * one the view has it at, or a move it makes); a replay restoring the
     * names it has learns nothing.
     */
    const renamed = (inode, key, origin, current = origin !== inode.origin) => {
        const was = { key: inode.key, origin: inode.origin };
        inode.key = key;
        inode.origin = origin;
        const need = cost(inode) - inode.reserved;
        if (need > 0 && !host.reserve(need)) {
            inode.key = was.key;
            inode.origin = was.origin;
            inode.lost = true;
            return;
        }
        if (need > 0)
            inode.reserved += need;
        if (current)
            inode.lost = undefined;
        fit(inode);
    };
    /** What `ops` on `inode` cost before they are made: admitted (ENOSPC where the budget has no room), its charge raised to it. */
    const admitOps = (inode, ops, syscall, path) => {
        const need = projectedCost(inode, ops) - inode.reserved;
        admit(need, syscall, path);
        if (need > 0)
            inode.reserved += need;
    };
    /** `inode`'s state its own, before it changes in place: one given back shares its baseline until then (unhold). */
    const unshared = (inode) => {
        if (inode.state !== null && inode.state === inode.base)
            inode.state = copyState(inode.base);
    };
    /** Fold `op` into `inode` (its baseline taken first): its record, kept until it retires; `description` the one it was made through. */
    /**
     * A grant's file, about to change by anything but its grant, is no
     * grant's from now on: one live content, the fold over its cell's bytes
     * (Provisional.unhold). One a name leads to is the holder's to hand over
     * (what it decided logged, its descriptions opened at the session by that
     * name); one no name leads to is opened by none, and its descriptors write
     * through a description the session has of it (by).
     */
    const unheld = (inode) => {
        const cell = inode.cell;
        if (cell === undefined)
            return;
        if (cell.detached === undefined)
            host.unhold(inode);
        else
            provisional.unhold(inode, cell.detached);
    };
    /** `inode` ready for a change here: a grant's no longer (what that logs goes first), and its fold begun. */
    const ready = (inode) => {
        unheld(inode);
        if (inode.base === null) {
            inode.base = baseline(inode);
            inode.state = copyState(inode.base);
        }
        unshared(inode);
        touched.add(inode);
        activity();
    };
    const fold = (inode, op, description) => {
        ready(inode);
        return recorded(inode, op, description);
    };
    /** `op` recorded for `inode` (ready) and folded into its state. */
    const recorded = (inode, op, description) => {
        const record = { id: ++ids, op, owner: inode, description, answered: false, answeredAt: 0, room: undefined, after: undefined, gone: undefined };
        if (inode.records === NO_RECORDS)
            inode.records = [record];
        else
            inode.records[inode.records.length] = record;
        inode.recordsCost += recordCost(record);
        inode.state = applyOp(inode.state, op);
        return record;
    };
    /** `inode` has nothing pending, nothing open and no name here: it goes, and what it held goes back. */
    const release = (inode) => {
        if (inode.records.length > 0 || inode.descs > 0 || inode.answers > 0 || inode.cell !== undefined)
            return;
        if (mapFind(layer, (value) => value === inode) !== undefined)
            return;
        // A name record that may be replayed names it again (one after it refused, say).
        for (let i = 0; i < nameRecords.length; i++) {
            const record = nameRecords[i];
            if (arrayIncludes(record.places, inode))
                return;
        }
        // What the process sees of a file it changed stays until the view has it (retire), but where no name leads to it.
        if (inode.state !== null && named(inode))
            return;
        touched.delete(inode);
        inode.base = null;
        inode.state = null;
        host.release(inode.reserved);
        inode.reserved = 0;
        removeInode(inode);
        activity();
    };
    /**
     * Log `op` acknowledged, after what a held subtree decided before it, its
     * fate to `settle`: refused only where the session never applied it (an
     * unknown fate counts as answered: only a fresh barrier retires it).
     */
    /**
     * What an answer's handler meets logging after the process ended (a close
     * of what it kept): the client refuses it, as it refuses everything now,
     * and settle reports the process's end. Any other error is the handler's.
     */
    const endedOnly = (error) => {
        if (!host.client.ended)
            throw error;
    };
    const logged = (op, settle, awaited = false) => {
        host.drain();
        const settled = (refused, answer) => {
            settle(refused, answer);
            host.sent();
        };
        if (awaited) {
            // Its caller waits for the session's answer: a refusal is the call's error, not the next sync's.
            const answer = host.client.submit(op);
            void promiseThen(promiseThen(answer, (answered) => settled(false, answered), () => settled(true, undefined)), undefined, endedOnly);
            return answer;
        }
        settles(host.client.submit(op, { acknowledged: true }), settle);
        return undefined;
    };
    /** `settle` told an acknowledged entry's answer once it comes: refused, or not. */
    const settles = (answer, settle) => {
        void promiseThen(promiseThen(answer, (answered) => { const failed = ownValue(answered, 'failed'); settle(failed !== undefined && ownValue(failed, 'refused') === true, answered); host.sent(); }, () => { settle(false, undefined); host.sent(); }), undefined, endedOnly);
    };
    /** `inode`'s fold again from its baseline: what it is with the records it has now. */
    const refold = (inode) => {
        if (inode.base === null)
            return;
        inode.state = foldOps(inode.base, opsOf(inode.records));
    };
    /**
     * `records` met their op's fate, each on the inode it is of now (its
     * owner, whatever answers moved it since): a refused one leaves and its
     * inode folds again; an answered one is stamped, and stays until the view
     * has its outcome (retire).
     */
    const settleRecords = (records, refused, after) => {
        if (!refused) {
            for (let i = 0; i < records.length; i++) {
                const record = records[i];
                if (record.gone)
                    continue;
                record.answered = true;
                record.answeredAt = barriers;
                if (after !== undefined)
                    record.after = after;
            }
            return;
        }
        const refusedOf = new SafeMap();
        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            if (record.gone)
                continue;
            let mine = refusedOf.get(record.owner);
            if (mine === undefined)
                refusedOf.set(record.owner, mine = new SafeSet());
            mine.add(record);
        }
        refusedOf.forEach((mine, inode) => {
            dropRecords(inode, mine);
            refold(inode);
            fit(inode);
            release(inode);
        });
    };
    /** What a name record keeps: itself and its names, and a link's target. */
    const nameCost = (keys, target = '') => {
        let sum = 0;
        for (let i = 0; i < keys.length; i++)
            sum += stringCost(keys[i]);
        return RECORD_COST + sum + stringCost(target);
    };
    /** Log the op that made `records`, their fate its. */
    const loggedOn = (records, op, awaited = false) => logged(op, (refused, answer) => settleRecords(records, refused, mutationAfter(answer)), awaited);
    /** `record`, a write or append `data` continues (continued), extended by it at time `at`: its room grown by doubling. */
    const extended = (record, data, at) => {
        // The record's own op: changed where it is.
        const op = record.op;
        const before = typedArrayByteLength(op.data);
        const length = before + typedArrayByteLength(data);
        const counted = recordCost(record);
        let room = record.room;
        if (room === undefined || typedArrayByteLength(room) < length) {
            const grown = new Uint8ArrayConstructor(mathMax(length, before * 2));
            typedArraySet(grown, op.data);
            record.room = room = grown;
        }
        typedArraySet(room, data, before);
        op.data = bytesView(room, 0, length);
        op.at = at;
        record.owner.recordsCost += recordCost(record) - counted;
    };
    /** The overlay rebuilt: every name record still pending replayed over the view, in log order. */
    const replay = () => {
        const every = everyInode();
        for (let i = 0; i < every.length; i++)
            renamed(every[i], every[i].origin, every[i].origin);
        layer.clear();
        added.clear();
        removed.clear();
        for (let i = 0; i < nameRecords.length; i++) {
            const record = nameRecords[i];
            record.replay();
        }
        touched.clear();
        const now = everyInode();
        for (let i = 0; i < now.length; i++) {
            const inode = now[i];
            if (inode.state !== null)
                touched.add(inode);
            // Its names are what the records left: what it keeps with them.
            fit(inode);
        }
        activity();
    };
    /**
     * Log a name record: replayed now, stamped by its answer, replayed away by
     * its refusal (`settled` told its fate too), and counted toward taking a
     * subtree at its names, as a change decided there is.
     */
    const loggedName = (op, keys, cost, apply, settled, retired, awaited = false) => {
        const over = new SafeList();
        for (let i = 0; i < keys.length; i++)
            over[i] = host.generation(keys[i]);
        apply();
        const places = new SafeList();
        for (let i = 0; i < keys.length; i++) {
            const placed = layer.get(keys[i]);
            if (placed)
                places[places.length] = placed;
        }
        const record = { id: ++ids, keys, over, cost, places, replay: apply, retired, answered: false, answeredAt: 0 };
        nameRecords[nameRecords.length] = record;
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            host.count(key);
        }
        return logged(op, (refused, answer) => {
            if (refused) {
                const at = arrayIndexOf(nameRecords, record);
                if (at >= 0) {
                    for (let i = at; i < nameRecords.length - 1; i++)
                        nameRecords[i] = nameRecords[i + 1];
                    nameRecords.length--;
                }
                host.release(record.cost);
                replay();
                // What only it kept goes: a file, directory or link it made that nothing else holds now.
                const every = everyInode();
                for (let i = 0; i < every.length; i++)
                    if (every[i].local)
                        release(every[i]);
            }
            else {
                record.answered = true;
                record.answeredAt = barriers;
            }
            settled?.(refused, answer);
        }, awaited);
    };
    const note = (dir, name, type) => {
        if (type === null) {
            const madeIn = added.get(dir);
            if (madeIn !== undefined)
                madeIn.delete(name);
            let gone = removed.get(dir);
            if (gone === undefined)
                removed.set(dir, gone = new SafeSet());
            gone.add(name);
        }
        else {
            const goneIn = removed.get(dir);
            if (goneIn !== undefined)
                goneIn.delete(name);
            let made = added.get(dir);
            if (made === undefined)
                added.set(dir, made = new SafeMap());
            made.set(name, type);
        }
    };
    /** `key` names `inode` from now on (null: nothing). */
    const place = (key, placed) => {
        const inode = placed === null ? null : canonical(placed);
        layer.set(key, inode);
        note(parentKey(key), nameOf(key), inode === null ? null : inode.type);
        if (inode !== null) {
            touched.delete(inode);
            renamed(inode, key, inode.origin);
            inode.unnamed = false;
            if (inode.state !== null)
                touched.add(inode);
        }
        activity();
    };
    /** The parent of `key`, when the process may make a name in it: a known, writable, searchable directory of the session's filesystem. */
    const writableParent = (key, path, syscall) => {
        const parent = rowAt(parentKey(key));
        // On this filesystem, or on a mount the host decides on (ProvisionalHost.mounted).
        if (parent === undefined || parent === null || (parent.dev !== host.device && ownValue(host, 'mounted')?.(key) !== true))
            return undefined;
        if (parent.type !== 'directory')
            throw fsError('ENOTDIR', syscall, path);
        if (!modeAllows(parent, 3, host.cred))
            throw fsError('EACCES', syscall, path);
        return parent;
    };
    /** Whether `row` at `key` may be removed or replaced here: its directory writable, and its sticky bit honoured (EPERM). */
    const removable = (key, row, path, syscall) => {
        const parent = writableParent(key, path, syscall);
        if (parent === undefined)
            return false;
        if (stickyRefusal(parent, row, host.cred) !== null)
            throw fsError('EPERM', syscall, path);
        return true;
    };
    const ownership = (parent) => {
        const setgid = (parent.mode & 0o2000) !== 0;
        return { uid: host.cred.uid, gid: setgid ? parent.gid : host.cred.gid, setgid };
    };
    /** A file, directory or link made here: numbered by this process until its creating open's answer numbers it (reconcile). */
    const made = (key, type, mode, parent, target = null) => {
        const { uid, gid } = ownership(parent);
        const at = host.now();
        const row = {
            type, dev: host.device, ino: localIno++, nlink: type === 'directory' ? 2 : 1, size: target === null ? 0 : typedArrayByteLength(new TextEncoder().encode(target)),
            atime: at, mtime: at, ctime: at, mode, uid, gid, revision: 0, target,
        };
        const inode = { dev: row.dev, ino: row.ino, type, key, origin: key, row, base: null, state: null, records: NO_RECORDS, recordsCost: 0, unnamed: false, local: true, descs: 0, retained: NO_RETAINED, answers: 0, reserved: 0, lost: undefined, merged: undefined, pin: undefined, cell: undefined, heldAt: undefined, made: undefined, over: undefined };
        if (type === 'file') {
            inode.base = { bytes: new Uint8ArrayConstructor(0), size: 0, mode, uid, gid, atime: at, mtime: at, ctime: at };
            inode.state = copyState(inode.base);
            touched.add(inode);
            activity();
        }
        addInode(inode);
        // Admitted by its maker (madeCost): what it keeps from now on.
        inode.reserved = cost(inode);
        return inode;
    };
    /** What a file, directory or link made at `key` keeps (made): admitted before it is. */
    const madeCost = (key, target = '') => INODE_COST + 2 * stringCost(key) + stringCost(target) + pendingGrowth(key, key);
    /**
     * The bytes the view holds of `inode`, kept for its descriptors once its
     * name goes (an unlink, a rename over it): admitted with what removes it
     * (`more`, its record), then taken.
     */
    const keepForDescriptors = (inode, more, syscall, path) => {
        const seen = inode === undefined || inode.descs === 0 || inode.base !== null ? undefined : viewed(inode);
        // Nothing the view holds of it (bytes it may not read, or never fetched): its descriptors read as before, by their pin or anchor.
        if (inode === undefined || seen?.bytes === undefined) {
            admit(more, syscall, path);
            return;
        }
        const held = typedArrayByteLength(seen.bytes);
        admit(more + 2 * held, syscall, path);
        inode.reserved += 2 * held;
        inode.base = baseline(inode);
        inode.state = copyState(inode.base);
        touched.add(inode);
        fit(inode);
    };
    /**
     * An open's answer: the file the session opened is the one the process
     * decided it on (its open carried it: W7Expected; the session refuses one
     * whose name led elsewhere), or the file it made, numbered now
     * (canonicalize). The Inode that is that file from now on.
     */
    const reconcile = (inode, answer, creating) => {
        const receipt = answer === undefined ? undefined : ownValue(answer, 'receipt');
        const file = receipt !== undefined && creating && inode.local ? canonicalize(inode, receipt) : inode;
        fit(file);
        return file;
    };
    /**
     * A file this process made is the session's numbered one from now on
     * (§0.1), before the number is published anywhere, the one way the
     * registry learns a number for one of its own: rekeyed; or, where the
     * table already holds an Inode of that number (an admission learned it
     * first: a peer moved the new file, and the process opened it there),
     * merged into that one, its descriptors, records and names with it: one
     * owner, never two. Its baseline is the receipt's, the file as the
     * creating open left it, with what this process made of it through
     * either folded over that in log order. The owner.
     */
    const canonicalize = (made, receipt) => {
        removeInode(made);
        made.local = false;
        const owner = inodeAtNumber(receipt.dev, receipt.ino) ?? made;
        if (owner === made) {
            made.dev = receipt.dev;
            made.ino = receipt.ino;
            addInode(made);
        }
        else {
            descs.forEach((desc) => { if (desc.inode === made)
                desc.inode = owner; });
            for (let i = 0; i < made.records.length; i++) {
                const record = made.records[i];
                record.owner = owner;
            }
            const records = new SafeList();
            for (let i = 0; i < owner.records.length; i++)
                records[records.length] = owner.records[i];
            for (let i = 0; i < made.records.length; i++)
                records[records.length] = made.records[i];
            owner.records = arraySort(records, (a, b) => a.id - b.id);
            owner.recordsCost += made.recordsCost;
            owner.descs += made.descs;
            owner.answers += made.answers;
            const retained = new SafeList();
            for (let i = 0; i < owner.retained.length; i++)
                retained[retained.length] = owner.retained[i];
            for (let i = 0; i < made.retained.length; i++)
                retained[retained.length] = made.retained[i];
            owner.retained = retained;
            layer.forEach((value, key) => { if (value === made)
                layer.set(key, owner); });
            for (let i = 0; i < nameRecords.length; i++) {
                const record = nameRecords[i];
                const places = new SafeList();
                for (let j = 0; j < record.places.length; j++)
                    places[j] = record.places[j] === made ? owner : record.places[j];
                record.places = places;
            }
            touched.delete(made);
            host.release(made.reserved);
            made.reserved = 0;
            bury(made, owner);
        }
        owner.row = { ...owner.row, dev: receipt.dev, ino: receipt.ino, size: receipt.size, mode: receipt.mode, uid: receipt.uid, gid: receipt.gid };
        owner.base = { bytes: receipt.size === 0 ? new Uint8ArrayConstructor(0) : null, size: receipt.size, mode: receipt.mode, uid: receipt.uid, gid: receipt.gid, atime: receipt.mtimeMs, mtime: receipt.mtimeMs, ctime: receipt.ctimeMs };
        refold(owner);
        return owner;
    };
    /**
     * A merged Inode is dead: it keeps only its forward to its owner, which
     * whatever held it across a wait resolves (canonical); any other use of it
     * throws, so a stray reference shows itself at once.
     */
    const bury = (dead, owner) => {
        const fields = objectKeys(dead);
        for (let i = 0; i < fields.length; i++) {
            const field = fields[i];
            // A field it has none of (undefined) reads as none, as one it never had.
            if (dead[field] === undefined)
                continue;
            const thrower = objectCreate(null);
            thrower.get = () => { throw new Error(`a merged Inode's ${field} used after its merge (canonical)`); };
            thrower.configurable = true;
            reflectDefineProperty(dead, field, thrower);
        }
        reflectDefineProperty(dead, 'merged', dataDescriptor(owner, false, false, false));
    };
    /** An open's answer: reconciled (reconcile), then what was made through it settled. */
    const openAnswered = (opened, description, records, creating, read) => (refused, answer) => {
        // The file it opened as it is now: one a merge made part of another is that one.
        let inode = canonical(opened);
        inode.answers--;
        // The session's descriptor of the description: what reads its file once no name leads to it (sessionOf).
        const receipt = answer === undefined ? undefined : ownValue(answer, 'receipt');
        if (!refused && receipt?.handle !== undefined)
            sessions.set(description, { handle: receipt.handle, read });
        if (inode.made === description)
            inode.made = undefined;
        if (!refused)
            inode = reconcile(inode, answer, creating);
        // Numbered, or never made: its description names it no more, and goes once nothing holds it open; refused, the
        // session never had it, so it is no file's anchor either.
        if (refused && arrayIncludes(inode.retained, description)) {
            const retained = new SafeList();
            for (let i = 0; i < inode.retained.length; i++)
                if (inode.retained[i] !== description)
                    retained[retained.length] = inode.retained[i];
            inode.retained = retained;
            sessions.delete(description);
        }
        closeRetained(inode);
        settleRecords(records, refused, mutationAfter(answer));
        fit(inode);
        release(inode);
    };
    /** `inode`'s kept descriptions close once no descriptor of it is open and none names a file it made unnumbered (made). */
    const closeRetained = (inode) => {
        if (inode.descs > 0 || inode.made !== undefined || inode.retained.length === 0)
            return;
        const retained = inode.retained;
        inode.retained = NO_RETAINED;
        for (let i = 0; i < retained.length; i++) {
            const description = retained[i];
            sessions.delete(description);
            logged({ type: 'call', call: { call: 'close', path: inode.key, description } }, () => { });
        }
    };
    /** A new descriptor of `inode` with its own rights; `description` its open at the session where it may write. */
    const descriptor = (inode, path, flags, description) => {
        const id = host.nextHandle();
        const write = flags.write === true || flags.append === true;
        descs.set(id, { inode, read: flags.read === true || !write, write, append: flags.append === true, position: 0, path, description, opening: undefined, lastRecord: null, lastAnswer: null });
        inode.descs++;
        return { id, path };
    };
    const descOf = (handleId) => {
        const desc = descs.get(handleId);
        if (desc === undefined)
            throw fsError('EBADF', 'fd', stringOf(handleId));
        return desc;
    };
    /** An inode's bytes now: its fold's, else the view's while its name leads to it. Undefined where none are held here; ESTALE where no name leads to it and it retains none. */
    const bytesOf = (inode, syscall, path) => {
        if (inode.state !== null) {
            if (inode.state.bytes === null) {
                // Its baseline's bytes not held when it took its first record: held now at that revision, the records fold over them.
                // One a grant gave back (heldAt) has its cell's bytes for baseline, newer than any the view has until it retires.
                const seen = inode.heldAt === undefined ? viewed(inode) : undefined;
                if (seen?.bytes === undefined || seen.row.revision !== inode.row.revision)
                    return undefined;
                inode.base = { ...inode.base, bytes: owned(seen.bytes) };
                refold(inode);
                // Kept only where the budget has room (fit): else unknown again, and the read waits for the session.
                fit(inode);
                if (inode.state.bytes === null)
                    return undefined;
            }
            return { bytes: inode.state.bytes, size: inode.state.size };
        }
        // The view can say nothing of it now: as a read by name there, not here.
        if (unknown(inode))
            return undefined;
        const seen = viewed(inode);
        if (seen === undefined) {
            // No name the view has leads to it: what its descriptors last read of it, else ESTALE.
            if (named(inode) || inode.pin === undefined) {
                if (!named(inode))
                    throw fsError('ESTALE', syscall, path);
                return undefined;
            }
            return { bytes: inode.pin.bytes, size: typedArrayByteLength(inode.pin.bytes) };
        }
        inode.row = seen.row;
        // The view's name for it has no bytes yet (moved there by a rename): what its descriptors read of it at that revision.
        if (seen.bytes === undefined) {
            const pin = pinned(inode, seen, seen.row.revision);
            return pin === undefined ? undefined : { bytes: pin, size: typedArrayByteLength(pin) };
        }
        // Pinned for its descriptors while the view's name for it may move or go: the bytes they last read.
        if (inode.descs > 0 && inode.pin?.bytes !== seen.bytes) {
            inode.pin = { revision: seen.row.revision, bytes: seen.bytes };
            fit(inode);
        }
        return { bytes: seen.bytes, size: typedArrayByteLength(seen.bytes) };
    };
    /** An open description of `inode` at the session, any of its descriptors': what reaches it whatever names it (its anchor). */
    const anchorOf = (inode, read = false) => {
        if (inode.descs === 0)
            return undefined;
        for (let i = 0; i < inode.retained.length; i++) {
            const description = inode.retained[i];
            if (!read || sessions.get(description)?.read === true)
                return description;
        }
        const desc = mapFind(descs, (each) => each.inode === inode && each.description !== undefined && (!read || sessions.get(each.description)?.read === true));
        return desc === undefined ? undefined : desc.description;
    };
    /** What a descriptor's call names its file by: its description, else one the session has of its file (anchorOf), else its number. */
    const by = (desc) => {
        const description = desc.description ?? anchorOf(desc.inode);
        return description !== undefined ? { description } : { ino: desc.inode.ino };
    };
    /**
     * A content operation by a descriptor, judged then made: its file still
     * its own (or retained), its logged bytes under the client's cap, what it
     * keeps admitted; then folded and logged as it was made.
     */
    const contentOp = (desc, op, call, logs, syscall, awaited = false) => {
        const inode = desc.inode;
        // Through its description the session reaches its file wherever, or whether, a name leads to it; by number only while one does.
        if (desc.description === undefined && inode.state === null && !named(inode))
            throw fsError('ESTALE', syscall, desc.path);
        host.drain();
        host.client.fitsSync(logs, desc.path);
        admitOps(inode, [op], syscall, desc.path);
        ready(inode);
        host.drain();
        if (awaited) {
            // Its caller waits for the session's answer: a refusal is the call's error, not the next sync's.
            const record = recorded(desc.inode, op, desc.description);
            desc.lastRecord = record;
            const answer = host.client.submit(call);
            desc.lastAnswer = answer;
            void promiseThen(promiseThen(promiseThen(answer, (answered) => settleRecords([record], false, mutationAfter(answered)), () => settleRecords([record], true)), () => { fit(inode); host.sent(); }), undefined, endedOnly);
            fit(inode);
            return answer;
        }
        recordedFor(desc, op, host.client.submit(call, { acknowledged: true }));
        fit(inode);
        return undefined;
    };
    /** `op` a record of its own, settled by `answer` (its client entry's): the one a write the client folds into that entry extends (continued). */
    const recordedFor = (desc, op, answer) => {
        const record = recorded(desc.inode, op, desc.description);
        desc.lastRecord = record;
        desc.lastAnswer = answer;
        settles(answer, (refused, answered) => settleRecords([record], refused, mutationAfter(answered)));
    };
    /**
     * A write `desc`'s last change continues, as the session answers each
     * client entry once: the client folds it into that change's entry (copying
     * its bytes, so the caller's are not kept) and the change's record extends.
     * Admitted for what grows. False, nothing done, where the client would not
     * fold it: a change of its own (contentOp).
     */
    const continued = (desc, start, bytes, at) => {
        const inode = desc.inode;
        const last = desc.lastRecord;
        if (last === null || last.answered || last.gone === true || last.owner !== inode || inode.cell !== undefined || inode.state === null)
            return false;
        const was = last.op;
        if ((was.kind !== 'write' && was.kind !== 'append') || (start === undefined ? was.kind !== 'append' : was.kind !== 'write' || start !== was.offset + typedArrayByteLength(was.data)))
            return false;
        // What it adds is what grows: its record's room and its state's, each by doubling; most writes add nothing to admit.
        unshared(inode);
        const state = inode.state;
        const before = typedArrayByteLength(was.data);
        const length = before + typedArrayByteLength(bytes);
        const recordRoom = last.room !== undefined && typedArrayByteLength(last.room) >= length ? typedArrayByteLength(last.room) : mathMax(length, before * 2);
        const capacity = state.bytes === null ? 0 : typedArrayByteLength(state.bytes);
        const end = start === undefined ? state.size + typedArrayByteLength(bytes) : start + typedArrayByteLength(bytes);
        const growth = recordRoom - (last.room === undefined ? before : typedArrayByteLength(last.room)) + (state.bytes !== null && end > capacity ? mathMax(end, capacity * 2, 4096) - capacity : 0);
        host.drain();
        host.client.fitsSync(typedArrayByteLength(bytes), desc.path);
        if (growth > 0) {
            const need = cost(inode) + growth - inode.reserved;
            admit(need, 'write', desc.path);
            if (need > 0)
                inode.reserved += need;
        }
        const call = { type: 'call', call: start === undefined
                ? { call: 'append', path: inode.key, ...by(desc), data: bytes }
                : { call: 'write', path: inode.key, ...by(desc), offset: start, data: bytes } };
        // Not folded: any room taken is the general path's to count.
        const answer = host.client.fold(call, { acknowledged: true });
        if (answer === undefined)
            return false;
        const op = start === undefined ? { kind: 'append', data: bytes, at } : { kind: 'write', offset: start, data: bytes, at };
        if (answer === desc.lastAnswer) {
            extended(last, bytes, at);
            inode.state = applyOp(state, op);
            if (growth > 0)
                fit(inode);
            return true;
        }
        // Folded into another entry than the change's: a record of its own, settled by that entry.
        const data = owned(bytes);
        recordedFor(desc, start === undefined ? { kind: 'append', data, at } : { kind: 'write', offset: start, data, at }, answer);
        fit(inode);
        return true;
    };
    const judgeAttrs = (row, attrs, syscall, path) => {
        const refused = isModeChange(attrs) ? chmodRefusal(row, host.cred)
            : isOwnerChange(attrs) ? chownRefusal(row, attrs.uid, attrs.gid, host.cred)
                : utimesRefusal(row, explicitTimes(attrs.atime, attrs.mtime), host.cred);
        if (refused !== null)
            throw fsError(refused, syscall, path);
    };
    const attrOp = (attrs, at) => (isModeChange(attrs) ? { kind: 'chmod', mode: attrs.mode, at }
        : isOwnerChange(attrs) ? { kind: 'chown', uid: attrs.uid, gid: attrs.gid, by: host.cred.uid, at }
            : { kind: 'utimes', atime: attrs.atime, mtime: attrs.mtime, at });
    /**
     * A file opened to write here, planned and judged whole: made (O_CREAT on
     * nothing) or emptied (O_TRUNC), its open logged as it was made with a
     * description of its own, then `bytes` written by it and, with `close`,
     * closed. `chmod`: the mode its open sets (a copy's keepMode).
     */
    const openToWrite = (key, path, flags, row, given, close, chmod, awaited = false) => {
        // Its own bytes: what it logs and what it folds, whatever the caller does with its buffer after.
        const bytes = given === null ? null : owned(given);
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
            // A directory as the session's open judges one: refused, or a descriptor of the session's.
            if (row.type === 'directory' && refusesDirectory(flags))
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
        // A made file's O_TRUNC changes nothing here, but is the session's if the name turns out to be another's file (reconcile).
        if (flags.truncate)
            ops[ops.length] = { kind: 'truncate', size: 0, at };
        if (bytes !== null && typedArrayByteLength(bytes) > 0)
            ops[ops.length] = { kind: 'write', offset: 0, data: bytes, at };
        if (chmod !== undefined)
            ops[ops.length] = { kind: 'chmod', mode: chmod, at };
        // What older decisions left unlogged goes first, and with what this logs, must fit what the log holds unanswered.
        host.drain();
        host.client.fitsSync(bytes === null ? 0 : typedArrayByteLength(bytes), path);
        const inode = row === null ? null : inodeAt(key, row);
        if (inode !== null) {
            try {
                admitOps(inode, ops, 'open', path);
            }
            catch (error) {
                release(inode);
                throw error;
            }
        }
        else {
            const written = bytes !== null && typedArrayByteLength(bytes) > 0 ? mathMax(typedArrayByteLength(bytes), 4096) : 0;
            admit(madeCost(key) + nameCost([key]) + written + opsCost(ops), 'open', path);
        }
        // Made.
        const description = descriptionId();
        // The open as the caller asked it: the session's name may lead elsewhere by the time it lands, and its open is the one that decides.
        const open = {
            type: 'call', call: {
                call: 'open', path: key, mode: flags.create ? asked : row.mode & 0o7777,
                ...(flags.create ? { umask, create: true } : {}),
                ...(flags.exclusive && row === null ? { exclusive: true } : {}),
                ...(flags.truncate ? { truncate: true } : {}),
                ...(flags.followSymlinks === false ? { nofollow: true } : {}),
                access: read ? 'readwrite' : 'write',
                ...(chmod === undefined ? {} : { fchmod: chmod }),
                description,
                // The file it decided this on (none, for a file it makes): the session refuses it where the name leads elsewhere.
                // One made exclusively needs none: the session's EEXIST refuses it first.
                ...(flags.exclusive && row === null ? {} : expecting(row, key)),
            },
        };
        let target;
        if (row === null) {
            target = made(key, 'file', 0o100000 | (asked & ~umask), parent);
            target.made = description;
            // Admitted above with it: its records and its fold's buffer.
            target.reserved += (bytes !== null && typedArrayByteLength(bytes) > 0 ? mathMax(typedArrayByteLength(bytes), 4096) : 0) + opsCost(ops);
        }
        else {
            target = inode;
        }
        // A whole file written on a mount goes as one write of it (a mount's backend is asked once, as by writeFile(2)'s callers).
        if (close && bytes !== null && chmod === undefined && ownValue(host, 'mounted')?.(key) === true) {
            const records = new SafeList();
            for (let i = 0; i < ops.length; i++)
                records[i] = fold(target, ops[i]);
            const whole = { type: 'call', call: { call: 'writeFile', path: key, mode: asked, umask, data: bytes } };
            const settled = (refused, answer) => {
                settleRecords(records, refused, mutationAfter(answer));
                fit(target);
                release(target);
            };
            if (row === null)
                loggedName(whole, [key], nameCost([key]), () => place(key, target), settled);
            else {
                host.count(key);
                logged(whole, settled);
            }
            fit(target);
            return WHOLE_WRITTEN;
        }
        target.answers++;
        // The open's own effects (its truncate, its fchmod) are its records; its writes are theirs.
        const opened = new SafeList();
        for (let i = 0; i < ops.length; i++)
            if (ops[i].kind !== 'write')
                opened[opened.length] = fold(target, ops[i], description);
        // Its answer says which file the session opened first: what was made through it is that file's before any is settled.
        const answered = openAnswered(target, description, opened, row === null, read);
        let opening;
        if (row === null) {
            opening = loggedName(open, [key], nameCost([key]), () => place(key, target), answered, undefined, awaited);
        }
        else {
            host.count(key);
            opening = logged(open, answered, awaited);
        }
        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            if (op.kind !== 'write')
                continue;
            loggedOn([fold(target, op, description)], { type: 'call', call: { call: 'write', path: key, description, offset: op.offset, data: op.data } });
        }
        fit(target);
        const handle = descriptor(target, path, { ...flags, write: true }, description);
        descOf(handle.id).write = flags.write === true || flags.append === true || bytes !== null;
        if (opening !== undefined)
            descOf(handle.id).opening = opening;
        if (close)
            provisional.close(handle.id);
        return handle;
    };
    const provisional = {
        inode: inodeAtNumber,
        inodeFor: (key, row) => {
            const known = inodeAtNumber(row.dev, row.ino);
            if (known !== undefined)
                return known;
            const inode = inodeAt(key, row);
            const need = cost(inode);
            if (!host.reserve(need)) {
                removeInode(inode);
                return undefined;
            }
            inode.reserved = need;
            return inode;
        },
        heldDescriptor: (inode, path, read, append) => {
            const id = host.nextHandle();
            descs.set(id, { inode, read, write: true, append, position: 0, path, description: undefined, opening: undefined, lastRecord: null, lastAnswer: null });
            inode.descs++;
            return { id, path };
        },
        descriptor: (handleId) => descs.get(handleId),
        descriptorsOf: (inode) => {
            const found = new SafeList();
            if (inode.descs === 0)
                return found;
            const seen = new SafeSet();
            descs.forEach((desc) => {
                if (desc.inode !== inode || seen.has(desc))
                    return;
                seen.add(desc);
                found[found.length] = desc;
            });
            return found;
        },
        cells: () => setList(held),
        hold: (inode, cell) => setCell(inode, cell),
        dropCell: (inode) => {
            setCell(inode, undefined);
            fit(inode);
            release(inode);
        },
        planMove: (from, to, path) => {
            const plan = { from, to };
            const beneath = () => {
                const every = everyInode();
                const found = new SafeList();
                for (let i = 0; i < every.length; i++) {
                    const inode = every[i];
                    if ((inode.cell === undefined || inode.cell.detached === undefined) && within(inode.key, from))
                        found[found.length] = inode;
                }
                return found;
            };
            // Pending from now: what each file beneath keeps grows by its names' growth, admitted at once.
            pendingMoves.add(plan);
            let need = 0;
            const under = beneath();
            for (let i = 0; i < under.length; i++)
                need += mathMax(0, cost(under[i]) - under[i].reserved);
            if (need > 0 && !host.reserve(need)) {
                pendingMoves.delete(plan);
                throw fsError('ENOSPC', 'rename', path);
            }
            const reserving = beneath();
            for (let i = 0; i < reserving.length; i++)
                reserving[i].reserved = mathMax(reserving[i].reserved, cost(reserving[i]));
            const settle = (made) => {
                if (!pendingMoves.has(plan))
                    return;
                const files = beneath();
                pendingMoves.delete(plan);
                // Made, its names are beneath `to`, what they grew by taken as charged; not, the growth goes back.
                for (let i = 0; i < files.length; i++) {
                    const inode = files[i];
                    if (made)
                        renamed(inode, to + stringSlice(inode.key, from.length), to + stringSlice(inode.key, from.length));
                    else
                        fit(inode);
                }
            };
            return { commit: () => settle(true), cancel: () => settle(false) };
        },
        unhold: (inode, entry) => {
            const cell = inode.cell;
            if (cell === undefined)
                return;
            setCell(inode, undefined);
            inode.row = { ...entry, size: cell.length };
            // The cell's bytes are the baseline's own (no one else holds them now), kept at their size: not the room a grant drew for more.
            const bytes = typedArrayByteLength(cell.bytes) === cell.length && retained(cell.bytes) === cell.length ? cell.bytes : owned(cell.bytes, cell.length);
            inode.base = { bytes, size: cell.length, mode: entry.mode, uid: entry.uid, gid: entry.gid, atime: entry.atime, mtime: entry.mtime, ctime: entry.ctime };
            // Its state is its baseline until something changes it here (unshared): no copy of bytes nothing may change.
            inode.state = inode.base;
            inode.heldAt = Infinity;
            touched.add(inode);
            // Its bytes are the budget's from now on: kept where it has room, else unknown here (the session reads them).
            fit(inode);
            activity();
        },
        answeredHeld: (root) => {
            loose.forEach((inode) => { if (inode.heldAt === Infinity && (within(inode.key, root) || within(inode.origin, root)))
                inode.heldAt = barriers; });
        },
        pending: (dev, ino) => {
            const inode = inodeAtNumber(dev, ino);
            return inode !== undefined && (inode.cell !== undefined || inode.state !== null || inode.key !== inode.origin);
        },
        sessionOf: (handleId, access) => {
            const desc = descs.get(handleId);
            if (desc === undefined)
                return undefined;
            const own = desc.description;
            const description = own !== undefined && (access !== 'read' || sessions.get(own)?.read === true) ? own : anchorOf(desc.inode, access === 'read');
            return description === undefined ? undefined : sessions.get(description)?.handle;
        },
        anchored: (description, handle, read) => {
            if (handle !== undefined)
                sessions.set(description, { handle, read });
        },
        kept: () => {
            let total = 0;
            const every = everyInode();
            for (let i = 0; i < every.length; i++)
                total += cost(every[i]);
            for (let i = 0; i < nameRecords.length; i++) {
                const record = nameRecords[i];
                total += record.cost;
            }
            return total;
        },
        owns: (handleId) => descs.size > 0 && descs.has(handleId),
        touches: (key) => {
            if (layer.size === 0 && touched.size === 0)
                return false;
            if (layer.has(key) || layer.has(parentKey(key)))
                return true;
            // Above a name they have pending: a grant moves nothing their name records reach (a file's own records follow it, moved).
            let above = false;
            layer.forEach((_placed, name) => { if (!above && within(name, key))
                above = true; });
            if (above)
                return true;
            const row = host.row(key);
            return row ? inodeAtNumber(row.dev, row.ino)?.state != null : false;
        },
        setStatus: (handleId, status) => {
            const desc = descOf(handleId);
            const append = ownValue(status, 'append');
            if (append !== undefined)
                desc.append = append;
        },
        entry: provisionalEntry,
        children: (key, base) => {
            if (layer.size === 0)
                return base;
            // A directory moved here lists what the view lists where it was, until the view has the move.
            const dir = layer.get(key);
            const origin = dir === undefined ? viewNameBeneathMoved(key) : dir === null || dir.local || dir.origin === key ? undefined : dir.origin;
            const viewed = origin === undefined ? base : host.children(origin);
            const made = added.get(key);
            const gone = removed.get(key);
            if (made === undefined && gone === undefined)
                return viewed;
            // A directory made here has no names but the ones made in it: what the view lists at its name is another's.
            const listed = dir && dir.local ? [] : viewed;
            if (listed === undefined)
                return undefined;
            const out = new SafeMap();
            for (let i = 0; i < listed.length; i++) {
                const child = listed[i];
                if (gone === undefined || !gone.has(child.name))
                    out.set(child.name, child.type);
            }
            if (made !== undefined)
                made.forEach((type, name) => { out.set(name, type); });
            const children = new SafeList();
            out.forEach((type, name) => { children[children.length] = { name, type }; });
            return arrayCopy(children);
        },
        open: (key, path, flags, row, awaited = false) => {
            // One refusal order for every open: a name there refuses O_CREAT|O_EXCL whatever it is or is asked for.
            if (row !== null && flags.create && flags.exclusive)
                throw fsError('EEXIST', 'open', path);
            const write = flags.write === true || flags.append === true;
            // One that makes or empties its file, or may write it, is opened at the session as here.
            if (write || flags.truncate || (row === null && flags.create)) {
                const handle = openToWrite(key, path, flags, row, null, false, undefined, awaited);
                if (handle === WHOLE_WRITTEN)
                    throw new Error('internal: an open with nothing to write was written whole');
                if (handle !== undefined)
                    descOf(handle.id).write = write;
                return handle;
            }
            if (row === null)
                throw fsError('ENOENT', 'open', path);
            // Read-only, for a caller that may wait (an O_CREAT of a file there): the session's descriptor, as every read-only open of such a caller is.
            if (awaited)
                return undefined;
            // Read-only: metadata only, nothing read and nothing logged.
            if (row.type === 'directory' || row.type !== 'file')
                return undefined;
            if (!modeAllows(row, 4, host.cred))
                throw fsError('EACCES', 'open', path);
            const inode = inodeAt(key, row);
            try {
                admitOps(inode, [], 'open', path);
            }
            catch (error) {
                release(inode);
                throw error;
            }
            return descriptor(inode, path, flags, undefined);
        },
        writeFile: (key, path, bytes, row, umask) => openToWrite(key, path, { write: true, create: true, truncate: true, mode: 0o666, ...(umask === undefined ? {} : { umask }) }, row, bytes, true) !== undefined,
        read: (handleId, offset, length) => {
            const desc = descOf(handleId);
            if (!desc.read)
                throw fsError('EBADF', 'read', desc.path);
            const held = bytesOf(desc.inode, 'read', desc.path);
            if (held === undefined)
                return undefined;
            const start = mathMin(offset ?? desc.position, held.size);
            const chunk = owned(bytesView(held.bytes, start, mathMin(held.size, start + length)));
            if (offset === null)
                desc.position = start + typedArrayByteLength(chunk);
            return chunk;
        },
        write: (handleId, offset, bytes, awaited = false) => {
            const desc = descOf(handleId);
            if (!desc.write)
                throw fsError('EBADF', 'write', desc.path);
            // write(2) of nothing to a regular file changes nothing.
            if (bytes.byteLength === 0)
                return 0;
            const at = host.now();
            const start = desc.append ? undefined : offset ?? desc.position;
            if (!awaited && continued(desc, start, bytes, at)) {
                desc.position = start === undefined ? desc.inode.state.size : offset === null ? start + typedArrayByteLength(bytes) : desc.position;
                return typedArrayByteLength(bytes);
            }
            // One private copy: what is folded and what is logged, whatever the caller does with its buffer after.
            const data = owned(bytes);
            let answer;
            if (desc.append) {
                answer = contentOp(desc, { kind: 'append', data, at }, { type: 'call', call: { call: 'append', path: desc.inode.key, ...by(desc), data } }, typedArrayByteLength(data), 'write', awaited);
                desc.position = desc.inode.state.size;
            }
            else {
                const start = offset ?? desc.position;
                answer = contentOp(desc, { kind: 'write', offset: start, data, at }, { type: 'call', call: { call: 'write', path: desc.inode.key, ...by(desc), offset: start, data } }, typedArrayByteLength(data), 'write', awaited);
                if (offset === null)
                    desc.position = start + typedArrayByteLength(data);
            }
            return answer === undefined ? typedArrayByteLength(bytes) : promiseThen(answer, () => typedArrayByteLength(bytes));
        },
        ftruncate: (handleId, size, awaited = false) => {
            const desc = descOf(handleId);
            if (!desc.write)
                throw fsError('EINVAL', 'ftruncate', desc.path);
            const answer = contentOp(desc, { kind: 'truncate', size, at: host.now() }, { type: 'call', call: { call: 'ftruncate', path: desc.inode.key, ...by(desc), size } }, 0, 'ftruncate', awaited);
            return answer === undefined ? undefined : promiseThen(answer, () => undefined);
        },
        seek: (handleId, offset, whence) => {
            const desc = descOf(handleId);
            if (whence === 'end')
                named(desc.inode);
            const position = (whence === 'set' ? 0 : whence === 'current' ? desc.position : entryOf(desc.inode).size) + offset;
            if (position < 0)
                throw fsError('EINVAL', 'lseek', desc.path);
            desc.position = position;
            return position;
        },
        fstat: (handleId) => {
            const desc = descOf(handleId);
            if (unknown(desc.inode))
                return undefined;
            named(desc.inode);
            return entryOf(desc.inode);
        },
        admitted: (key, entry) => {
            if (table.size === 0)
                return;
            const inode = inodeAtNumber(entry.dev, entry.ino);
            if (inode === undefined || inode.local || inode.cell?.detached !== undefined || inode.origin === key && inode.row === entry)
                return;
            // Its name here follows the view's unless a rename of its own is pending (that one expects it where it was).
            renamed(inode, inode.key === inode.origin ? key : inode.key, key, true);
            if (inode.lost)
                return;
            inode.unnamed = false;
            if (inode.state === null)
                inode.row = entry;
        },
        fsetattr: (handleId, change) => {
            const desc = descOf(handleId);
            const inode = desc.inode;
            const attrs = change;
            const syscall = isModeChange(attrs) ? 'fchmod' : isOwnerChange(attrs) ? 'fchown' : 'futimes';
            // The file it opened: through its description, wherever or whether a name leads to it; without one, by the name that still does.
            const described = desc.description ?? anchorOf(inode);
            if (described === undefined && !named(inode))
                throw fsError('ESTALE', syscall, desc.path);
            judgeAttrs(entryOf(inode), attrs, syscall, desc.path);
            const op = attrOp(attrs, host.now());
            host.drain();
            admitOps(inode, [op], syscall, desc.path);
            host.count(inode.key);
            // Through its description; without one, by the name that leads to its file, which it expects there.
            loggedOn([fold(inode, op, described)], { type: 'setattr', path: inode.key, attrs, ...(described === undefined ? expecting(entryOf(inode), inode.key) : { description: described }) });
            fit(inode);
        },
        abandon: (handleId) => {
            descOf(handleId).description = undefined;
            provisional.close(handleId);
        },
        close: (handleId) => {
            const desc = descOf(handleId);
            descs.delete(handleId);
            if (mapFind(descs, (other) => other === desc) !== undefined)
                return;
            const inode = desc.inode;
            inode.descs--;
            // Its description outlives it while another descriptor of the file stays open with none of its own (the file's anchor),
            // or while it names a file it made that the session has not numbered (made); the last closes it, once answered.
            if (desc.description !== undefined) {
                if ((inode.descs > 0 && inode.retained.length === 0 && anchorOf(inode) === undefined) || desc.description === inode.made) {
                    const retained = new SafeList();
                    for (let i = 0; i < inode.retained.length; i++)
                        retained[i] = inode.retained[i];
                    retained[retained.length] = desc.description;
                    inode.retained = retained;
                }
                else
                    logged({ type: 'call', call: { call: 'close', path: inode.key, description: desc.description } }, () => { });
            }
            closeRetained(inode);
            if (desc.description !== undefined && !arrayIncludes(inode.retained, desc.description))
                sessions.delete(desc.description);
            // A grant's file that lost its name goes with its last descriptor (POSIX: its last close).
            if (inode.descs === 0 && inode.cell?.detached !== undefined)
                setCell(inode, undefined);
            release(inode);
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
                // By its name, the file this descriptor names expected there.
                const open = { type: 'call', call: { call: 'open', path: inode.key, mode: entryOf(inode).mode & 0o7777, ...(flags.truncate ? { truncate: true } : {}), access: read ? 'readwrite' : 'write', description, ...expecting(entryOf(inode), inode.key) } };
                const records = flags.truncate ? [{ kind: 'truncate', size: 0, at: host.now() }] : [];
                host.drain();
                admitOps(inode, records, 'open', desc.path);
                inode.answers++;
                const made = new SafeList();
                for (let i = 0; i < records.length; i++)
                    made[i] = fold(inode, records[i], description);
                logged(open, openAnswered(inode, description, made, false, read));
                fit(inode);
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
        mkdir: (key, path, mode, row, mask, awaited) => {
            if (row === undefined || (mode & 0o7000) !== 0)
                return false;
            if (row !== null)
                throw fsError('EEXIST', 'mkdir', path);
            const parent = writableParent(key, path, 'mkdir');
            if (parent === undefined)
                return false;
            const umask = mask ?? host.umask();
            const perm = (mode & 0o777 & ~umask) | (ownership(parent).setgid ? 0o2000 : 0);
            host.drain();
            admit(madeCost(key) + nameCost([key]), 'mkdir', path);
            const inode = made(key, 'directory', 0o40000 | perm, parent);
            return loggedName({ type: 'call', call: { call: 'mkdir', path: key, mode: mode & 0o777, umask } }, [key], nameCost([key]), () => {
                place(key, inode);
                added.set(key, added.get(key) ?? new SafeMap());
            }, undefined, undefined, awaited) ?? true;
        },
        unlink: (key, path, row, awaited) => {
            if (row === undefined)
                return false;
            if (row === null)
                throw fsError('ENOENT', 'unlink', path);
            if (row.type === 'directory')
                return false;
            if (!removable(key, row, path, 'unlink'))
                return false;
            // Its descriptors keep what it holds: its bytes, where only the view has them, admitted for their lifetime first.
            host.drain();
            keepForDescriptors(inodeAtNumber(row.dev, row.ino), nameCost([key]), 'unlink', path);
            return loggedName({ type: 'call', call: { call: 'unlink', path: key, ...expecting(row, key) } }, [key], nameCost([key]), () => place(key, null), undefined, undefined, awaited) ?? true;
        },
        rmdir: (key, path, row, awaited) => {
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
            if (!removable(key, row, path, 'rmdir'))
                return false;
            host.drain();
            admit(nameCost([key]), 'rmdir', path);
            return loggedName({ type: 'call', call: { call: 'rmdir', path: key, ...expecting(row, key) } }, [key], nameCost([key]), () => {
                place(key, null);
                added.delete(key);
                removed.delete(key);
            }, undefined, undefined, awaited) ?? true;
        },
        symlink: (key, path, target, row, awaited) => {
            if (row === undefined)
                return false;
            if (row !== null)
                throw fsError('EEXIST', 'symlink', path);
            const parent = writableParent(key, path, 'symlink');
            if (parent === undefined)
                return false;
            host.drain();
            admit(madeCost(key, target) + nameCost([key]), 'symlink', path);
            const inode = made(key, 'symlink', 0o120777, parent, target);
            return loggedName({ type: 'call', call: { call: 'symlink', path: key, target } }, [key], nameCost([key]), () => place(key, inode), undefined, undefined, awaited) ?? true;
        },
        rename: (from, to, path, source, target, awaited) => {
            if (source === undefined || target === undefined)
                return false;
            if (source === null)
                throw fsError('ENOENT', 'rename', path);
            // rename(2) to the name it has leaves it as it is.
            if (from === to)
                return true;
            // A directory into its own subtree, and onto a directory the view lists non-empty, as rename(2) refuses them.
            if (source.type === 'directory' && within(to, from))
                throw fsError('EINVAL', 'rename', path);
            if (source.type === 'directory' && target !== null && target.type === 'directory') {
                const listed = provisional.children(to, host.children(to));
                if (listed !== undefined && listed.length > 0)
                    throw fsError('ENOTEMPTY', 'rename', path);
            }
            if (source.type === 'directory' && target !== null)
                return false;
            if (target !== null && target.type === 'directory')
                return false;
            if (!removable(from, source, path, 'rename') || (target === null ? writableParent(to, path, 'rename') === undefined : !removable(to, target, path, 'rename')))
                return false;
            // A file it replaces keeps, for its descriptors, what it holds: admitted first, with the record and the Inode it moves,
            // and what the names beneath the source grow by: their names here now, and the view's once it has the rename (retire).
            host.drain();
            const known = layer.get(from) ?? inodeAtNumber(source.dev, source.ino);
            const moves = known === undefined ? INODE_COST + 2 * stringCost(from) + 2 * stringCost(to) : 2 * stringCost(to);
            const beneath = new SafeMap();
            layer.forEach((value, key) => { if (value !== null && key !== from && within(key, from))
                beneath.set(value, mathMax(0, stringCost(to + stringSlice(key, from.length)) - stringCost(key))); });
            let viewGrowth = 0;
            const every = everyInode();
            for (let i = 0; i < every.length; i++)
                if (within(every[i].origin, from))
                    viewGrowth += mathMax(0, stringCost(to + stringSlice(every[i].origin, from.length)) - stringCost(every[i].origin));
            const names = nameCost([from, to]) + viewGrowth;
            let grown = 0;
            beneath.forEach((grows) => { grown += grows; });
            keepForDescriptors(target === null ? undefined : inodeAtNumber(target.dev, target.ino), names + moves + grown, 'rename', path);
            const moving = known ?? inodeAt(from, source);
            moving.reserved += moves;
            beneath.forEach((grows, inode) => { inode.reserved += grows; });
            const expectTo = ownValue(expecting(target, to), 'expect');
            const answer = loggedName({ type: 'rename', from, to, ...expecting(source, from), ...(expectTo === undefined ? {} : { expectTo }) }, [from, to], names, () => {
                // What is beneath the source moves with it: names, never records.
                const keys = mapKeyList(layer);
                const values = mapValueList(layer);
                for (let i = 0; i < keys.length; i++) {
                    const key = keys[i];
                    const value = values[i];
                    if (key === from || !within(key, from))
                        continue;
                    layer.delete(key);
                    const moved = to + stringSlice(key, from.length);
                    layer.set(moved, value);
                    if (value !== null)
                        renamed(value, moved, value.origin);
                }
                const moveAll = (map) => {
                    const at = mapKeyList(map);
                    const held = mapValueList(map);
                    for (let i = 0; i < at.length; i++)
                        if (within(at[i], from)) {
                            map.delete(at[i]);
                            map.set(to + stringSlice(at[i], from.length), held[i]);
                        }
                };
                moveAll(added);
                moveAll(removed);
                place(from, null);
                place(to, moving);
            }, undefined, () => {
                // The view has it moved: what was beneath the source starts beneath the destination (its growth the record's, given back first).
                const moved = everyInode();
                for (let i = 0; i < moved.length; i++) {
                    const inode = moved[i];
                    if (within(inode.origin, from))
                        renamed(inode, inode.key, to + stringSlice(inode.origin, from.length));
                }
            }, awaited);
            fit(moving);
            beneath.forEach((_grows, inode) => { fit(inode); });
            return answer ?? true;
        },
        setattr: (key, path, attrs, row, awaited, link = false) => {
            if (row === undefined)
                return false;
            // A link's own: its owner (lchown), or times it names (lutimes, which has no "now"); no mode (there is no lchmod).
            const own = link && row !== null && row.type === 'symlink';
            if (own && (isModeChange(attrs) || (isTimesChange(attrs) && (typeof attrs.atime !== 'number' || typeof attrs.mtime !== 'number'))))
                return false;
            const syscall = isModeChange(attrs) ? 'chmod' : isOwnerChange(attrs) ? (link ? 'lchown' : 'chown') : (link ? 'lutime' : 'utime');
            if (row === null)
                throw fsError('ENOENT', syscall, path);
            judgeAttrs(row, attrs, syscall, path);
            host.drain();
            const inode = layer.get(key) ?? inodeAt(key, row);
            const op = attrOp(attrs, host.now());
            try {
                admitOps(inode, [op], syscall, path);
            }
            catch (error) {
                release(inode);
                throw error;
            }
            host.count(key);
            const logged = !own ? { type: 'setattr', path: key, attrs, ...expecting(row, key) }
                : isOwnerChange(attrs) ? { type: 'call', call: { call: 'lchown', path: key, uid: attrs.uid, gid: attrs.gid } }
                    : { type: 'call', call: { call: 'lutimes', path: key, atime: attrs.atime, mtime: attrs.mtime } };
            const answer = loggedOn([fold(inode, op)], logged, awaited);
            fit(inode);
            return answer ?? true;
        },
        copyFile: (from, to, path, source, target, keepMode) => {
            // The source as the session's copy reads it: a file it may read, no set-id bit (the session's to judge).
            if (source.type !== 'file' || (source.mode & 0o7000) !== 0 || !modeAllows(source, 4, host.cred))
                return false;
            if (target !== null && target.type !== 'file')
                return false;
            // Read as any read here is: a file these decisions hold through them (bytesOf), any other as the store has it.
            // Not copied here: openToWrite takes the one snapshot.
            const own = inodeAtNumber(source.dev, source.ino);
            const held = own === undefined ? undefined : bytesOf(own, 'copyfile', path);
            const stored = own === undefined ? host.content(from, source.revision) : undefined;
            const data = held !== undefined ? bytesView(held.bytes, 0, held.size) : stored !== undefined && typedArrayByteLength(stored) === source.size ? stored : undefined;
            if (data === undefined)
                return false;
            const umask = host.umask();
            const asked = copiedPermissions(source.mode, false);
            const opened = target === null ? asked & ~umask : target.mode & 0o7777;
            const mode = keepMode ? copyfileMode(source.mode, typedArrayByteLength(data), host.cred.uid) : opened;
            return openToWrite(to, path, { write: true, create: true, truncate: true, mode: asked, umask }, target, data, true, keepMode ? mode : undefined) !== undefined;
        },
        content: (entry) => {
            if (table.size === 0)
                return undefined;
            const inode = inodeAtNumber(entry.dev, entry.ino);
            if (inode === undefined)
                return undefined;
            if (inode.state !== null)
                return inode.state.bytes === null ? undefined : owned(inode.state.bytes, inode.state.size);
            // Moved here by a rename the view does not have yet: its bytes are the view's at the name it has it at, not this name's.
            if (inode.key === inode.origin)
                return undefined;
            const seen = viewed(inode);
            return seen?.bytes === undefined ? undefined : owned(seen.bytes, seen.row.size);
        },
        barrierBegun: () => ++barriers,
        retire: (begun) => {
            // A name record answered before the barrier began is the view's now; one under a held subtree waits for it to be given back.
            const kept = new SafeList();
            for (let i = 0, count = nameRecords.length; i < count; i++) {
                const record = nameRecords[i];
                let stays = !record.answered || record.answeredAt >= begun;
                for (let j = 0; !stays && j < record.keys.length; j++)
                    stays = ownValue(host, 'unreported')?.(record.keys[j]) === true;
                if (stays) {
                    kept[kept.length] = record;
                    continue;
                }
                for (let j = 0; j < record.keys.length; j++)
                    host.settled(record.keys[j], record.over[j]);
                // What it kept goes back before what it leaves takes its share of it (a rename's names, grown beneath it).
                host.release(record.cost);
                if (record.retired !== undefined)
                    record.retired();
            }
            if (kept.length < nameRecords.length) {
                for (let i = 0; i < kept.length; i++)
                    nameRecords[i] = kept[i];
                nameRecords.length = kept.length;
                replay();
            }
            // The bytes the view may keep of what retires (keep), once what they held is given back.
            const keeping = new SafeList();
            // A grant's decides it (held): one given back stands until a barrier begun after its decisions were answered.
            const visiting = setList(loose);
            for (let v = 0; v < visiting.length; v++) {
                const inode = visiting[v];
                if (ownValue(host, 'unreported')?.(inode.key) === true)
                    continue;
                if (inode.heldAt !== undefined) {
                    if (inode.heldAt >= begun)
                        continue;
                    inode.heldAt = undefined;
                }
                // Its records answered before the barrier began are the view's now: it is the view's version with the rest folded over it.
                // One made here and never numbered (its creating open refused, or not answered yet) the view has nothing of: as a file no name leads to.
                let retired = NO_RECORDS;
                if (inode.records.length > 0) {
                    retired = new SafeList();
                    for (let i = 0; i < inode.records.length; i++)
                        if (inode.records[i].answered && inode.records[i].answeredAt < begun)
                            retired[retired.length] = inode.records[i];
                }
                if (retired.length === 0 && inode.records.length > 0)
                    continue;
                // Nothing of it pending and nothing open on it (a file given back, say): it goes, and the view is not asked what it is.
                if (inode.records.length === 0 && inode.descs === 0 && inode.answers === 0) {
                    inode.base = null;
                    inode.state = null;
                    touched.delete(inode);
                    fit(inode);
                    release(inode);
                    if (inodeAtNumber(inode.dev, inode.ino) !== inode)
                        continue;
                }
                // Bytes changed by what retires: what its descriptors read before (its pin) is not what it is.
                let rewritten = false;
                for (let i = 0; !rewritten && i < retired.length; i++)
                    rewritten = retired[i].op.kind === 'write' || retired[i].op.kind === 'append' || retired[i].op.kind === 'truncate';
                let seen = viewed(inode);
                // What its retired records did is the view's: the grant's decision of its name they fold over answers no more.
                if (retired.length > 0 && inode.over !== undefined) {
                    if (host.settled(inode.over.key, inode.over.generation))
                        seen = viewed(inode);
                    inode.over = undefined;
                }
                if (seen === undefined) {
                    // No name leads to it in the view: what it holds is what retired made of it, where its baseline's bytes can say so
                    // (else they stay records while a descriptor may still read them).
                    let carries = false;
                    for (let i = 0; !carries && i < retired.length; i++)
                        carries = payloadOf(retired[i].op) > 0;
                    if (inode.descs > 0 && inode.base !== null && inode.base.bytes === null && carries)
                        continue;
                    dropRecords(inode, setOfList(retired));
                    unshared(inode);
                    if (inode.base !== null)
                        for (let i = 0; i < retired.length; i++) {
                            const record = retired[i];
                            inode.base = applyOp(inode.base, record.op);
                        }
                    if (inode.records.length === 0 && inode.descs === 0) {
                        inode.base = null;
                        inode.state = null;
                    }
                }
                else if (inode.records.length === retired.length) {
                    // What it made of the bytes, whole, is the session's at the revision its last change was answered at:
                    // the view's still where its row is at that revision.
                    const last = retired[retired.length - 1];
                    if (rewritten && inode.state?.bytes && last.after !== undefined && seen.row.type === 'file' && seen.row.revision === last.after
                        && seen.row.size === inode.state.size && typedArrayByteLength(inode.state.bytes) >= inode.state.size) {
                        keeping[keeping.length] = [seen.name, seen.row, bytesView(inode.state.bytes, 0, inode.state.size)];
                    }
                    dropRecords(inode, setOfList(retired));
                    // A grant's decision of its name made since (a move above it) is newer than the view's answer: it stays, and takes what they made of the file.
                    inode.row = (retired.length > 0 ? host.absorb(seen.name, entryOf(inode)) : undefined) ?? seen.row;
                    // What its descriptors read last is what it made, at no revision the view named: theirs once no name leads to it (pin).
                    if (inode.descs > 0 && inode.state?.bytes)
                        inode.pin = { revision: null, bytes: bytesView(inode.state.bytes, 0, inode.state.size) };
                    else if (rewritten)
                        inode.pin = undefined;
                    inode.base = null;
                    inode.state = null;
                }
                else {
                    if (rewritten)
                        inode.pin = undefined;
                    dropRecords(inode, setOfList(retired));
                    let folded = inode.base;
                    for (let i = 0; folded !== null && i < retired.length; i++)
                        folded = applyOp(folded, retired[i].op);
                    const decision = folded === null ? undefined : host.absorb(seen.name, { ...seen.row, size: folded.size, mode: folded.mode, uid: folded.uid, gid: folded.gid, atime: folded.atime, mtime: folded.mtime, ctime: folded.ctime });
                    if (decision === undefined) {
                        inode.base = baseline(inode);
                    }
                    else {
                        inode.row = decision;
                        inode.base = folded;
                    }
                }
                if (inode.state === null) {
                    touched.delete(inode);
                }
                else {
                    refold(inode);
                }
                fit(inode);
                release(inode);
            }
            for (let i = 0; i < keeping.length; i++)
                ownValue(host, 'keep')?.(keeping[i][0], keeping[i][1], keeping[i][2]);
            activity();
        },
    };
    return provisional;
}
