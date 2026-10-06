const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024;
function isValidPid(pid) {
    return Number.isSafeInteger(pid) && pid > 0;
}
export class ProcessInputStore {
    maxQueuedBytes;
    pids = new Map();
    constructor(options = {}) {
        this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    }
    createState() {
        return { packets: [], closed: false, bytes: 0, waiters: [], drained: [], reading: false, columns: 80, rows: 24 };
    }
    open(pid) {
        if (!isValidPid(pid) || this.pids.has(pid))
            return;
        this.pids.set(pid, this.createState());
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
        if (state.bytes + text.length > this.maxQueuedBytes)
            return { ok: false };
        return this.enqueue(state, { data: text, ended: false }, text.length);
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
            state.bytes += packet.data.length;
        // A reader already waiting takes what came back.
        const waiter = state.waiters.shift();
        if (waiter) {
            clearTimeout(waiter.timer);
            const next = state.packets.shift();
            state.bytes -= next.data.length;
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
        this.end(pid);
        this.pids.delete(pid);
    }
    async read(pid, waitMs = 1000) {
        if (!isValidPid(pid))
            return { data: '', ended: true };
        const state = this.pids.get(pid);
        if (!state)
            return { data: '', ended: true };
        state.reading = true;
        let next = state.packets.shift();
        if (next !== undefined) {
            state.bytes -= next.data.length;
            // Piped bytes queued back to back leave in one packet, one round trip:
            // a pipe is written a piece at a time, and a reader wants all it can get.
            if (next.data instanceof Uint8Array && isPlainData(next)) {
                const run = [next.data];
                let size = next.data.byteLength;
                while (state.packets.length > 0) {
                    const peek = state.packets[0];
                    if (!(peek.data instanceof Uint8Array) || !isPlainData(peek))
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
        if (state.closed)
            return { data: '', ended: true };
        return new Promise((resolve) => {
            const waiter = {
                resolve,
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
