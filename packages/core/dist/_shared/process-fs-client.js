/**
 * process-fs-client.ts — a process's filesystem mutations, sent to the
 * session as numbered calls in W7 waves (spike/delegation/MEMO.md, P4b).
 *
 * The one write path of a process: node's fs and a WASI program's syscalls
 * both log here. Each mutation is a syscall record (W7Call, rename,
 * truncate, setattr) the session applies with its own operation of that
 * name, its semantics and its refusals: nothing is an upsert, and nothing
 * makes a parent the program did not make.
 *
 * Intake is synchronous: an op takes the next place in the log and a copy
 * of its bytes in the turn it is made, so the log is program order across
 * every file. Waves carry the log in that order, one in flight at a time:
 * an op made while none is in flight goes out at the end of its turn (a
 * lone op is a wave of one), and whatever is made while a wave is out goes
 * in the next, up to W7's bounds. Only ops the process already answered,
 * in subtrees it holds, linger instead (LINGER_MS): they go with the next
 * op something waits on, since the session's commit of a wave holds every
 * answer it gives until it is durable.
 *
 * Every wave is numbered under the process's writer epoch (WaveSequence):
 * the session keeps the writer's cursor with each commit, so a wave whose
 * answer was lost is sent again (the lost-call policy, sendWaveAttempts)
 * and answered, never applied twice. A refused op is the session's answer:
 * the op is dropped and the log goes on from the next one. A caller that
 * awaits its op gets the errno; one the program was already told succeeded
 * (a synchronous call: `acknowledged`) is a durability failure, reported at
 * the next effect (takeFailures) and by settle(), which throws naming it.
 * An op whose fate the session cannot answer (its writer epoch gone, a
 * failure that is no verdict) is one too, and the ops after it are sent
 * under a new epoch.
 *
 * Grants (delegations): once a subtree has had GRANT_AFTER mutations, the
 * client takes it (the deepest directory holding them, never the root, a
 * home directory itself or a store the session refuses), and the runtime
 * decides the mutations there itself (holder(), number()): the program is
 * answered at once and the op is logged acknowledged. Nothing of the
 * process's is in flight while a grant is taken: a wave the session began
 * before the subtree was the process's would recall it from the process
 * itself. A recall is answered by sending the log (every op, in order) and
 * then saying so; a grant unused for its idle period is given back, and
 * every one at settle(). A process's calls hold all its delegations
 * (ProcessFiles' process view), so its waves name none. A subtree the
 * session refused is not asked for again.
 */
import { encodeWriteBatch } from '@nimbus-sh/platform/w7-frame.js';
import { WAVE_BYTES, WAVE_PATHS, WAVE_PATH_BYTES, openWaveEpoch, sendWaveAttempts, waveAttemptsOf } from '@nimbus-sh/platform/wave-writer.js';
import { WAVE_EPOCH_TTL_MS } from '@nimbus-sh/platform/lost-call.js';
import { classifyMessage } from '@nimbus-sh/platform/oom-classify.js';
import { utf8Length } from '@nimbus-sh/platform/utf8.js';
import { ownValue, promiseResolve, promiseThen, reflectGet, SafeSet, setFind } from './primordials.js';
import { SYSCALL_VERDICTS } from '../vfs/vfs-error.js';
import { parentKey } from '../vfs/path.js';
import { DELEGATION_RECALL_TIMEOUT_MS } from '../runtime/delegations.js';
import { memoryJournal } from './process-fs-journal.js';
export { journalSource, memoryJournal, sqlJournal } from './process-fs-journal.js';
/** The calls' answers (vfs-error.ts), as the write ledger spliced beside this client classifies what a program caught. */
export { SYSCALL_VERDICTS };
/** An op committed: the stat of the file its data call published, when it published one. */
/** What the session answers a change decided on a name that leads elsewhere now (sqlite-vfs expectAt, an O_NOFOLLOW open of a link). */
const ORPHANED_ERRNOS = new Set(['ENOENT', 'EEXIST', 'ELOOP', 'ENOTDIR']);
/**
 * A synchronous loop's bytes held unanswered at once, at most
 * (ProcessFsClientOptions.syncCapBytes): in a journal that outlives the
 * process (on disk, the heap holding a window of it), and in one that lives
 * in its heap.
 */
export const PROCESS_FS_SYNC_CAP_BYTES = 256 * 1024 * 1024;
export const PROCESS_FS_HEAP_SYNC_CAP_BYTES = 64 * 1024 * 1024;
/** Data bytes of unsent changes the heap holds (two waves' worth); past it, they are read back from the journal when sent. */
export const PROCESS_FS_HEAP_WINDOW_BYTES = 2 * WAVE_BYTES;
/**
 * The most a process holds acknowledged (told it succeeded) and not yet
 * answered by the session before a change in a held subtree stops being
 * decided here and waits for its own answer: two waves' worth of ops and
 * bytes. What a process killed mid-run can lose of what it decided is at
 * most this (its synchronous calls' own bytes are bounded by the sync cap).
 */
export const DECIDED_BACKLOG_OPS = 2 * WAVE_PATHS;
export const DECIDED_BACKLOG_BYTES = 2 * WAVE_BYTES;
/**
 * What a one-shot process (no store of its own) that ended abnormally (it
 * died, or was killed) says in its output, whatever it did: every change
 * ahead of an output it released, or a flush it finished, is in the session
 * (ProcessFsClient.effect, flush); any change it made after that may not be.
 * No count is promised: what it acknowledged and never sent the session
 * never saw. The subtrees it held are named apart (delegationOrphaned).
 */
export const UNSETTLED_END_NOTE = `[nimbus] the process ended abnormally: an unknown number of the changes it made `
    + `since it last produced output or flushed may be lost`;
/** `error`, said with UNSETTLED_END_NOTE: a one-shot's run that ended with changes it may have lost. */
export function unsettledEnd(error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
    return Object.assign(new Error(`${message}\n${UNSETTLED_END_NOTE}`, { cause: error }), { unsettled: true, ...(code === undefined ? {} : { code }) });
}
/** The note an ended run's error carries (unsettledEnd), as a line, or ''. */
export function unsettledNoteOf(error) {
    return typeof error === 'object' && error !== null && Reflect.get(error, 'unsettled') === true ? `${UNSETTLED_END_NOTE}\n` : '';
}
/** A data call's bytes per op: a larger one is sent as its first piece, then writes at offsets. */
const DATA_PIECE_BYTES = WAVE_BYTES;
const FOLD_BUFFER = Symbol('process-fs-fold-buffer');
/** The most subtrees one process holds at once; past it, two are widened to their common ancestor. */
export const MAX_DELEGATIONS_PER_PROCESS = 8;
/** Mutations in a subtree before the client takes it. */
export const GRANT_AFTER = 8;
/**
 * How long a change the process already answered (acknowledged, or decided
 * here) waits to be sent while the log holds only such changes in subtrees
 * it holds: it goes with the next change someone awaits, a flush, an effect
 * or a recall, or after this. While a wave is out, the session's commit of
 * it holds every answer the session gives, reads too, so a change sent the
 * moment it is logged makes the program's next read and its next awaited
 * change each wait out a commit. What sees the session without recalling
 * the subtree (the file tree, another process's watch) sees the change this
 * much later at most.
 */
