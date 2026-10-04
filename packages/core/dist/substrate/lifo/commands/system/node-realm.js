/**
 * The inline `node`'s realm: each run is a worker thread of its own.
 *
 * The program used to be evaluated with `new Function` in the host's realm,
 * so its globals and intrinsics were the host's: a program that rebound
 * `Array` or installed fake timers changed them for the host (in Kinu's CLI, a
 * rebound `globalThis.Array` broke the host's sqlite-vfs). A worker thread is
 * a realm and an event loop of its own, which ends when its program does, and
 * `terminate()` ends even a loop that never yields. A `vm` context is a realm
 * too, but every host object handed into it (the fs bridge, Buffer, the
 * http module) carries the host's prototypes, a sync loop in it cannot be
 * stopped, and a blocking read could only block the host's own thread.
 *
 * The guest (node-guest.ts) runs node.ts's runNodeProgram. What it reaches
 * outside its realm crosses here:
 *
 *   - synchronous calls (the filesystem `require` and `fs` read, fd 0, the
 *     session's ports): the guest posts the call on `calls` and waits on
 *     `wake` (Atomics.wait); this side answers on `calls` and wakes it, and
 *     the guest takes the answer with receiveMessageOnPort. Only answers
 *     travel guest-bound on `calls`, so nothing else can be taken for one.
 *     A call this side answers asynchronously (fd 0, read to its end) holds
 *     the guest exactly as a blocking read holds a Node program;
 *   - asynchronous traffic, on `events`: its output, the requests its loopback
 *     clients make, the requests this side forwards to its servers, its exit.
 *
 * Bun and Node both carry node:worker_threads, SharedArrayBuffer and
 * Atomics.wait in workers; workerd does not, and its sessions run their own
 * `node` (worker hosted/commands.ts).
 */
import { synchronousFilesystem } from '../../node-compat/filesystem.js';
import { dispatchWorkspaceRequest } from '../net/kernel-fetch.js';
// ── The protocol's messages, narrowed where they arrive ─────────────────────
// Each side receives a structured clone it must narrow: a guard per shape.
const record = (value) => typeof value === 'object' && value !== null;
export function isRealmCall(value) {
    if (!record(value))
        return false;
    switch (value.op) {
        case 'fs': return typeof value.method === 'string' && Array.isArray(value.args);
        case 'stdin': return true;
        case 'listen':
        case 'unlisten': return typeof value.port === 'number';
        case 'watch': return typeof value.on === 'boolean';
        default: return false;
    }
}
export function isRealmAnswer(value) {
    return record(value) && ('value' in value || (record(value.error) && typeof value.error.message === 'string'));
}
const isResponse = (value) => value === null || (record(value) && typeof value.status === 'number' && record(value.headers) && typeof value.body === 'string');
export function isGuestEvent(value) {
    if (!record(value))
        return false;
    switch (value.type) {
        case 'output': return (value.fd === 1 || value.fd === 2) && (typeof value.data === 'string' || value.data instanceof Uint8Array);
        case 'fetch': return typeof value.id === 'number' && typeof value.port === 'number' && typeof value.url === 'string';
        case 'served': return typeof value.id === 'number' && isResponse(value.response);
        case 'exit': return typeof value.code === 'number';
        default: return false;
    }
}
export function isHostEvent(value) {
    if (!record(value))
        return false;
    switch (value.type) {
        case 'fetched': return typeof value.id === 'number' && isResponse(value.response);
        case 'serve': return typeof value.id === 'number' && typeof value.port === 'number' && record(value.request);
        case 'changed': return true;
        default: return false;
    }
}
export function isRealmStart(value) {
    return record(value) && record(value.program) && typeof value.program.source === 'string'
        && value.wake instanceof SharedArrayBuffer && record(value.calls) && record(value.events);
}
export function isStat(value) {
    return record(value) && typeof value.type === 'string' && typeof value.mode === 'number' && typeof value.size === 'number';
}
export function isDirEntries(value) {
    return Array.isArray(value) && value.every((entry) => record(entry) && typeof entry.name === 'string' && typeof entry.type === 'string');
}
/** An error as data: its class name, message and own properties (code, syscall, path, errno). */
export function realmError(error) {
    if (!(error instanceof Error))
        return { name: 'Error', message: String(error), properties: {} };
    const properties = {};
    for (const key of Object.getOwnPropertyNames(error)) {
        if (key === 'message' || key === 'stack')
            continue;
        const value = Reflect.get(error, key);
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
            properties[key] = value;
    }
    return { name: error.name, message: error.message, properties };
}
/**
 * Run `program` in a worker of its own, serving what it reaches from `ctx` and
 * `kernel`. Resolves with its exit code once its realm has ended: its event
 * loop ran empty, or the caller's abort (kill, Ctrl-C) terminated it.
 */
