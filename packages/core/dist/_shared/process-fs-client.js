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
import { WAVE_BYTES, WAVE_PATHS, WAVE_PATH_BYTES, sendWaveAttempts, waveAttemptsOf } from '@nimbus-sh/platform/wave-writer.js';
import { WAVE_EPOCH_TTL_MS } from '@nimbus-sh/platform/lost-call.js';
import { SYSCALL_VERDICTS } from '../vfs/vfs-error.js';
/** A synchronous loop's bytes held at once, at most (ProcessFsClientOptions.syncCapBytes). */
export const PROCESS_FS_SYNC_CAP_BYTES = 64 * 1024 * 1024;
/** A data call's bytes per op: a larger one is sent as its first piece, then writes at offsets. */
const DATA_PIECE_BYTES = WAVE_BYTES;
/** The most subtrees one process holds at once; past it, two are widened to their common ancestor. */
export const MAX_DELEGATIONS_PER_PROCESS = 8;
/** Mutations in a subtree before the client takes it. */
export const GRANT_AFTER = 8;
/** A grant unused this long is given back. */
export const GRANT_IDLE_MS = 2_000;
/** Inode numbers a first grant of a subtree reserves; each renewal doubles it. */
const GRANT_INOS = 4096;
/** Storage bytes a grant reserves for what is decided under it. */
const GRANT_BYTES = 64 * 1024 * 1024;
/** How long one recall poll waits before asking again. */
const RECALL_POLL_MS = 20_000;
function parentKey(key) {
    const at = key.lastIndexOf('/');
    return at < 0 ? '' : key.slice(0, at);
}
function within(key, root) {
    return root === '' || key === root || key.startsWith(`${root}/`);
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
function utf8Length(text) {
    return new TextEncoder().encode(text).byteLength;
}
function pathsOf(op) {
    switch (op.type) {
        case 'run': return [op.path];
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
    return op.type === 'call' ? op.call.call : op.type === 'run' ? op.name : op.type;
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
    /** Entries logged, the last one answered (every one before it is), and the flushes waiting for a place in the log. */
    let logged = 0;
    let answered = 0;
    const marks = [];
    const counters = {
        ops: 0, waves: 0, resends: 0, epochs: 0, refused: 0, lost: 0, maxWaveOps: 0,
        grants: 0, grantsRefused: 0, recalls: 0, released: 0, widened: 0,
    };
    const grantAfter = options.grantAfter ?? GRANT_AFTER;
    const grantIdleMs = options.grantIdleMs ?? GRANT_IDLE_MS;
    const recallPollMs = options.recallPollMs ?? RECALL_POLL_MS;
    const grants = [];
    /** Mutations per candidate subtree not yet held; subtrees the session refused, and the range each was last given. */
    const mutations = new Map();
    const refusedRoots = new Set();
    const rangeOf = new Map();
    /** A grant being taken (no other is asked for meanwhile), and whether waves wait for it (while it is asked for). */
    let claiming = null;
    let paused = false;
    /** The wave in flight, settled once its answer is applied. */
    let sending = null;
    let idleTimer = null;
    let settling = false;
    const settled = (entry) => {
        pendingBytes -= entry.bytes;
        if (entry.acknowledged)
            pendingSyncBytes -= entry.bytes;
        answered = Math.max(answered, entry.order);
        for (let at = marks.length - 1; at >= 0; at--) {
            if (marks[at].mark <= answered)
                marks.splice(at, 1)[0].resolve();
        }
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
            // A session call of its own is never in a wave: it is made alone, in its place.
            if (next.op.type === 'run') {
                if (taken.length === 0)
                    taken.push(queue.shift());
                break;
            }
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
        const first = entries[0];
        if (first.op.type === 'run') {
            const { name, run } = first.op;
            charge(name);
            try {
                const value = await run();
                settled(first);
                first.resolve({ value });
            }
            catch (error) {
                const code = error?.code;
                fail(first, typeof code === 'string' ? code : 'EIO', error instanceof Error ? error.message : String(error));
            }
            return;
        }
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
        const firstSeq = entries[0].seq;
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
                ...(writer === null ? {} : { sequence: { seq: firstSeq, ack } }),
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
        const cursor = writer === null ? firstSeq - 1 + (answer.ok ? entries.length : answer.committedOps) : answer.sequence?.cursor;
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
        const mutations = new Map((answer.mutations ?? []).map((mutation) => [mutation.index, mutation]));
        for (const [index, entry] of entries.entries()) {
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
                const mutation = mutations.get(index);
                if (mutation !== undefined)
                    answered.mutation = { before: mutation.before, after: mutation.after };
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
        if (inFlight !== null || paused)
            return;
        if (queue.length === 0)
            return;
        const entries = cut();
        inFlight = entries;
        sending = send(entries).finally(() => {
            inFlight = null;
            sending = null;
            pump();
        });
    };
    const schedule = () => {
        if (scheduled || inFlight !== null || paused)
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
    /** Give `grant` back: its log sent first (the caller flushed), then released. */
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
            charge('fsReleaseExclusiveMutation');
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
                charge('fsAwaitRecall');
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
            await client.flush();
            if (kind === 'share') {
                grant.shared = true;
                options.released?.(grant.root);
            }
            try {
                charge('fsRecalled');
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
    /** Give back every grant unused for the idle period; armed while any is held. */
    const armIdle = () => {
        if (idleTimer !== null || live().length === 0)
            return;
        idleTimer = timers.setTimeout(() => {
            idleTimer = null;
            const idle = live().filter((grant) => now() - grant.lastUsed >= grantIdleMs);
            if (idle.length === 0 || settling) {
                armIdle();
                return;
            }
            void client.flush().then(async () => {
                for (const grant of idle)
                    if (now() - grant.lastUsed >= grantIdleMs)
                        await end(grant);
                armIdle();
            });
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
            const covered = live().filter((grant) => within(grant.root, target));
            if (covered.length > 0) {
                await client.flush();
                for (const grant of covered)
                    await end(grant);
                counters.widened++;
            }
            paused = true;
            await quiet();
            const inos = (rangeOf.get(target) ?? GRANT_INOS / 2) * 2;
            let granted;
            try {
                charge('fsAcquireExclusiveMutation');
                granted = await port.acquire('/' + target, { reads: true, inos, bytes: GRANT_BYTES });
            }
            catch {
                // EBUSY (another's lease), EPERM (the session's own), ENOSPC: the session decides there.
                refusedRoots.add(target);
                counters.grantsRefused++;
                return;
            }
            rangeOf.set(target, inos);
            const grant = {
                root: granted.root,
                owner: granted.owner,
                umask: granted.umask ?? 0o022,
                nextIno: granted.inos?.first ?? 0,
                endIno: granted.inos?.end ?? 0,
                inos,
                bytesLeft: granted.bytes ?? 0,
                shared: false,
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
    const heldGrant = (key) => grants.find((grant) => !grant.ended && !grant.shared && within(key, grant.root));
    const client = {
        holder(key) {
            const held = heldGrant(key);
            if (held !== undefined) {
                held.lastUsed = now();
                return held;
            }
            if (session.grants === undefined || settling)
                return undefined;
            // Shared, or another's: the session decides; a subtree it refused is not asked for again.
            if (grants.some((grant) => !grant.ended && within(key, grant.root)))
                return undefined;
            const root = parentKey(key);
            if (!allowedRoot(root) || [...refusedRoots].some((refused) => within(root, refused)))
                return undefined;
            const seen = (mutations.get(root) ?? 0) + 1;
            mutations.set(root, seen);
            if (seen >= grantAfter)
                claim(root);
            return undefined;
        },
        number(grant) {
            const held = grant;
            if (held.ended || held.nextIno >= held.endIno)
                return undefined;
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
        pending() {
            return queue.length > 0 || inFlight !== null;
        },
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
                queue.push({ op: part, seq: 0, order: ++logged, bytes: partBytes, paths: pathsOf(part), acknowledged, resolve, reject });
                pendingBytes += partBytes;
                if (acknowledged)
                    pendingSyncBytes += partBytes;
                counters.ops++;
            }));
            schedule();
            // A piece refused rejects the call; its last piece's receipt answers it,
            // and its mutation spans them all.
            const answer = Promise.all(answers).then((all) => {
                const first = all[0]?.mutation;
                const last = all[all.length - 1];
                if (last === undefined)
                    return {};
                const { mutation: _mutation, ...rest } = last;
                return first !== undefined && last.mutation !== undefined ? { ...rest, mutation: { before: first.before, after: last.mutation.after } } : rest;
            });
            if (acknowledged)
                answer.catch(() => { });
            return answer;
        },
        call(name, path, run, callOptions) {
            const acknowledged = callOptions?.acknowledged === true;
            const answer = new Promise((resolve, reject) => {
                queue.push({ op: { type: 'run', name, path, run }, seq: 0, order: ++logged, bytes: 0, paths: [path], acknowledged, resolve, reject });
                counters.ops++;
            });
            schedule();
            if (acknowledged)
                answer.catch(() => { });
            return answer.then((answered) => answered.value);
        },
        flush() {
            options.drain?.();
            const mark = logged;
            if (answered >= mark)
                return Promise.resolve();
            const flushed = new Promise((resolve) => { marks.push({ mark, resolve }); });
            schedule();
            return flushed;
        },
        async settle() {
            settling = true;
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
                for (const grant of live())
                    await end(grant);
                settling = false;
            }
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