export const LINGER_MS = 10;
/** `op` with the process's umask now, when it makes a name with a mode and names none (ProcessFsClientOptions.umask). */
function withUmaskOf(op, umask) {
    if (umask === undefined || op.type !== 'call')
        return op;
    const call = op.call;
    if ((call.call !== 'writeFile' && call.call !== 'appendFile' && call.call !== 'mkdir') || call.umask !== undefined)
        return op;
    const mask = umask();
    return mask === undefined ? op : { type: 'call', call: { ...call, umask: mask & 0o777 } };
}
/** A link's target, at most (PATH_MAX, as symlink(2) bounds it). */
const SYMLINK_TARGET_MAX = 4096;
/** A grant unused this long is given back. */
export const GRANT_IDLE_MS = 2_000;
/** Inode numbers a first grant of a subtree reserves; each renewal doubles it. */
const GRANT_INOS = 4096;
/** Storage bytes a grant reserves for what is decided under it. */
const GRANT_BYTES = 64 * 1024 * 1024;
/** How long one recall poll waits before asking again. */
const RECALL_POLL_MS = 20_000;
/**
 * A wave the session refused while it recalls a delegation (its error's
 * `recall`) goes again after the n-th wait (doubling to a second), for as
 * long as a recall may take (the session's DELEGATION_RECALL_TIMEOUT_MS) and
 * a second more; then its writes are lost (EIO).
 */
const recallWaitMs = (n) => Math.min(10 * 2 ** n, 1_000);
const WAVE_RECALL_BOUND_MS = DELEGATION_RECALL_TIMEOUT_MS + 1_000;
/** Where `key` stands to a grant held alone (not ended, closing or shared): 'held' at or beneath its root, 'above' an ancestor of it. */
function standingOf(grant, key) {
    if (grant.ended || grant.closing || grant.shared)
        return undefined;
    return within(key, grant.root) ? 'held' : within(grant.root, key) ? 'above' : undefined;
}
// A walk asks this of each name it reaches, after the program may have
// replaced String.prototype.startsWith: compared by index, no method asked.
function within(key, root) {
    if (root === '' || key === root)
        return true;
    if (key.length <= root.length || key[root.length] !== '/')
        return false;
    for (let i = 0; i < root.length; i++)
        if (key[i] !== root[i])
            return false;
    return true;
}
function commonAncestor(left, right) {
    const a = left.split('/');
    const b = right.split('/');
    const out = [];
    for (let index = 0; index < Math.min(a.length, b.length) && a[index] === b[index]; index++)
        out.push(a[index]);
    return out.join('/');
}
const GLOBAL_TIMERS = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
};
function pathsOf(op) {
    switch (op.type) {
        case 'call': return op.call.call === 'copyFile' ? [op.call.path, op.call.from] : [op.call.path];
        case 'rename': return [op.from, op.to];
        case 'truncate':
        case 'setattr': return [op.path];
    }
}
/** A storage key as W7 takes it: no leading or doubled slash, no `.` or `..`, not the root. */
function canonical(path) {
    return path !== '' && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..') && !path.includes('\0');
}
function nameOf(op) {
    return op.type === 'call' ? op.call.call : op.type;
}
function fsError(errno, message, path) {
    return Object.assign(new Error(message), { code: errno, path });
}
function isProcessGone(error) {
    return 'code' in error && error.code === 'ESRCH';
}
/** The open description a call writes through (W7Call description), if any. */
function descriptionOf(call) {
    return 'description' in call ? call.description : undefined;
}
function extended(call, data, buffer) {
    const size = call.data.byteLength + data.byteLength;
    if (buffer === null || buffer.byteLength < size) {
        buffer = new Uint8Array(Math.min(DATA_PIECE_BYTES, Math.max(size, (buffer?.byteLength ?? call.data.byteLength) * 2)));
        buffer.set(call.data);
    }
    buffer.set(data, call.data.byteLength);
    const joined = buffer.subarray(0, size);
    return { op: { type: 'call', call: { ...call, data: joined } }, buffer, append: joined.subarray(call.data.byteLength) };
}
/** How `next` folds into `last`: its bytes replace last's, extend them, or (null) it does not fold. */
function foldOf(last, next) {
    if (last.type !== 'call' || next.type !== 'call' || !('data' in last.call) || !('data' in next.call))
        return null;
    const a = last.call;
    const b = next.call;
    // Through one description only: another's access, or its file, may differ.
    if (a.path !== b.path || descriptionOf(a) !== descriptionOf(b) || a.data.byteLength + b.data.byteLength > DATA_PIECE_BYTES)
        return null;
    const inoOf = (call) => ('ino' in call ? call.ino : undefined);
    // The last write's file is made (or kept) by the first: its make wins, the bytes are the last's.
    if (b.call === 'writeFile' && inoOf(b) === undefined && (a.call === 'writeFile' || a.call === 'appendFile'))
        return 'replaces';
    if (b.call === 'appendFile' && inoOf(b) === undefined && (a.call === 'writeFile' || a.call === 'appendFile'))
        return 'extends';
    if (b.call === 'append' && a.call === 'append' && inoOf(a) === inoOf(b))
        return 'extends';
    if (b.call === 'write' && a.call === 'write' && inoOf(a) === inoOf(b) && a.offset + a.data.byteLength === b.offset)
        return 'extends';
    return null;
}
/**
 * `next` folded into `last`, the log's unsent tail, when it is the same
 * file's next bytes and nothing was logged between them: a whole write
 * replacing a whole write (its make, mode and number kept), an append
 * extending a write or an append, a positional write continuing one. As the
 * page cache folds them; null when it is not such a change, or the folded
 * bytes would pass a piece.
 */
function folded(last, next, buffer) {
    const fold = foldOf(last, next);
    if (fold === null)
        return null;
    const a = last.call;
    const b = next.call;
    if (fold === 'replaces')
        return { op: { type: 'call', call: { ...a, call: 'writeFile', data: b.data } }, buffer: null };
    return extended(a, b.data, buffer);
}
/**
 * A data call larger than a piece: its first piece as the call, the rest as
 * writes at their offsets, each through the call's own description (its
 * file, with the access its open decided).
 */
