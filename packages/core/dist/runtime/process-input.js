export const PROCESS_INPUT_MAX_QUEUED_BYTES = 256 * 1024;
export const PROCESS_INPUT_READ_MAX_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const inputBytes = (data) => typeof data === 'string' ? encoder.encode(data).length : data.length;
function isValidPid(pid) {
    return Number.isSafeInteger(pid) && pid > 0;
}
export class ProcessInputStore {
    maxQueuedBytes;
    pids = new Map();
    constructor(options = {}) {
        this.maxQueuedBytes = options.maxQueuedBytes ?? PROCESS_INPUT_MAX_QUEUED_BYTES;
    }
    createState() {
        return { owners: new Set(), packets: [], closed: false, bytes: 0, waiters: [], drained: [], reading: false, columns: 80, rows: 24, writes: Promise.resolve() };
    }
    /** The one pump for shell pipes/redirects, regardless of which runtime consumes fd 0. */
    pump(pid, source) {
        const opened = !this.has(pid);
        if (opened)
            this.open(pid);
        let stopped = false;
        const done = (async () => {
            for (;;) {
                const piece = await source.readBytes(PROCESS_INPUT_READ_MAX_BYTES);
                if (stopped)
                    return;
                if (piece === null) {
                    this.end(pid);
                    return;
                }
                if (!(await this.writeBytesWait(pid, piece)).ok)
                    return;
            }
        })();
        done.catch(error => { if (!stopped)
            this.fail(pid, error); });
        return { done, stop: () => { stopped = true; if (opened)
                this.close(pid); } };
    }
    open(pid) {
        if (!isValidPid(pid) || this.pids.has(pid))
            return;
        const state = this.createState();
        state.owners.add(pid);
        this.pids.set(pid, state);
    }
    /** Queued bytes stay readable; after them, every read reports the failure. */
    fail(pid, cause) {
        const state = this.pids.get(pid);
        if (!state || state.failure)
            return;
        const reason = cause instanceof Error ? cause.message : String(cause);
        state.failure = Object.assign(new Error(`EIO: stdin read failed: ${reason}`), { code: 'EIO' });
        state.closed = true;
        for (const waiter of state.waiters.splice(0)) {
            clearTimeout(waiter.timer);
            waiter.reject(state.failure);
        }
        for (const wake of state.drained.splice(0))
            wake();
    }
    /** dup/inherit fd 0: one consuming channel, including queued bytes and future EOF. */
    inherit(pid, parentPid) {
        if (!isValidPid(pid) || pid === parentPid)
            throw new Error('invalid inherited stdin identity');
        if (this.pids.has(pid))
            throw new Error('stdin is already open');
        const state = this.pids.get(parentPid);
        if (!state) {
            this.open(pid);
            this.end(pid);
            return;
        }
        state.owners.add(pid);
        this.pids.set(pid, state);
    }
    has(pid) {
        return this.pids.has(pid);
    }
    /** Whether the process behind `pid` has started reading its input channel. */
    hasReader(pid) {
        return this.pids.get(pid)?.reading === true;
    }
    write(pid, data) {
        if (!isValidPid(pid))
            return { ok: false };
        const state = this.pids.get(pid);
        if (!state)
            return { ok: false };
        if (state.closed)
            return { ok: false };
        const text = String(data);
        const bytes = inputBytes(text);
        if (state.bytes + bytes > this.maxQueuedBytes)
            return { ok: false };
        return this.enqueue(state, { data: text, ended: false }, bytes);
    }
    /**
     * Queue bytes exactly as given: a pipe or redirect, which need not be text.
     * Refused for room, it says \`full\`: its writer waits and writes again.
     */
    writeBytes(pid, data) {
        if (!isValidPid(pid))
            return { ok: false };
        const state = this.pids.get(pid);
        if (!state)
            return { ok: false };
        if (state.closed)
            return { ok: false };
        if (state.bytes + data.byteLength > this.maxQueuedBytes)
            return { ok: false, full: true };
        return this.enqueue(state, { data, ended: false }, data.byteLength);
    }
    /** A pipe write: ordered, split at the bound, waiting for room instead of dropping bytes. */
    async writeBytesWait(pid, data) {
        const state = this.pids.get(pid);
        if (!state || state.closed)
            return { ok: false };
        let result = { ok: false };
        const task = state.writes.then(async () => {
            for (let at = 0; at < data.byteLength; at += this.maxQueuedBytes) {
                const piece = data.subarray(at, Math.min(data.byteLength, at + this.maxQueuedBytes));
                for (;;) {
                    const wrote = this.writeBytes(pid, piece);
                    if (wrote.ok)
                        break;
                    if (!wrote.full || !await this.whenWritable(pid))
                        return;
                }
            }
            result = { ok: true };
        });
        state.writes = task.catch(() => { });
        await task;
        return result;
    }
    async endAfterWrites(pid) {
        await this.pids.get(pid)?.writes;
        this.end(pid);
    }
    resize(pid, columns, rows) {
        if (!isValidPid(pid))
            return { ok: false };
        const state = this.pids.get(pid);
        if (!state)
            return { ok: false };
        if (state.closed)
            return { ok: false };
        state.columns = columns;
        state.rows = rows;
        return this.enqueue(state, { data: '', ended: false, resize: { columns, rows } }, 0);
    }
    signal(pid, signal) {
        if (!isValidPid(pid))
            return { ok: false };
        const state = this.pids.get(pid);
        if (!state)
            return { ok: false };
        if (state.closed)
            return { ok: false };
        return this.enqueue(state, { data: '', ended: false, signal }, 0);
    }
    terminalSize(pid) {
        const state = this.pids.get(pid);
        return state ? { columns: state.columns, rows: state.rows } : null;
    }
    enqueue(state, packet, bytes) {
        const waiter = state.waiters.shift();
        if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve(packet);
            return { ok: true };
        }
        const last = state.packets[state.packets.length - 1];
        if (packet.resize && last?.resize && !last.data && !last.ended && !last.signal) {
            state.packets[state.packets.length - 1] = packet;
            return { ok: true };
        }
        state.packets.push(packet);
        state.bytes += bytes;
        return { ok: true };
    }
    /**
     * Resolves once `pid`'s reader has taken queued input, so a writer refused
     * for a full queue can try again: true then, false if the channel is ended
     * or gone and will take no more.
     */
    whenWritable(pid) {
        const state = this.pids.get(pid);
        if (!state || state.closed)
            return Promise.resolve(false);
        if (state.bytes === 0)
            return Promise.resolve(true);
        return new Promise((resolve) => state.drained.push(() => resolve(!state.closed && this.pids.get(pid) === state)));
    }
    /**
     * Put input a reader took back in front of the queue, as it was: a process
     * that stopped before using it, run again (worker runtime/stop-replay.ts).
     * Past the queue's bound if need be, and after the channel ended too: the
     * writer wrote it within both.
     */
    unread(pid, packets) {
        const state = this.pids.get(pid);
        if (!state || packets.length === 0)
            return;
        state.packets = packets.concat(state.packets);
        for (const packet of packets)
            state.bytes += inputBytes(packet.data);
        // A reader already waiting takes what came back.
        const waiter = state.waiters.shift();
        if (waiter) {
            clearTimeout(waiter.timer);
            const next = state.packets.shift();
            state.bytes -= inputBytes(next.data);
            waiter.resolve(next);
        }
    }
    end(pid) {
        const state = this.pids.get(pid);
        if (!state || state.closed)
            return;
        state.closed = true;
        for (const wake of state.drained.splice(0))
            wake();
        for (const waiter of state.waiters.splice(0)) {
            clearTimeout(waiter.timer);
            waiter.resolve({ data: '', ended: true });
        }
    }
    close(pid) {
        const state = this.pids.get(pid);
        if (!state)
            return;
        this.pids.delete(pid);
        state.owners.delete(pid);
        for (const waiter of state.waiters.filter(w => w.pid === pid)) {
            clearTimeout(waiter.timer);
            waiter.resolve({ data: '', ended: true });
        }
        state.waiters = state.waiters.filter(w => w.pid !== pid);
        for (const wake of state.drained.splice(0))
            wake();
        if (state.owners.size === 0) {
            state.closed = true;
            state.packets = [];
            state.bytes = 0;
        }
    }
    async read(pid, waitMs = 1000, maxBytes) {
        if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0))
            throw new TypeError('stdin maxBytes must be a nonnegative integer');
        if (maxBytes === 0)
            return { data: new Uint8Array(0), ended: false };
        if (!isValidPid(pid))
            return { data: '', ended: true };
        const state = this.pids.get(pid);
        if (!state)
            return { data: '', ended: true };
        state.reading = true;
        let next = state.packets.shift();
        if (next !== undefined) {
            const limit = maxBytes === undefined ? Infinity : Math.max(1, Math.min(PROCESS_INPUT_READ_MAX_BYTES, maxBytes));
            if (maxBytes !== undefined && typeof next.data === 'string')
                next = { ...next, data: encoder.encode(next.data) };
            if (next.data instanceof Uint8Array && next.data.length > limit) {
                state.packets.unshift({ ...next, data: next.data.subarray(limit) });
                next = { data: next.data.subarray(0, limit), ended: false };
            }
            state.bytes -= inputBytes(next.data);
            // Piped bytes queued back to back leave in one packet, one round trip:
            // a pipe is written a piece at a time, and a reader wants all it can get.
            if (next.data instanceof Uint8Array && isPlainData(next)) {
                const run = [next.data];
                let size = next.data.byteLength;
                while (state.packets.length > 0) {
                    const peek = state.packets[0];
                    if (!(peek.data instanceof Uint8Array) || !isPlainData(peek))
                        break;
                    if (size + peek.data.length > limit)
                        break;
                    state.packets.shift();
                    state.bytes -= peek.data.byteLength;
                    run.push(peek.data);
                    size += peek.data.byteLength;
                }
                if (run.length > 1) {
                    const data = new Uint8Array(size);
                    let at = 0;
                    for (const piece of run) {
                        data.set(piece, at);
                        at += piece.byteLength;
                    }
                    next = { data, ended: false };
                }
            }
            for (const wake of state.drained.splice(0))
                wake();
            return next;
        }
        if (state.failure)
            throw state.failure;
        if (state.closed)
            return { data: '', ended: true };
        return new Promise((resolve, reject) => {
            const waiter = {
                pid,
                reject,
                resolve: packet => {
                    if (maxBytes === undefined || !packet.data.length) {
                        resolve(packet);
                        return;
                    }
                    const bytes = typeof packet.data === 'string' ? encoder.encode(packet.data) : packet.data;
                    const limit = Math.max(1, Math.min(PROCESS_INPUT_READ_MAX_BYTES, maxBytes));
                    if (bytes.length > limit)
                        this.unread(pid, [{ ...packet, data: bytes.subarray(limit) }]);
                    resolve({ ...packet, data: bytes.subarray(0, limit), ...(bytes.length > limit ? { ended: false } : {}) });
                },
                timer: setTimeout(() => {
                    const idx = state.waiters.indexOf(waiter);
                    if (idx >= 0)
                        state.waiters.splice(idx, 1);
                    resolve({ data: '', ended: false });
                }, Math.max(0, Math.min(waitMs, 5000))),
            };
            state.waiters.push(waiter);
        });
    }
}
/** A packet that carries only data: no end, signal or resize. */
function isPlainData(packet) {
    for (const key of Object.keys(packet)) {
        if (key === 'data')
            continue;
        if (key === 'ended' && packet.ended === false)
            continue;
        return false;
    }
    return true;
}
