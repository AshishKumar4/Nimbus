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
 * lone op is a wave of one, with no timer), and whatever is made while a
 * wave is out goes in the next, up to W7's bounds.
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
 */
import { encodeWriteBatch } from '@nimbus-sh/platform/w7-frame.js';
import { WAVE_BYTES, WAVE_PATHS, WAVE_PATH_BYTES, sendWaveAttempts, waveAttemptsOf } from '@nimbus-sh/platform/wave-writer.js';
import { WAVE_EPOCH_TTL_MS } from '@nimbus-sh/platform/lost-call.js';
import { SYSCALL_VERDICTS } from '../vfs/vfs-error.js';
/** A synchronous loop's bytes held at once, at most (ProcessFsClientOptions.syncCapBytes). */
export const PROCESS_FS_SYNC_CAP_BYTES = 64 * 1024 * 1024;
/** A data call's bytes per op: a larger one is sent as its first piece, then writes at offsets. */
const DATA_PIECE_BYTES = WAVE_BYTES;
const GLOBAL_TIMERS = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
};
function utf8Length(text) {
    return new TextEncoder().encode(text).byteLength;
}
function pathsOf(op) {
    switch (op.type) {
        case 'call': return [op.call.path];
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
/** The op with its bytes copied: a caller's buffer may change after the call returns. */
function owned(op) {
    if (op.type !== 'call' || !('data' in op.call))
        return op;
    return { type: 'call', call: { ...op.call, data: op.call.data.slice() } };
}
/** A data call larger than a piece: its first piece as the call, the rest as writes at their offsets. */
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
        out.push(call.call === 'append' || call.call === 'appendFile'
            ? { type: 'call', call: { call: 'append', path: call.path, ...(ino === undefined ? {} : { ino }), data: piece } }
            : { type: 'call', call: { call: 'write', path: call.path, ...(ino === undefined ? {} : { ino }), offset: (call.call === 'write' ? call.offset : 0) + at, data: piece } });
    }
    return out;
}
export function processFsClient(options) {
    const { session } = options;
    const timers = options.timers ?? GLOBAL_TIMERS;
    const now = options.now ?? Date.now;
    const syncCap = options.syncCapBytes ?? PROCESS_FS_SYNC_CAP_BYTES;
    const charge = options.charge ?? (() => { });
    /** Logged, not yet sent; the first ones may carry numbers from a wave they came back from. */
    const queue = [];
    let inFlight = null;
    let scheduled = false;
    let pendingBytes = 0;
    let pendingSyncBytes = 0;
    /** The writer epoch the log is numbered under, when it was opened, and its numbering. */
    let epoch = null;
    let nextSeq = 1;
    let ack = 0;
    let wave = 0;
    const failures = [];
    let idle = null;
    const counters = { ops: 0, waves: 0, resends: 0, epochs: 0, refused: 0, lost: 0, maxWaveOps: 0 };
    const settled = (entry) => {
        pendingBytes -= entry.bytes;
        if (entry.acknowledged)
            pendingSyncBytes -= entry.bytes;
    };
    const fail = (entry, errno, message) => {
        settled(entry);
        const path = entry.paths[0] ?? '';
        if (entry.acknowledged) {
            failures.push({ op: nameOf(entry.op), path, errno, message });
            entry.resolve({});
        }
        else {
            entry.reject(fsError(errno, message, path));
        }
    };
    /** The epoch a new wave is numbered under: a fresh one before the first, and once half its life has passed with nothing unanswered. */
    const writerFor = async () => {
        if (epoch !== null && (epoch.writer === null || now() - epoch.openedAt < WAVE_EPOCH_TTL_MS / 2))
            return epoch.writer;
        charge('openWaveWriter');
        const openedAt = now();
        const writer = await session.openWriter();
        epoch = { writer, openedAt };
        counters.epochs++;
        nextSeq = 1;
        ack = 0;
        wave = 0;
        return writer;
    };
    /** The ops of the next wave: in log order, up to W7's bounds, at least one. */
    const cut = () => {
        const taken = [];
        const owned = new Set();
        let pathBytes = 0;
        let bytes = 0;
        while (queue.length > 0) {
            const next = queue[0];
            const fresh = next.paths.filter((path) => !owned.has(path));
            const freshBytes = fresh.reduce((sum, path) => sum + utf8Length(path), 0);
            if (taken.length > 0 && (owned.size + fresh.length > WAVE_PATHS || pathBytes + freshBytes > WAVE_PATH_BYTES || bytes + next.bytes > WAVE_BYTES))
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
            writer = await writerFor();
        }
        catch (error) {
            for (const entry of entries)
                fail(entry, 'EIO', `the session gave this process no writer: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const bytes = await encodeWriteBatch({ inodes: [], chunks: [], ops: entries.map((entry) => entry.op) });
        // Numbered once, under the epoch they are first sent under; a re-send keeps them.
        for (const entry of entries)
            if (entry.seq === 0)
                entry.seq = nextSeq++;
        const first = entries[0].seq;
        counters.waves++;
        counters.maxWaveOps = Math.max(counters.maxWaveOps, entries.length);
        wave++;
        let result;
        try {
            charge('writeBatchStream');
            result = await sendWaveAttempts({
                supervisor: session,
                writer: async () => writer,
                open: waveAttemptsOf(bytes),
                streamed: false,
                wave,
                ...(writer === null ? {} : { sequence: { seq: first, ack } }),
                ...(options.retry === undefined ? {} : { retry: options.retry }),
                resent: () => { counters.resends++; charge('writeBatchStream'); },
                timers,
            });
        }
        catch (error) {
            // Lost past every re-send, or refused before any op (the epoch gone): their fate is unknown.
            lostEpoch(entries, `the session did not answer this write: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        // The session's own answer (SqliteVFS.writeStream's, through the binding).
        const answer = result;
        const error = answer.ok ? null : answer.error;
        // Unfenced, the session numbers nothing: committedOps says how far it went.
        const cursor = writer === null ? first - 1 + (answer.ok ? entries.length : answer.committedOps) : answer.sequence?.cursor;
        if (cursor === undefined) {
            lostEpoch(entries, `the session answered this write without its cursor: ${error?.message ?? 'no error'}`);
            return;
        }
        ack = Math.max(ack, cursor);
        const refused = writer === null
            ? (error?.errno !== undefined && SYSCALL_VERDICTS.has(error.errno) ? { seq: cursor + 1, errno: error.errno, message: error.message } : null)
            : answer.sequence?.refused ?? null;
        let receipt = 0;
        const back = [];
        for (const entry of entries) {
            if (refused !== null && entry.seq === refused.seq) {
                counters.refused++;
                fail(entry, refused.errno, refused.message);
                if (writer === null)
                    ack = Math.max(ack, entry.seq);
                continue;
            }
            if (entry.seq <= cursor) {
                settled(entry);
                let answered = {};
                const path = entry.op.type === 'call' && 'data' in entry.op.call ? entry.op.call.path : null;
                const published = answer.receipts[receipt];
                if (path !== null && published?.path === path) {
                    receipt++;
                    const { path: _path, ...stat } = published;
                    answered = { receipt: stat };
                }
                entry.resolve(answered);
                continue;
            }
            back.push(entry);
        }
        if (back.length === 0)
            return;
        if (answer.ok || refused !== null) {
            // After a refusal, nothing more in the wave was applied: they go again, first, as numbered.
            queue.unshift(...back);
            return;
        }
        lostEpoch(back, `the session could not apply this write: ${error?.message ?? 'no error'}`);
    };
    /**
     * Ops whose fate the session cannot answer: failures, and the epoch they
     * were numbered under is given up, so the ops after them are numbered
     * under a new one (the session would refuse them as a gap).
     */
    const lostEpoch = (entries, message) => {
        for (const entry of entries) {
            counters.lost++;
            fail(entry, 'EIO', message);
        }
        epoch = null;
        for (const entry of queue)
            entry.seq = 0;
    };
    const pump = () => {
        scheduled = false;
        if (inFlight !== null)
            return;
        if (queue.length === 0) {
            idle?.resolve();
            idle = null;
            return;
        }
        const entries = cut();
        inFlight = entries;
        void send(entries).finally(() => {
            inFlight = null;
            pump();
        });
    };
    const schedule = () => {
        if (scheduled || inFlight !== null)
            return;
        scheduled = true;
        queueMicrotask(pump);
    };
    const client = {
        submit(op, submitOptions) {
            const acknowledged = submitOptions?.acknowledged === true;
            const named = pathsOf(op);
            for (const path of named)
                if (!canonical(path))
                    throw fsError('EINVAL', `EINVAL: not a filesystem path the session takes: '${path}'`, path);
            const parts = pieces(owned(op));
            const bytes = parts.reduce((sum, part) => sum + (part.type === 'call' && 'data' in part.call ? part.call.data.byteLength : 0), 0);
            if (acknowledged && pendingSyncBytes + bytes > syncCap) {
                throw fsError('ENOMEM', `ENOMEM: ${pendingSyncBytes} bytes of synchronous writes are waiting for the session, and this one (${bytes}) would pass the ${syncCap}-byte cap; let the program yield (an await) for them to be sent`, pathsOf(op)[0] ?? '');
            }
            const answers = parts.map((part) => new Promise((resolve, reject) => {
                const partBytes = part.type === 'call' && 'data' in part.call ? part.call.data.byteLength : 0;
                queue.push({ op: part, seq: 0, bytes: partBytes, paths: pathsOf(part), acknowledged, resolve, reject });
                pendingBytes += partBytes;
                if (acknowledged)
                    pendingSyncBytes += partBytes;
                counters.ops++;
            }));
            schedule();
            // A piece refused rejects the call; its first piece's receipt answers it.
            const answer = Promise.all(answers).then((all) => all[all.length - 1] ?? {});
            if (acknowledged)
                answer.catch(() => { });
            return answer;
        },
        flush() {
            if (queue.length === 0 && inFlight === null)
                return Promise.resolve();
            if (idle === null) {
                let resolve;
                const promise = new Promise((done) => { resolve = done; });
                idle = { promise, resolve };
            }
            schedule();
            return idle.promise;
        },
        async settle() {
            await client.flush();
            const taken = client.takeFailures();
            if (taken.length > 0) {
                throw Object.assign(new Error(`${taken.length} filesystem change${taken.length === 1 ? '' : 's'} this process made did not reach the session:\n`
                    + taken.map((failure) => `  ${failure.op} ${failure.path}: ${failure.errno}: ${failure.message}`).join('\n')), { code: 'EIO', failures: taken });
            }
        },
        takeFailures() {
            return failures.splice(0, failures.length);
        },
        get pendingBytes() { return pendingBytes; },
        stats() { return { ...counters }; },
    };
    return client;
}