function pieces(op) {
    if (op.type !== 'call' || !('data' in op.call) || op.call.data.byteLength <= DATA_PIECE_BYTES)
        return [op];
    const call = op.call;
    const data = call.data;
    const out = [{ type: 'call', call: { ...call, data: data.subarray(0, DATA_PIECE_BYTES) } }];
    // An append's later pieces follow it at the end; the others at their offsets after the first.
    for (let at = DATA_PIECE_BYTES; at < data.byteLength; at += DATA_PIECE_BYTES) {
        const piece = data.subarray(at, Math.min(data.byteLength, at + DATA_PIECE_BYTES));
        const ino = 'ino' in call ? call.ino : undefined;
        const description = descriptionOf(call);
        const by = description === undefined ? {} : { description };
        out.push(call.call === 'append' || call.call === 'appendFile'
            ? { type: 'call', call: { call: 'append', path: call.path, ...(ino === undefined ? {} : { ino }), ...by, data: piece } }
            : { type: 'call', call: { call: 'write', path: call.path, ...(ino === undefined ? {} : { ino }), ...by, offset: (call.call === 'write' ? call.offset : 0) + at, data: piece } });
    }
    return out;
}
export function processFsClient(options) {
    const { session } = options;
    const timers = options.timers ?? GLOBAL_TIMERS;
    const now = options.now ?? Date.now;
    const journal = options.journal ?? memoryJournal();
    const syncCap = options.syncCapBytes ?? (journal.durable ? PROCESS_FS_SYNC_CAP_BYTES : PROCESS_FS_HEAP_SYNC_CAP_BYTES);
    /** Data bytes the heap holds of unsent entries: past a window, an entry's data is read back from the journal when sent. */
    let heapBytes = 0;
    /** Logged, not yet sent; the first ones may carry numbers from a wave they came back from. */
    const queue = [];
    let inFlight = null;
    let scheduled = false;
    let pendingBytes = 0;
    let pendingSyncBytes = 0;
    let pendingSyncOps = 0;
    /** The writer epoch the log is numbered under, when it was opened, and where its numbering starts (journal.number). */
    let epoch = null;
    let ack = 0;
    let wave = 0;
    /** The log's unanswered head a recall refused, since when, and how many times it went again (recallWaitMs). */
    let recalled = null;
    /** Writer epochs given up whose retirement the session has not answered yet (lostEpoch). */
    const retiring = [];
    const failures = [];
    let processGone = null;
    /** Entries logged, the last one answered (every one before it is), and the flushes waiting for a place in the log. */
    let logged = 0;
    let answered = 0;
    /** Waves the session answered ahead of their publication, and how many of them it has since said are published (`published`). */
    let heldWaves = 0;
    let publishedThrough = 0;
    /**
     * The session's revision as it last answered a wave with nothing of the
     * process's held for publication (its `revision`): every change of the
     * process's own it has answered is published at or before it, so a view
     * short of it may lack one (vouch). Past every revision once a change's
     * fate is unknown, or an answer does not say it. `ownHeld`: the last answer
     * came ahead of a publication (`held`), at a revision none has said yet.
     */
    let ownThrough = 0;
    let ownHeld = false;
    /**
     * The session told of a raw socket (rawSocket): every wave after it is
     * sent once it lands, and nothing is decided here from then on. Landed:
     * the session answered it, everything it held of the process's published.
     */
    let escaped = null;
    let escapeLanded = false;
    const marks = [];
    const counters = {
        ops: 0, waves: 0, resends: 0, epochs: 0, refused: 0, lost: 0, maxWaveOps: 0,
        grants: 0, grantsRefused: 0, recalls: 0, released: 0, widened: 0, renewed: 0, folded: 0,
        readLeases: 0, readConfirms: 0, readRecalls: 0, readReleased: 0,
    };
    const grantAfter = options.grantAfter ?? GRANT_AFTER;
    const grantIdleMs = options.grantIdleMs ?? GRANT_IDLE_MS;
    const recallPollMs = options.recallPollMs ?? RECALL_POLL_MS;
    const lingerMs = options.lingerMs ?? LINGER_MS;
    const grants = [];
    /** Mutations per candidate subtree not yet held; subtrees the session refused, and the range each was last given. */
    const mutations = new Map();
    const refusedRoots = new Set();
    const rangeOf = new Map();
    /** A grant being taken (no other is asked for meanwhile), and whether waves wait for it (while it is asked for). */
    let claiming = null;
    let paused = false;
    /** The session's drain owns the journal (seal): nothing more is sent. */
    let sealed = false;
    /** The wave in flight, settled once its answer is applied. */
    let sending = null;
    let idleTimer = null;
    /** Armed while what is unsent all lingers: sends it at the latest LINGER_MS after the first of it. */
    let lingerTimer = null;
    let settling = false;
    const settled = (entry) => {
        pendingBytes -= entry.bytes;
        if (entry.acknowledged) {
            pendingSyncBytes -= entry.bytes;
            pendingSyncOps--;
        }
        answered = Math.max(answered, entry.order);
        for (let at = marks.length - 1; at >= 0; at--) {
            if (marks[at].mark <= answered)
                marks.splice(at, 1)[0].resolve();
        }
    };
    /**
     * The descriptions whose open the session refused as orphaned: what was
     * made through one went to a file no name leads to (orphanedRefusal).
     */
    const orphanedDescriptions = new Set();
    /**
     * Whether the session refused `op` only because the name it was decided
     * on leads elsewhere now (a peer removed, replaced or swapped a link in at
     * it since: the file the process decided on, or none, is not there): on
     * Linux the process's call resolved first, and what it made went to a
     * file the peer's change left no name to. That is no error the program
     * sees. A change through a description such an open made is the same.
     */
    const orphanedRefusal = (op, errno) => {
        if (op === null || op.type !== 'call' && op.type !== 'rename' && op.type !== 'setattr')
            return false;
        if (op.type === 'call' && 'description' in op.call && op.call.description !== undefined && orphanedDescriptions.has(op.call.description))
            return true;
        const decided = op.type === 'rename' ? op.expect !== undefined || op.expectTo !== undefined
            : op.type === 'setattr' ? op.expect !== undefined
                : ('expect' in op.call && op.call.expect !== undefined) || (op.call.call === 'open' && op.call.nofollow === true);
        if (!decided || !ORPHANED_ERRNOS.has(errno))
            return false;
        if (op.type === 'call' && op.call.call === 'open' && op.call.description !== undefined)
            orphanedDescriptions.add(op.call.description);
        return true;
    };
    /**
     * `entry` failed: `refused` where the session never applied it (its
     * verdict, or it was never sent); else its fate is unknown. `op`: what it
     * logged, where the session's verdict names it.
     */
    const fail = (entry, errno, message, refused = false, op = null) => {
        settled(entry);
        const path = entry.paths[0] ?? '';
        if (entry.acknowledged) {
            if (!(refused && orphanedRefusal(op, errno)))
                failures.push({ op: entry.name, path, errno, message });
            entry.resolve({ failed: { errno, message, ...(refused ? { refused: true } : {}) } });
        }
        else {
            entry.reject(fsError(errno, message, path));
        }
    };
    /**
     * Drop the journal through `through`: what the session `applied` (or
     * refused, its verdict), always; anything else only while the journal is
     * the process's. It is the session's drain's once the process is sealed
     * (seal), or once the session ended it over a durable journal: the drain
     * sends what it holds, so nothing it did not take is forgotten here.
     */
    const forget = (through, applied) => {
        if (applied || !(sealed || (processGone !== null && journal.durable)))
            journal.dropThrough(through);
    };
    /** An entry's change: the heap's copy, or the journal's. */
    const opOf = (entry) => entry.op ?? journal.read(entry.jid);
    /**
     * The epoch `entries` (the next wave) are numbered under: a fresh one
     * before the first, and once half its life has passed with no entry
     * numbered under the last still unanswered. A fresh one numbers the log
     * from the first entry not yet numbered, recorded in the journal so a
     * drain sends each entry under the number it was given.
     */
    const retirePending = async () => {
        while (retiring.length > 0) {
            try {
                await session.retireWriter?.(retiring[0]);
            }
            catch (error) {
                if (processGone === null || !(error instanceof Error) || !isProcessGone(error))
                    throw error;
            }
            retiring.shift();
        }
    };
    const writerFor = async (entries) => {
        const numberedPending = entries.some((entry) => entry.seq !== 0) || queue.some((entry) => entry.seq !== 0);
        if (epoch !== null && (epoch.writer === null || numberedPending || now() - epoch.openedAt < WAVE_EPOCH_TTL_MS / 2))
            return epoch.writer;
        // An epoch given up is retired before anything else is sent (lostEpoch);
        // one the session cannot be told of yet is told before the next wave.
        await retirePending();
        const openedAt = now();
        const first = counters.epochs === 0;
        const writer = await openWaveEpoch(() => session.openWriter(first), { ...(options.retry === undefined ? {} : { retry: options.retry }), timers });
        epoch = { writer, openedAt, numbering: null };
        counters.epochs++;
        ack = 0;
        wave = 0;
        return writer;
    };
    /** Number `entries` under the epoch: from where its numbering starts, one each in journal order. */
    const numberEntries = (entries) => {
        const current = epoch;
        for (const entry of entries) {
            if (entry.seq !== 0)
                continue;
            if (current.numbering === null) {
                // Recorded first: a numbering the journal did not take is not the epoch's.
                const numbering = { writer: current.writer, seq: 1, jid: entry.jid };
                journal.number(numbering);
                current.numbering = numbering;
            }
            entry.seq = current.numbering.seq + (entry.jid - current.numbering.jid);
        }
    };
    /**
     * The ops of the next wave: in log order, up to W7's bounds, at least one,
     * and none logged after a flush that waits (its wave carries only what it
     * waits for, so it is answered in the time that takes).
     */
    const cut = () => {
        const limit = marks.reduce((least, waiting) => Math.min(least, waiting.mark), Infinity);
        const taken = [];
        const owned = new Set();
        let pathBytes = 0;
        let bytes = 0;
        while (queue.length > 0) {
            const next = queue[0];
            const fresh = next.paths.filter((path) => !owned.has(path));
            const freshBytes = fresh.reduce((sum, path) => sum + utf8Length(path), 0);
            if (taken.length > 0 && (next.order > limit || owned.size + fresh.length > WAVE_PATHS || pathBytes + freshBytes > WAVE_PATH_BYTES || bytes + next.bytes > WAVE_BYTES))
                break;
            for (const path of fresh)
                owned.add(path);
            pathBytes += freshBytes;
            bytes += next.bytes;
            taken.push(queue.shift());
        }
        return taken;
    };
    const send = async (entries) => {
        let writer;
        try {
            if (escaped !== null)
                await escaped;
            writer = await writerFor(entries);
        }
        catch (error) {
            if (error instanceof Error && classifyMessage(error.message) === 'subrequest_cap') {
                exhaustedInvocation(entries, error);
                return;
            }
            if (error instanceof Error && isProcessGone(error)) {
                endedProcess(entries, error, epoch?.writer ?? null);
                return;
            }
            for (const entry of entries)
                fail(entry, 'EIO', `the session gave this process no writer: ${error instanceof Error ? error.message : String(error)}`, true);
            forget(entries[entries.length - 1].jid, false);
            return;
        }
        let ops;
        let bytes;
        try {
            ops = entries.map(opOf);
            // Sent: the heap's copy is the wave's now.
            for (const entry of entries)
                if (entry.op !== null) {
                    heapBytes -= entry.bytes;
                    entry.op = null;
                    if (entry[FOLD_BUFFER] !== undefined)
                        entry[FOLD_BUFFER] = undefined;
                }
            bytes = await encodeWriteBatch({ inodes: [], chunks: [], ops });
            // Numbered once, under the epoch they are first sent under; a re-send keeps them.
            numberEntries(entries);
        }
        catch (error) {
            // Refused here, before any of it left (a log that cannot be read back,
            // an op no wave can carry): answered as refused, each one, never left waiting.
            const code = error?.code;
            const errno = typeof code === 'string' && /^E[A-Z0-9]+$/.test(code) ? code : 'EIO';
            for (const entry of entries)
                fail(entry, errno, `this write could not be sent: ${error instanceof Error ? error.message : String(error)}`, true);
            forget(entries[entries.length - 1].jid, false);
            // An epoch numbers ops by their place in the log: dropped, these leave
            // a gap the session would refuse what follows for. What follows is
            // numbered under a new epoch (nothing of this wave left, and what the
            // old one sent was answered, so it has nothing to retire).
            epoch = null;
            for (const entry of queue)
                entry.seq = 0;
            return;
        }
        const firstSeq = entries[0].seq;
        counters.waves++;
        counters.maxWaveOps = Math.max(counters.maxWaveOps, entries.length);
        wave++;
        let result;
        try {
            result = await sendWaveAttempts({
                supervisor: session,
                writer: async () => writer,
                open: waveAttemptsOf(bytes),
                streamed: false,
                wave,
                ...(writer === null ? {} : { sequence: { seq: firstSeq, ack } }),
                ...(options.retry === undefined ? {} : { retry: options.retry }),
                resent: () => { counters.resends++; },
                timers,
            });
        }
        catch (error) {
            // Lost past every re-send, or refused before any op (the epoch gone): their fate is unknown.
            if (error instanceof Error && classifyMessage(error.message) === 'subrequest_cap') {
                exhaustedInvocation(entries, error);
                return;
            }
            if (error instanceof Error && isProcessGone(error)) {
                endedProcess(entries, error, writer);
                return;
            }
            lostEpoch(entries, `the session did not answer this write: ${error instanceof Error ? error.message : String(error)}`, writer);
            return;
        }
        // The session's own answer (WaveIngest's, through the binding).
        const answer = result;
        const error = answer.ok ? null : answer.error;
        // Unfenced, the session numbers nothing: committedOps says how far it went.
        const cursor = writer === null ? firstSeq - 1 + (answer.ok ? entries.length : answer.committedOps) : answer.sequence?.cursor;
        if (cursor === undefined) {
            lostEpoch(entries, `the session answered this write without its cursor: ${error?.message ?? 'no error'}`, writer);
            return;
        }
        ack = Math.max(ack, cursor);
        ownHeld = answer.held === true;
        if (!ownHeld)
            ownThrough = Math.max(ownThrough, answer.revision ?? Infinity);
        // The session met a delegation it recalls first (one this process holds
        // too: its read lease, asked with a directory batch whose answer has not
        // reached it) and applied nothing after `cursor`: the recall started,
        // the rest goes again once it is over, as a caller that can wait does.
        const recalling = error?.recall === true;
        const refused = recalling ? null : writer === null
            ? (error?.errno !== undefined && SYSCALL_VERDICTS.has(error.errno) ? { seq: cursor + 1, errno: error.errno, message: error.message } : null)
            : answer.sequence?.refused ?? null;
        let receipt = 0;
        const back = [];
        const mutations = new Map((answer.mutations ?? []).map((mutation) => [mutation.index, mutation]));
        if (answer.held === true)
            heldWaves++;
        for (const [index, entry] of entries.entries()) {
            if (refused !== null && entry.seq === refused.seq) {
                counters.refused++;
                fail(entry, refused.errno, refused.message, true, ops[index] ?? null);
                if (writer === null)
                    ack = Math.max(ack, entry.seq);
                continue;
            }
            if (entry.seq <= cursor) {
                settled(entry);
                let answered = {};
                const op = ops[index];
                // A data call's, an open's and a copy's answer is the session's stat of its file.
                const path = op.type === 'call' && ('data' in op.call || op.call.call === 'open' || op.call.call === 'copyFile') ? op.call.path : null;
                const published = answer.receipts[receipt];
                if (path !== null && published?.path === path) {
                    receipt++;
                    const { path: _path, ...stat } = published;
                    answered = { receipt: stat };
                }
                const mutation = mutations.get(index);
                if (mutation !== undefined)
                    answered.mutation = { before: mutation.before, after: mutation.after };
                entry.resolve(answered);
                continue;
            }
            back.push(entry);
        }
        // What was answered is forgotten: a prefix of the log (waves are cut in order).
        const answeredThrough = back.length === 0 ? entries[entries.length - 1].jid : back[0].jid - 1;
        if (answeredThrough >= entries[0].jid)
            forget(answeredThrough, true);
        if (back.length === 0) {
            recalled = null;
            return;
        }
        // A recall's budget is the head's: it starts again once the head moves.
        if (recalling && recalled?.jid !== back[0].jid)
            recalled = { jid: back[0].jid, since: now(), waits: 0 };
        if (!recalling)
            recalled = null;
        if (answer.ok || refused !== null || (recalled !== null && now() - recalled.since < WAVE_RECALL_BOUND_MS)) {
            // After a refusal, nothing more in the wave was applied: they go again, first, as numbered.
            for (const entry of back)
                entry.lingers = false;
            queue.unshift(...back);
            if (recalled !== null)
                await new Promise((resolve) => { timers.setTimeout(resolve, recallWaitMs(recalled.waits++)); });
            return;
        }
        recalled = null;
        lostEpoch(back, `the session could not apply this write: ${error?.message ?? 'no error'}`, writer);
    };
    /**
     * Ops whose fate the session cannot answer: failures, and the epoch they
     * were numbered under is given up, so the ops after them are numbered
     * under a new one (the session would refuse them as a gap). The session
     * retires it before the new one opens (retiring): an attempt of it still
     * on its way is refused when it arrives, instead of landing after, and
     * over, what the new epoch sends.
     */
    const lostEpoch = (entries, message, writer) => {
        for (const entry of entries) {
            counters.lost++;
            // A caller that awaited it is told, and its fate is a durability failure besides, caught or not.
            if (!entry.acknowledged)
                failures.push({ op: entry.name, path: entry.paths[0] ?? '', errno: 'EIO', message });
            fail(entry, 'EIO', message);
        }
        forget(entries[entries.length - 1].jid, false);
        if (writer !== null)
            retiring.push(writer);
        epoch = null;
        ownThrough = Infinity;
        for (const entry of queue)
            entry.seq = 0;
    };
    /**
     * The session ended the process: what it logged is refused, and its
     * waiters told so. A durable journal keeps it for the session's drain
     * (forget: what the process was told it wrote outlives it, as write(2)'s
     * does); any other forgets it.
     */
    const endedProcess = (entries, refusal, writer) => {
        processGone ??= refusal;
        const ended = [...entries, ...queue.splice(0)];
        for (const entry of ended) {
            if (entry.op !== null) {
                heapBytes -= entry.bytes;
                entry.op = null;
                if (entry[FOLD_BUFFER] !== undefined)
                    entry[FOLD_BUFFER] = undefined;
            }
            fail(entry, 'ESRCH', processGone.message);
        }
        forget(ended[ended.length - 1].jid, false);
        if (writer !== null)
            retiring.push(writer);
        epoch = null;
        ownThrough = Infinity;
    };
    const exhaustedInvocation = (entries, refusal) => {
        processGone ??= fsError('EIO', refusal.message, '');
        const stopped = [...entries, ...queue.splice(0)];
        for (const entry of stopped) {
            if (entry.op !== null) {
                heapBytes -= entry.bytes;
                entry.op = null;
                if (entry[FOLD_BUFFER] !== undefined)
                    entry[FOLD_BUFFER] = undefined;
            }
            fail(entry, 'EIO', refusal.message);
        }
        forget(stopped[stopped.length - 1].jid, false);
        epoch = null;
        ownThrough = Infinity;
    };
    const pump = () => {
        scheduled = false;
        if (inFlight !== null || paused || sealed)
            return;
        if (queue.length === 0)
            return;
        if (marks.length === 0 && queue.every((entry) => entry.lingers)) {
            lingerTimer ??= timers.setTimeout(() => {
                lingerTimer = null;
                client.hurry();
            }, lingerMs);
            return;
        }
        const entries = cut();
        if (queue.length === 0 && lingerTimer !== null) {
            timers.clearTimeout(lingerTimer);
            lingerTimer = null;
        }
        inFlight = entries;
        sending = send(entries).finally(() => {
            inFlight = null;
            sending = null;
            pump();
        });
    };
    /** submit's body: `op` logged (folded, or queued), its answer; with `foldOnly`, undefined and nothing logged where it does not fold. */
    const entered = (given, submitOptions, foldOnly) => {
        const acknowledged = submitOptions?.acknowledged === true;
        if (processGone !== null && !(sealed && (acknowledged || submitOptions?.decided === true)))
            throw processGone;
        const op = withUmaskOf(given, options.umask);
        const named = pathsOf(op);
        const lingers = (acknowledged || submitOptions?.decided === true) && named.every((path) => heldGrant(path) !== undefined);
        for (const path of named)
            if (!canonical(path))
                throw fsError('EINVAL', `EINVAL: not a filesystem path the session takes: '${path}'`, path);
        // A link's target past PATH_MAX is refused here, as symlink(2) refuses it; no wave could carry it.
        if (op.type === 'call' && op.call.call === 'symlink' && utf8Length(op.call.target) > SYMLINK_TARGET_MAX) {
            throw fsError('ENAMETOOLONG', `ENAMETOOLONG: a link's target is at most ${SYMLINK_TARGET_MAX} bytes`, op.call.path);
        }
        const parts = pieces(op);
        const bytes = parts.reduce((sum, part) => sum + (part.type === 'call' && 'data' in part.call ? part.call.data.byteLength : 0), 0);
        if (acknowledged && !sealed && pendingSyncBytes + bytes > syncCap)
            throw syncCapRefusal(bytes, pathsOf(op)[0] ?? '');
        // The same file's next bytes, right after its last unsent change: folded into it.
        const tail = foldTail(parts, named, acknowledged);
        const merged = tail !== undefined ? folded(tail.op, parts[0], tail[FOLD_BUFFER] ?? null) : null;
        if (merged !== null && tail !== undefined) {
            const mergedBytes = merged.op.type === 'call' && 'data' in merged.op.call ? merged.op.call.data.byteLength : 0;
            journal.replace(tail.jid, merged.op, merged.append);
            const grown = mergedBytes - tail.bytes;
            tail.op = merged.op;
            if (merged.buffer !== null || tail[FOLD_BUFFER] !== undefined)
                tail[FOLD_BUFFER] = merged.buffer ?? undefined;
            tail.bytes = mergedBytes;
            // Someone waits on the fold now: what lingered goes.
            if (tail.lingers && !lingers) {
                tail.lingers = false;
                schedule();
            }
            heapBytes += grown;
            pendingBytes += grown;
            if (acknowledged)
                pendingSyncBytes += grown;
            counters.ops++;
            counters.folded++;
            options.logged?.(op);
            return tail.answer;
        }
        if (foldOnly)
            return undefined;
        options.logged?.(op);
        const answers = parts.map((part) => {
            let entry;
            const answer = new Promise((resolve, reject) => {
                const partBytes = part.type === 'call' && 'data' in part.call ? part.call.data.byteLength : 0;
                // Logged where the process's death does not reach, before it is told anything.
                const jid = journal.append(part);
                // The heap keeps a window of what is unsent; the rest is read back from the journal.
                const kept = !journal.durable || heapBytes + partBytes <= PROCESS_FS_HEAP_WINDOW_BYTES;
                if (kept)
                    heapBytes += partBytes;
                entry = { op: kept ? part : null, jid, name: nameOf(part), seq: 0, order: ++logged, bytes: partBytes, paths: pathsOf(part), acknowledged, lingers, resolve, reject, answer: null };
                queue.push(entry);
                pendingBytes += partBytes;
                if (acknowledged) {
                    pendingSyncBytes += partBytes;
                    pendingSyncOps++;
                }
                counters.ops++;
            });
            // Undefined where the journal refused it: nothing was queued, and the answer is that refusal.
            if (entry !== undefined)
                entry.answer = answer;
            return { entry, answer };
        });
        schedule();
        // A piece failed fails the call; its last piece's receipt answers it,
        // and its mutation spans them all.
        const answer = Promise.all(answers.map((piece) => piece.answer)).then((all) => {
            const first = all[0]?.mutation;
            const last = all[all.length - 1];
            if (last === undefined)
                return {};
            // An acknowledged piece failed: the call's failure (reported once, by the client). Refused,
            // never applied, only where every piece was: one applied or of unknown fate leaves the call's unknown.
            const failures = all.filter((piece) => piece.failed !== undefined);
            if (failures.length > 0) {
                const { errno, message } = failures[0].failed;
                return { failed: failures.length === all.length && failures.every((piece) => piece.failed.refused === true) ? { errno, message, refused: true } : { errno, message } };
            }
            const { mutation: _mutation, ...rest } = last;
            return first !== undefined && last.mutation !== undefined ? { ...rest, mutation: { before: first.before, after: last.mutation.after } } : rest;
        });
        if (acknowledged)
            answer.catch(() => { });
        // A one-piece call's entry gives an op folded into it the call's own answer: the same, at the same turn.
        const only = answers.length === 1 ? answers[0].entry : undefined;
        if (only !== undefined)
            only.answer = answer;
        return answer;
    };
    /** The last unsent change `parts` (one op's) may fold into: one piece, its file's, sent never (one back for a re-send is numbered), logged alike. */
    const foldTail = (parts, named, acknowledged) => {
        const tail = queue[queue.length - 1];
        return parts.length === 1 && tail !== undefined && tail.paths[0] === named[0] && tail.seq === 0 && tail.op !== null && tail.acknowledged === acknowledged ? tail : undefined;
    };
    const schedule = () => {
        if (scheduled || inFlight !== null || paused || sealed)
            return;
        scheduled = true;
        queueMicrotask(pump);
    };
    /** Resolves once no wave is in flight (none starts while `paused`). */
    const quiet = async () => {
        while (sending !== null)
            await sending;
    };
    const live = () => grants.filter((grant) => !grant.ended);
    const allowedRoot = (root) => root !== '' && !(options.isHomeRoot?.(root) ?? false);
    /**
     * Give `grant` back: nothing more is decided under it from now, what was
     * (numbered from its range) is sent, then it is released, so no op names a
     * number of a lease the session no longer holds. Where what was decided
     * there cannot be logged yet (freezing refused), it is not given back: it
     * stays as it was (held, or closing for whoever set that), its bytes the
     * runtime's, and the next flush (a sync, the settle at the run's end)
     * reports the refusal (false). One close at a time: a second joins it.
     */
    const close = (grant) => {
        if (grant.closed !== undefined)
            return grant.closed;
        const wasClosing = grant.closing;
        grant.closing = true;
        try {
            options.freezing?.(grant.root);
        }
        catch {
            grant.closing = wasClosing;
            return Promise.resolve(false);
        }
        grant.closed = (async () => {
            await client.flush();
            await end(grant);
            return true;
        })();
        return grant.closed;
    };
    /** Release `grant` (its log already sent: close). */
    const end = async (grant) => {
        if (grant.ended)
            return;
        grant.ended = true;
        const at = grants.indexOf(grant);
        if (at >= 0)
            grants.splice(at, 1);
        counters.released++;
        options.released?.(grant.root);
        try {
            await session.grants?.release(grant.owner);
        }
        catch {
            // Already ended by the session (revoked, or the process is ending).
        }
    };
    /** A grant's recalls, for as long as it lasts: send the log, then do what was asked. */
    const answerRecalls = async (grant) => {
        const port = session.grants;
        while (!grant.ended) {
            let kind;
            try {
                kind = await port.awaitRecall(grant.owner, recallPollMs);
            }
            catch {
                // ESTALE: the session ended it (revoked for an unanswered recall, or the process is ending).
                if (!grant.ended) {
                    grant.ended = true;
                    const at = grants.indexOf(grant);
                    if (at >= 0)
                        grants.splice(at, 1);
                    options.released?.(grant.root);
                }
                return;
            }
            if (kind === null || grant.ended)
                continue;
            counters.recalls++;
            // Frozen first: nothing more is decided under it, so the prefix the
            // flush sends is everything decided before the recall, and what the
            // process does there from now on goes to the session as anyone's.
            const wasClosing = grant.closing;
            grant.closing = true;
            options.freezing?.(grant.root);
            await client.flush();
            if (kind === 'share') {
                grant.shared = true;
                grant.closing = wasClosing;
                options.released?.(grant.root);
            }
            try {
                await port.recalled(grant.owner, kind);
            }
            catch {
                // Ended meanwhile.
            }
            if (kind === 'revoke') {
                grant.ended = true;
                const at = grants.indexOf(grant);
                if (at >= 0)
                    grants.splice(at, 1);
                options.released?.(grant.root);
                return;
            }
        }
    };
    /**
     * The read lease (readLeaseAnswered): its owner, until when it is trusted
     * (readLeased), when an answer last confirmed it, and the log the barrier
     * that applied one asked at.
     * Untrusted the moment its recall arrives, before the session is told
     * (answerReadRecalls), and while the process has logged since.
     */
    let readLease = null;
    /**
     * Read leases recalled or given back: never trusted again. A barrier's
     * answer that confirmed one can arrive after its recall was answered (the
     * session confirmed it, then a writer recalled it), and trusting it then
     * would read past a change published since.
     */
    const endedReadLeases = new SafeSet();
    const endReadLease = (owner) => {
        endedReadLeases.add(owner);
        // Owners are never reused; the oldest are forgotten past a bound.
        if (endedReadLeases.size > 64)
            endedReadLeases.delete(setFind(endedReadLeases, () => true));
        if (readLease?.owner === owner)
            readLease = null;
    };
    /** Give read lease `owner` back (idle, or the run ending): the session's recall of it waits on no one. */
    const giveBackReadLease = async (owner) => {
        endReadLease(owner);
        counters.readReleased++;
        const port = reflectGet(session, 'grants');
        await (port === undefined ? undefined : promiseThen(promiseResolve(port.release(owner)), undefined, () => { }));
    };
    /** The run ended (settle): it takes no read lease again. */
    let runEnded = false;
    /**
     * The read lease's recalls, for as long as it is the process's: each poll
     * that comes back empty while no barrier confirmed it gives it back (it is
     * idle, and holds a poll open for nothing).
     */
    const answerReadRecalls = async (owner) => {
        const port = reflectGet(session, 'grants');
        for (;;) {
            const polled = now();
            let kind;
            try {
                kind = await port.awaitRecall(owner, recallPollMs);
            }
            catch {
                // Ended by the session (released, or the process is ending).
                endReadLease(owner);
                return;
            }
            if (readLease?.owner !== owner)
                return;
            if (kind === null) {
                if (readLease.confirmedAt < polled) {
                    await giveBackReadLease(owner);
                    return;
                }
                continue;
            }
            // Untrusted first: a barrier from now on asks, and only then is the
            // session told, so the change it waits to publish is one every later
            // barrier of this process sees.
            endReadLease(owner);
            counters.readRecalls++;
            // The log first, as a grant's recall sends it: what this process decided before the recall is the session's before the change the recall waits for.
            await promiseThen(client.flush(), undefined, () => { });
            try {
                await port.recalled(owner, kind);
            }
            catch {
                // Ended meanwhile.
            }
            return;
        }
    };
    /** Give back every grant unused for the idle period; armed while any is held. */
    const armIdle = () => {
        if (idleTimer !== null || live().length === 0)
            return;
        idleTimer = timers.setTimeout(() => {
            idleTimer = null;
            const idle = live().filter((grant) => !grant.closing && now() - grant.lastUsed >= grantIdleMs);
            if (idle.length === 0 || settling) {
                armIdle();
                return;
            }
            void Promise.all(idle.map(close)).then(armIdle);
        }, grantIdleMs);
    };
    /**
     * Take `root`: once nothing of the process's is in flight, ask the
     * session for it, numbering from a range twice the last one it gave this
     * subtree. Past MAX_DELEGATIONS_PER_PROCESS, the nearest grant and this
     * subtree become their common ancestor (when that may be taken).
     */
    const claim = (root) => {
        const port = session.grants;
        if (port === undefined || claiming !== null || settling)
            return;
        claiming = (async () => {
            let target = root;
            const held = live();
            if (held.length >= MAX_DELEGATIONS_PER_PROCESS) {
                let best = '';
                for (const grant of held) {
                    const shared = commonAncestor(grant.root, root);
                    if (shared.length > best.length)
                        best = shared;
                }
                if (!allowedRoot(best))
                    return;
                target = best;
            }
            // What the process holds under the new root is given back first: a lease never overlaps another of its own.
            // Its own grant of the same root among them: a renewal, with a range twice as large.
            const covered = live().filter((grant) => within(grant.root, target));
            if (covered.length > 0) {
                // One not given back stays held: no lease is taken over it.
                if (!(await Promise.all(covered.map(close))).every(Boolean))
                    return;
                if (covered.some((grant) => grant.root !== target))
                    counters.widened++;
                else
                    counters.renewed++;
            }
            // What was logged lands first (the directory may be one of its own mkdirs).
            await client.flush();
            paused = true;
            await quiet();
            const inos = rangeOf.has(target) ? rangeOf.get(target) * 2 : (options.grantInos ?? GRANT_INOS);
            let granted;
            try {
                granted = await port.acquire('/' + target, { reads: true, inos, bytes: GRANT_BYTES });
            }
            catch (error) {
                // EBUSY (another's lease), EPERM (the session's own), ENOSPC: the
                // session decides there, from now on. A directory not there (yet) may be asked for again.
                if (error?.code !== 'ENOENT')
                    refusedRoots.add(target);
                counters.grantsRefused++;
                return;
            }
            rangeOf.set(target, inos);
            const grant = {
                root: granted.root,
                owner: granted.owner,
                umask: granted.umask ?? 0o022,
                confined: granted.confined === true,
                ...(granted.certificate === undefined ? {} : { certificate: granted.certificate }),
                nextIno: granted.inos?.first ?? 0,
                endIno: granted.inos?.end ?? 0,
                inos,
                bytesLeft: granted.bytes ?? 0,
                shared: false,
                closing: false,
                ended: false,
                lastUsed: now(),
            };
            grants.push(grant);
            counters.grants++;
            void answerRecalls(grant);
            armIdle();
        })().finally(() => {
            claiming = null;
            paused = false;
            for (const key of [...mutations.keys()])
                if (within(key, root) || within(root, key))
                    mutations.delete(key);
            schedule();
        });
    };
    // A process with a raw socket decides nothing here: what it awaits is the
    // session's answer, which comes once it is published.
    const heldGrant = (key) => {
        if (escaped !== null)
            return undefined;
        for (let i = 0; i < grants.length; i++) {
            const grant = grants[i];
            if (!grant.ended && !grant.closing && !grant.shared && within(key, grant.root))
                return grant;
        }
        return undefined;
    };
    /** What refuses `bytes` more of synchronous writes past the cap the client holds unanswered. */
    const syncCapRefusal = (bytes, path) => fsError('ENOMEM', `ENOMEM: ${pendingSyncBytes} bytes of synchronous writes are waiting for the session, and this one (${bytes}) would pass the ${syncCap}-byte cap; let the program yield (an await) for them to be sent`, path);
    const client = {
        holder(key) {
            const held = heldGrant(key);
            if (held !== undefined) {
                // Decided here only while what it was told succeeded and the session
                // has not answered stays under the backlog bound; past it, the change
                // waits for its own answer (and so for the backlog's).
                if (pendingSyncOps >= DECIDED_BACKLOG_OPS || pendingSyncBytes >= DECIDED_BACKLOG_BYTES)
                    return undefined;
                held.lastUsed = now();
                return held;
            }
            if (session.grants === undefined || settling || escaped !== null)
                return undefined;
            // Shared, or another's: the session decides; a subtree it refused is not asked for again.
            if (grants.some((grant) => !grant.ended && within(key, grant.root)))
                return undefined;
            // Counted at each directory above it: the deepest one that has had
            // GRANT_AFTER mutations is taken (a loop writing across many
            // directories of one tree takes the tree, not each directory).
            let deepest;
            for (let root = parentKey(key); allowedRoot(root); root = parentKey(root)) {
                if ([...refusedRoots].some((refused) => within(root, refused)))
                    break;
                const seen = (mutations.get(root) ?? 0) + 1;
                mutations.set(root, seen);
                if (seen >= grantAfter && deepest === undefined)
                    deepest = root;
            }
            if (deepest !== undefined)
                claim(deepest);
            return undefined;
        },
        number(grant) {
            const held = grant;
            if (held.ended || held.closing || held.nextIno >= held.endIno)
                return undefined;
            // A quarter of its range left: renewed (given back and taken again,
            // its range doubled) while the rest is used. Asked once this turn's
            // decision has its name (its maker logs it before the grant closes).
            if (held.endIno - held.nextIno <= held.inos / 4)
                queueMicrotask(() => claim(held.root));
            return held.nextIno++;
        },
        draw(grant, bytes) {
            const held = grant;
            if (held.ended || held.bytesLeft < bytes)
                return false;
            held.bytesLeft -= bytes;
            return true;
        },
        held(key) {
            return heldGrant(key);
        },
        holds(key) {
            return grants.some((grant) => !grant.ended && within(key, grant.root));
        },
        vouch(key, root) {
            if (client.pending() || ownHeld || root.cursor < ownThrough)
                return undefined;
            return client.certifies(key, root);
        },
        certifies(key, root) {
            if (escaped !== null)
                return undefined;
            let found;
            for (let i = 0; i < grants.length; i++) {
                const grant = grants[i];
                const certificate = ownValue(grant, 'certificate');
                if (certificate === undefined || certificate.epoch !== root.epoch || root.cursor < certificate.revision)
                    continue;
                const standing = standingOf(grant, key);
                if (standing === 'held')
                    return standing;
                found ??= standing;
            }
            return found;
        },
        guards(key) {
            if (escaped !== null)
                return false;
            for (let i = 0; i < grants.length; i++) {
                const grant = grants[i];
                if (grant !== undefined && standingOf(grant, key) !== undefined)
                    return true;
            }
            return false;
        },
        pending() {
            return queue.length > 0 || inFlight !== null;
        },
        fitsSync(bytes, path) {
            if (!sealed && pendingSyncBytes + bytes > syncCap)
                throw syncCapRefusal(bytes, path);
        },
        submit(given, submitOptions) {
            return entered(given, submitOptions, false);
        },
        fold(given, submitOptions) {
            return entered(given, submitOptions, true);
        },
        hurry() {
            for (const entry of queue)
                entry.lingers = false;
            schedule();
        },
        seal() {
            sealed = true;
            if (lingerTimer !== null) {
                timers.clearTimeout(lingerTimer);
                lingerTimer = null;
            }
        },
        flush() {
            options.drain?.();
            const mark = logged;
            const flushed = answered >= mark ? Promise.resolve() : new Promise((resolve) => { marks.push({ mark, resolve }); });
            schedule();
            return flushed.then(async () => {
                if (processGone === null)
                    return;
                await retirePending().catch(() => { });
                throw processGone;
            });
        },
        effect() {
            if (processGone !== null)
                return null;
            options.drain?.();
            return answered >= logged ? null : client.flush();
        },
        published() {
            const ask = options.session.published;
            if (processGone !== null || ask === undefined || publishedThrough === heldWaves)
                return null;
            const through = heldWaves;
            return ask.call(options.session, false).then(() => {
                if (publishedThrough < through)
                    publishedThrough = through;
            });
        },
        rawSocket() {
            const ask = options.session.published;
            if (processGone !== null)
                return Promise.reject(processGone);
            if (ask === undefined)
                return null;
            if (escaped === null) {
                // Its answer is the session's word on what it holds of the process's,
                // this client's waves and what it never saw (its launch's writes) alike.
                const through = heldWaves;
                escaped = ask.call(options.session, true).then(() => {
                    escapeLanded = true;
                    publishedThrough = Math.max(publishedThrough, through);
                });
                // Not told, no socket opens, and every write after it fails (send) rather than be answered ahead of its publication.
                escaped.catch(() => { });
            }
            const logged = client.effect();
            if (escapeLanded && logged === null)
                return client.published();
            return Promise.all([escaped, logged]).then(() => client.published() ?? undefined);
        },
        async settle() {
            settling = true;
            runEnded = true;
            // Given back before the run is over, so a writer after it never waits
            // on its trust; not waited for: its answer tells the run nothing (it
            // is the session's to end with the process anyway), and what the
            // process says next reaches the session after it.
            if (readLease !== null)
                void giveBackReadLease(readLease.owner);
            if (claiming !== null)
                await claiming;
            try {
                // Until nothing more is logged (a flush's drain may log more).
                while (answered < logged)
                    await client.flush();
            }
            finally {
                if (idleTimer !== null) {
                    timers.clearTimeout(idleTimer);
                    idleTimer = null;
                }
                // Each grant closed, its log sent with the rest; its release, as the
                // read lease's, is sent and not waited for.
                for (const grant of live()) {
                    grant.closing = true;
                    options.freezing?.(grant.root);
                }
                await client.flush();
                for (const grant of live())
                    void end(grant);
                settling = false;
            }
            if (processGone !== null)
                await retirePending().catch(() => { });
            const failure = client.takeFailuresError();
            if (failure !== null)
                throw failure;
        },
        takeFailures() {
            return failures.splice(0, failures.length);
        },
        readTrusted() {
            // Asked only where I/O just moved the clock to real time (a resumption
            // that arrived by I/O; never a timer's turn, which leaves it where it
            // was): trusted there, it is before asked + trust, and the session
            // publishes past this lease unanswered only after confirmed + trust +
            // margin (confirmed >= asked).
            return readLease !== null && readLease.logged === logged && now() < readLease.until;
        },
        readUnchanged(owner) {
            return !runEnded && readLease?.owner === owner && readLease.logged === logged;
        },
        readLeaseAsk() {
            if (reflectGet(session, 'grants') === undefined || runEnded)
                return null;
            return { at: now(), logged: answered === logged ? logged : -1 };
        },
        readLeaseAnswered(lease) {
            if (reflectGet(session, 'grants') === undefined || endedReadLeases.has(lease.owner))
                return;
            if (readLease?.owner === lease.owner) {
                readLease.confirmedAt = now();
                return;
            }
            // Granted to a barrier asked before the run ended: given back too.
            if (runEnded) {
                void giveBackReadLease(lease.owner);
                return;
            }
            readLease = { owner: lease.owner, until: 0, confirmedAt: now(), logged: -1 };
            counters.readLeases++;
            void answerReadRecalls(lease.owner);
        },
        readLeased(lease, ask) {
            if (readLease?.owner !== lease.owner)
                return;
            readLease.until = ask.at + lease.trustMs;
            readLease.logged = ask.logged;
            counters.readConfirms++;
        },
        takeFailuresError() {
            const taken = failures.splice(0, failures.length);
            // A missing process is terminal even after its recorded ops were taken.
            if (processGone !== null)
                return processGone;
            return taken.length === 0 ? null : failuresError(taken);
        },
        noteFailure(failure) {
            failures.push(failure);
        },
        get pendingBytes() { return pendingBytes; },
        get ended() { return processGone !== null; },
        stats() { return { ...counters }; },
    };
    return client;
}
/** Where a drain's wave numbers start: past any a process sends (2^40 waves). */
const DRAIN_WAVE_BASE = 2 ** 40;
/**
 * The error a process's failed changes are reported as at an effect (a
 * response, its exit): each named, with the session's errno and message.
 */