export async function runNodeInRealm(program, ctx, kernel) {
    if (ctx.signal.aborted)
        return 130;
    let threads;
    try {
        // Imported when a program runs, not with the module: workerd, which loads
        // this module in the hosted session, has no worker threads.
        threads = await import('node:worker_threads');
    }
    catch {
        await ctx.stderr.write('node: this host has no worker threads, which the inline node runs each program in (Bun and Node have them)\n');
        return 1;
    }
    const calls = new threads.MessageChannel();
    const events = new threads.MessageChannel();
    const wake = new SharedArrayBuffer(4);
    const flag = new Int32Array(wake);
    const filesystem = synchronousFilesystem(ctx.vfs);
    const start = { program, calls: calls.port2, events: events.port2, wake };
    const worker = new threads.Worker(new URL('./node-guest.js', import.meta.url), {
        workerData: start,
        transferList: [calls.port2, events.port2],
    });
    // Output in the order it was written, each write after the last.
    let written = Promise.resolve();
    const write = (stream, data) => {
        written = written.then(async () => {
            if (typeof data === 'string')
                await stream.write(data);
            else if (stream.writeBytes)
                await stream.writeBytes(data);
            else
                await stream.write(new TextDecoder().decode(data));
        }).catch(() => { });
    };
    const answer = (reply) => {
        calls.port1.postMessage(reply);
        Atomics.store(flag, 0, 1);
        Atomics.notify(flag, 0);
    };
    const ports = new Set();
    const pending = new Map();
    let served = 0;
    // A server of the guest's, as the session's other processes reach it.
    const serveFromGuest = (port) => (request, response) => {
        const id = ++served;
        const done = new Promise((resolve) => {
            pending.set(id, (reply) => {
                if (reply)
                    Object.assign(response, { statusCode: reply.status, headers: reply.headers, body: reply.body });
                else
                    Object.assign(response, { statusCode: 502, headers: { 'content-type': 'text/plain' }, body: 'Bad Gateway: the server has ended\n' });
                resolve();
            });
        });
        Object.assign(response, { _donePromise: done });
        events.port1.postMessage({ type: 'serve', id, port, request });
    };
    let unwatch;
    let stdinTaken = false;
    const call = async (request) => {
        switch (request.op) {
            case 'fs': {
                const fs = filesystem();
                return Reflect.apply(fs[request.method], fs, request.args);
            }
            case 'stdin': {
                if (stdinTaken || !ctx.stdin || ctx.stdin === ctx.terminalStdin)
                    return new Uint8Array(0);
                stdinTaken = true;
                return await readToEnd(ctx.stdin);
            }
            case 'listen':
                if (!kernel)
                    throw Object.assign(new Error(`listen EACCES: no ports on this host :${request.port}`), { code: 'EACCES' });
                kernel.portRegistry.set(request.port, serveFromGuest(request.port));
                ports.add(request.port);
                return undefined;
            case 'unlisten':
                if (ports.delete(request.port))
                    kernel?.portRegistry.delete(request.port);
                return undefined;
            case 'watch': {
                const fs = filesystem();
                if (request.on) {
                    const listener = () => events.port1.postMessage({ type: 'changed' });
                    fs.onChange = listener;
                    unwatch = () => { if (fs.onChange === listener)
                        fs.onChange = undefined; };
                }
                else {
                    unwatch?.();
                    unwatch = undefined;
                }
                return undefined;
            }
        }
    };
    calls.port1.on('message', (request) => {
        if (!isRealmCall(request))
            return;
        // Answered as soon as known; fd 0 waits for its end, holding the guest as Node's read does.
        void call(request).then((value) => answer({ value }), (error) => answer({ error: realmError(error) }));
    });
    let code = null;
    const onEvent = (event) => {
        if (!isGuestEvent(event))
            return;
        switch (event.type) {
            case 'output':
                write(event.fd === 1 ? ctx.stdout : ctx.stderr, event.data);
                return;
            case 'exit':
                code = event.code;
                return;
            case 'served':
                pending.get(event.id)?.(event.response);
                pending.delete(event.id);
                return;
            case 'fetch':
                void fetchForGuest(kernel, event).then((response) => {
                    events.port1.postMessage({ type: 'fetched', id: event.id, response });
                });
                return;
        }
    };
    events.port1.on('message', onEvent);
    // A kill or Ctrl-C ends the realm, even in a loop that never yields.
    let aborted = false;
    const abort = () => {
        aborted = true;
        void worker.terminate();
    };
    ctx.signal.addEventListener('abort', abort, { once: true });
    let failure = null;
    worker.on('error', (error) => { failure = error; });
    const exited = await new Promise((resolve) => worker.once('exit', resolve));
    ctx.signal.removeEventListener('abort', abort);
    // What the guest posted before it ended, its last output and its exit code
    // among it, may still be queued: the worker's exit does not wait for it.
    for (let left = threads.receiveMessageOnPort(events.port1); left; left = threads.receiveMessageOnPort(events.port1)) {
        onEvent(left.message);
    }
    for (const port of ports)
        kernel?.portRegistry.delete(port);
    for (const respond of pending.values())
        respond(null);
    unwatch?.();
    calls.port1.close();
    events.port1.close();
    await written;
    if (aborted)
        return 130;
    if (failure !== null) {
        const error = failure;
        await ctx.stderr.write(`${error.stack ?? error.message}\n`);
        return code ?? 1;
    }
    return code ?? exited;
}
/** All of `stdin`, to its end. */
async function readToEnd(stdin) {
    if (!stdin.readBytes)
        return new TextEncoder().encode(await stdin.readAll());
    const pieces = [];
    let length = 0;
    for (let piece = await stdin.readBytes(65536); piece !== null; piece = await stdin.readBytes(65536)) {
        pieces.push(piece);
        length += piece.length;
    }
    const all = new Uint8Array(length);
    let at = 0;
    for (const piece of pieces) {
        all.set(piece, at);
        at += piece.length;
    }
    return all;
}
/** A loopback request of the guest's, served as the session serves its own: the kernel's ports, then its loopback router. */
async function fetchForGuest(kernel, event) {
    if (!kernel)
        return null;
    const request = new Request(event.url, { method: event.method, headers: event.headers, body: event.body });
    let result;
    try {
        result = await dispatchWorkspaceRequest(kernel, event.port, request);
    }
    catch {
        return null;
    }
    if (result.kind !== 'response')
        return null;
    const headers = {};
    result.response.headers.forEach((value, key) => { headers[key] = value; });
    return { status: result.response.status, headers, body: await result.response.text() };
}
