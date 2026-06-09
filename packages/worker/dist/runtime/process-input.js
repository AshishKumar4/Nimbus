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
        return { packets: [], closed: false, bytes: 0, waiters: [], columns: 80, rows: 24 };
    }
    open(pid) {
        if (!isValidPid(pid) || this.pids.has(pid))
            return;
        this.pids.set(pid, this.createState());
    }
    has(pid) {
        return this.pids.has(pid);
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
        state.packets.push(packet);
        state.bytes += bytes;
        return { ok: true };
    }
    end(pid) {
        const state = this.pids.get(pid);
        if (!state || state.closed)
            return;
        state.closed = true;
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
        const next = state.packets.shift();
        if (next !== undefined) {
            state.bytes -= next.data.length;
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