export function failuresError(failures) {
    const gone = failures.find((failure) => failure.errno === 'ESRCH');
    if (gone !== undefined)
        return Object.assign(new Error(gone.message), { code: 'ESRCH', failures });
    return Object.assign(new Error(`${failures.length} filesystem change${failures.length === 1 ? '' : 's'} this process made did not reach the session:\n`
        + failures.map((failure) => `  ${failure.op} ${failure.path}: ${failure.errno}: ${failure.message}`).join('\n')), { code: 'EIO', failures });
}
/** Data bytes a drain reads from a journal at once: a wave's worth. */
const DRAIN_WINDOW_BYTES = WAVE_BYTES;
/**
 * `op` as a replay sends it: a name the process made under its grant keeps the number the grant gave it only while
 * that grant is held (askedIno, the session's check). A replay runs in a session that holds no such grant, so the
 * number is the replaying session's to give, as it is to give a name's number in any session that never granted it.
 */
function unnumbered(op) {
    if (op.type !== 'call' || !('ino' in op.call))
        return op;
    return { type: 'call', call: { ...op.call, ino: undefined } };
}
/**
 * Send what a process's journal still holds, as the process would have:
 * each entry under the writer and number it was given (its numberings), so
 * the session's cursor answers what already landed and applies the rest
 * once; entries never numbered under a fresh writer. Read a window at a
 * time, each forgotten once answered: the journal is empty when it
 * resolves. A refusal is the change's answer, reported in what it resolves
 * with; a session that cannot be reached rejects, and the journal keeps what
 * it holds for the next drain.
 */
