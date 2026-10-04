/**
 * realm.ts — a program's realm of its own: a worker thread, and what crosses.
 *
 * The library host used to evaluate what it ran in its own realm, so a
 * program's globals and intrinsics were the host's: an inline `node` program
 * that rebound `Array` or installed fake timers changed them for the host,
 * and so did a Ruby program through its `js` bridge in a facet. A worker
 * thread is a realm and an event loop of its own, and `terminate()` ends it
 * even in a loop that never yields. A `vm` context is a realm too, but every
 * host object handed into it carries the host's prototypes, a sync loop in it
 * cannot be stopped, and a blocking read could only block the host's own
 * thread.
 *
 * This is the one mechanism both realms use: the inline `node`'s run
 * (substrate/lifo/commands/system/node-realm.ts) and a facet of the local
 * facet host (local-facet-host.ts). The guest's side is realm-guest.ts. What
 * crosses:
 *
 *   - calls, guest to host, on `calls`: each names its id, and the host
 *     answers it there, value or error, then sets `wake` and notifies it. The
 *     guest may wait for an answer synchronously (Atomics.wait on `wake`, the
 *     answer taken with receiveMessageOnPort), which holds its thread as a
 *     blocking syscall holds a process, or asynchronously. Only answers travel
 *     guest-bound on `calls`, so nothing else can be taken for one;
 *   - events, either way, on `events`: whatever the realm's user says they
 *     are, each narrowed where it arrives.
 *
 * The guest is untrusted (the program shares its realm), so the ports reach
 * it by its first message, never through `workerData` a program can import,
 * and nothing it sends, no answer that cannot cross and no failed call ends
 * the host.
 *
 * Bun and Node both carry node:worker_threads, SharedArrayBuffer and
 * Atomics.wait in workers; workerd does not, and has isolates of its own.
 */
import { isVfsErrorCode, VfsError } from '../vfs/vfs-error.js';
const record = (value) => typeof value === 'object' && value !== null;
export function isRealmStart(value) {
    return record(value) && 'payload' in value && value.wake instanceof SharedArrayBuffer && record(value.calls) && record(value.events);
}
export function isRealmCall(value) {
    return record(value) && Number.isSafeInteger(value.id) && 'request' in value;
}
export function isRealmAnswer(value) {
    return record(value) && Number.isSafeInteger(value.id)
        && ('value' in value || (record(value.error) && typeof value.error.message === 'string'));
}
// ── Errors, either way across ─────────────────────────────────────────────────
/** An error as data: its class name, message and own primitive properties (code, syscall, path, errno, dest, detail). */
export function realmError(error) {
    if (!(error instanceof Error))
        return { name: 'Error', message: String(error), properties: {} };
    const properties = {};
    for (const key of Object.getOwnPropertyNames(error)) {
        if (key === 'message' || key === 'stack')
            continue;
        const value = Reflect.get(error, key);
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
            properties[key] = value;
    }
    return { name: error.name, message: error.message, properties };
}
/**
 * The error `error` was: a VfsError as a VfsError (node-compat's fs tells a
 * filesystem refusal by its class, as `rm(..., { force: true })` of a missing
 * path does), a standard class as itself, else an Error bearing its name; with
 * its message and own properties.
 */
export function fromRealmError(error) {
    const text = (key) => {
        const value = error.properties[key];
        return typeof value === 'string' ? value : undefined;
    };
    const code = error.properties.code;
    let rebuilt;
    if (error.name === 'VfsError' && isVfsErrorCode(code)) {
        rebuilt = new VfsError(code, '', text('path'), { syscall: text('syscall'), dest: text('dest'), detail: text('detail') });
    }
    else {
        const Standard = error.name === 'TypeError' ? TypeError : error.name === 'RangeError' ? RangeError : error.name === 'SyntaxError' ? SyntaxError : Error;
        rebuilt = new Standard(error.message);
        if (rebuilt.name !== error.name)
            Object.defineProperty(rebuilt, 'name', { value: error.name, configurable: true, writable: true });
    }
    Object.defineProperty(rebuilt, 'message', { value: error.message, configurable: true, writable: true });
    for (const [key, value] of Object.entries(error.properties)) {
        if (key === 'name' || Object.hasOwn(rebuilt, key))
            continue;
        Object.defineProperty(rebuilt, key, { value, configurable: true, enumerable: true, writable: true });
    }
    return rebuilt;
}
/**
 * What `perform` came to, as an outcome the guest can be sent: its value, or
 * the error it raised; an error, too, for a value that cannot cross. Never
 * rejects.
 */
export async function realmOutcome(perform) {
    try {
        const value = await perform();
        // Proven to cross before it is posted: a value that cannot is an error.
        structuredClone(value);
        return { value };
    }
    catch (error) {
        return { error: realmError(error) };
    }
}
/**
 * Starts a realm running `options.entry`, or answers why this host has none:
 * one without node:worker_threads (workerd, which loads this module in the
 * hosted session, has isolates of its own).
 */
export async function startRealm(options) {
    let threads;
    try {
        // Imported when a realm starts, not with the module: a platform module
        // workerd, which loads this module in the hosted session, does not have.
        threads = await import('node:worker_threads');
    }
    catch {
        return { unavailable: 'this host has no worker threads (Bun and Node have them)' };
    }
    const calls = new threads.MessageChannel();
    const events = new threads.MessageChannel();
    const wake = new SharedArrayBuffer(4);
    const flag = new Int32Array(wake);
    const worker = new threads.Worker(options.entry);
    const start = { payload: options.payload, calls: calls.port2, events: events.port2, wake };
    worker.postMessage(start, [calls.port2, events.port2]);
    let over = false;
    // Posted, or the post's own failure posted; the guest is woken either way.
    const answer = (id, outcome) => {
        if (over)
            return;
        try {
            calls.port1.postMessage({ id, ...outcome });
        }
        catch (error) {
            try {
                calls.port1.postMessage({ id, error: realmError(error) });
            }
            catch { /* the port is gone */ }
        }
        Atomics.store(flag, 0, 1);
        Atomics.notify(flag, 0);
    };
    calls.port1.on('message', (call) => {
        // Answered as soon as known; a call that waits (fd 0 read to its end) holds the guest as a blocking read does.
        if (!isRealmCall(call))
            return;
        void realmOutcome(() => options.serve(call.request)).then((outcome) => answer(call.id, outcome));
    });
    events.port1.on('message', (event) => options.onEvent(event));
    let terminated = false;
    let failure = null;
    worker.on('error', (error) => { failure = error; });
    const ended = new Promise((resolve) => {
        worker.once('exit', (code) => {
            over = true;
            // What the guest posted before it ended, its last output and its exit
            // code among it, may still be queued: the worker's exit does not wait for it.
            for (let left = threads.receiveMessageOnPort(events.port1); left; left = threads.receiveMessageOnPort(events.port1)) {
                options.onEvent(left.message);
            }
            calls.port1.close();
            events.port1.close();
            resolve({ code, failure, terminated });
        });
    });
    return {
        post(event) {
            if (over)
                return false;
            try {
                events.port1.postMessage(event);
                return true;
            }
            catch {
                return false;
            }
        },
        terminate() {
            if (over || terminated)
                return;
            terminated = true;
            void worker.terminate().catch(() => { });
        },
        hold(on) {
            for (const handle of [worker, calls.port1, events.port1]) {
                if (on)
                    handle.ref();
                else
                    handle.unref();
            }
        },
        ended,
    };
}