export async function drainProcessFsJournal(options) {
    const { journal, session } = options;
    const drained = { landed: 0, failures: [] };
    let held = await journal.readAfter(0, DRAIN_WINDOW_BYTES);
    if (held.length === 0)
        return drained;
    // Entries no numbering covers (the process died before its first wave): a fresh writer numbers them.
    const numberings = await journal.numberings();
    if (numberings.length === 0 || numberings[0].jid > held[0].jid) {
        const writer = await openWaveEpoch(() => session.openWriter(false), {
            ...(options.retry === undefined ? {} : { retry: options.retry }),
            ...(options.timers === undefined ? {} : { timers: options.timers }),
        });
        const numbering = { writer, seq: 1, jid: held[0].jid };
        await journal.number(numbering);
        numberings.unshift(numbering);
    }
    const numberingOf = (jid) => {
        let found = numberings[0];
        for (const numbering of numberings)
            if (numbering.jid <= jid)
                found = numbering;
        return found;
    };
    // Its waves are numbered past any the process sent under the same writer:
    // the session's fence takes them as the newest attempts, and refuses any
    // late attempt of the dead process after them (its cursor answers both).
    let wave = DRAIN_WAVE_BASE;
    while (held.length > 0) {
        // A wave: entries under one numbering, their numbers contiguous, within W7's bounds.
        const numbering = numberingOf(held[0].jid);
        const taken = [];
        const owned = new Set();
        let bytes = 0;
        let pathBytes = 0;
        for (const entry of held) {
            if (numberingOf(entry.jid) !== numbering)
                break;
            const seq = numbering.seq + (entry.jid - numbering.jid);
            if (taken.length > 0 && seq !== taken[taken.length - 1].seq + 1)
                break;
            const paths = pathsOf(entry.op).filter((path) => !owned.has(path));
            const entryBytes = entry.op.type === 'call' && 'data' in entry.op.call ? entry.op.call.data.byteLength : 0;
            const entryPathBytes = paths.reduce((sum, path) => sum + utf8Length(path), 0);
            if (taken.length > 0 && (owned.size + paths.length > WAVE_PATHS || pathBytes + entryPathBytes > WAVE_PATH_BYTES || bytes + entryBytes > WAVE_BYTES))
                break;
            for (const path of paths)
                owned.add(path);
            bytes += entryBytes;
            pathBytes += entryPathBytes;
            taken.push({ ...entry, seq });
        }
        const encoded = await encodeWriteBatch({ inodes: [], chunks: [], ops: taken.map((entry) => unnumbered(entry.op)) });
        const result = await sendWaveAttempts({
            supervisor: session,
            writer: async () => numbering.writer,
            open: waveAttemptsOf(encoded),
            streamed: false,
            wave: ++wave,
            ...(numbering.writer === null ? {} : { sequence: { seq: taken[0].seq, ack: 0 } }),
            ...(options.retry === undefined ? {} : { retry: options.retry }),
            ...(options.timers === undefined ? {} : { timers: options.timers }),
        });
        const cursor = numbering.writer === null
            ? taken[0].seq - 1 + (result.ok ? taken.length : result.committedOps)
            : result.sequence?.cursor;
        if (cursor === undefined) {
            throw new Error(`the session answered a drained write without its cursor: ${result.ok ? 'no error' : result.error.message}`);
        }
        const refused = numbering.writer === null
            ? (!result.ok && result.error.errno !== undefined && SYSCALL_VERDICTS.has(result.error.errno)
                ? { seq: cursor + 1, errno: result.error.errno, message: result.error.message } : null)
            : result.sequence?.refused ?? null;
        let through = 0;
        for (const entry of taken) {
            if (entry.seq <= cursor && (refused === null || entry.seq !== refused.seq)) {
                drained.landed++;
                through = entry.jid;
                continue;
            }
            if (refused !== null && entry.seq === refused.seq) {
                drained.failures.push({ op: nameOf(entry.op), path: pathsOf(entry.op)[0] ?? '', errno: refused.errno, message: refused.message });
                through = entry.jid;
                continue;
            }
            break;
        }
        if (through === 0) {
            throw new Error(`the session applied none of a drained write: ${result.ok ? 'no error' : result.error.message}`);
        }
        await journal.dropThrough(through);
        held = held.filter((entry) => entry.jid > through);
        if (held.length === 0)
            held = await journal.readAfter(through, DRAIN_WINDOW_BYTES);
    }
    return drained;
}
