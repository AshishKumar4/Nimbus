/**
 * An inline `node` run, inside the worker that is its realm (node-realm.ts).
 *
 * Everything the program reaches outside the realm goes through the host:
 * the filesystem and fd 0 by synchronous calls (the guest waits on `wake`
 * until the answer is on `calls`), its output and its network by messages on
 * `events`. Once its main script has run (and any servers it started have
 * closed), `events` stops holding the realm open, so the realm ends when its
 * event loop runs empty, as a Node process does.
 */
import realm from 'node:process';
import { receiveMessageOnPort, workerData } from 'node:worker_threads';
import { ProcessExitError } from '../../node-compat/index.js';
import { runNodeProgram } from './node.js';
import { isDirEntries, isHostEvent, isRealmAnswer, isRealmStart, isStat, } from './node-realm.js';
if (!isRealmStart(workerData))
    throw new Error('node-guest: started without a realm');
const { calls, events, program } = workerData;
const flag = new Int32Array(workerData.wake);
/** A synchronous call to the host: posted, then waited for. Its value is the host's answer, as cloned. */
function call(request) {
    Atomics.store(flag, 0, 0);
    calls.postMessage(request);
    for (;;) {
        Atomics.wait(flag, 0, 0);
        const received = receiveMessageOnPort(calls);
        if (received && isRealmAnswer(received.message)) {
            const answer = received.message;
            if ('error' in answer)
                throw rebuild(answer.error);
            return answer.value;
        }
    }
}
/** A host answer that is not the shape its call returns: a broken realm, not a program error. */
function malformed(method) {
    throw new Error(`node: the host answered ${method} with something it does not return`);
}
/** The host's error as the program would have got it: its class, message and own properties. */
function rebuild(error) {
    const Class = error.name === 'TypeError' ? TypeError : error.name === 'RangeError' ? RangeError : Error;
    const rebuilt = new Class(error.message);
    for (const [key, value] of Object.entries(error.properties))
        Reflect.set(rebuilt, key, value);
    return rebuilt;
}
function post(event) {
    events.postMessage(event);
}
// The host's filesystem, each method's answer narrowed to what it returns.
const bytes = (value, method) => value instanceof Uint8Array ? value : malformed(method);
const text = (value, method) => typeof value === 'string' ? value : malformed(method);
const flagOf = (value, method) => typeof value === 'boolean' ? value : malformed(method);
const stat = (value, method) => isStat(value) ? value : malformed(method);
let changed;
const filesystem = {
    readFile: (path) => bytes(call({ op: 'fs', method: 'readFile', args: [path] }), 'readFile'),
    readFileString: (path) => text(call({ op: 'fs', method: 'readFileString', args: [path] }), 'readFileString'),
    writeFile: (path, data) => { call({ op: 'fs', method: 'writeFile', args: [path, data] }); },
    appendFile: (path, data) => { call({ op: 'fs', method: 'appendFile', args: [path, data] }); },
    exists: (path) => flagOf(call({ op: 'fs', method: 'exists', args: [path] }), 'exists'),
    isFile: (path) => flagOf(call({ op: 'fs', method: 'isFile', args: [path] }), 'isFile'),
    isDirectory: (path) => flagOf(call({ op: 'fs', method: 'isDirectory', args: [path] }), 'isDirectory'),
    stat: (path) => stat(call({ op: 'fs', method: 'stat', args: [path] }), 'stat'),
    lstat: (path) => stat(call({ op: 'fs', method: 'lstat', args: [path] }), 'lstat'),
    mkdir: (path, options) => { call({ op: 'fs', method: 'mkdir', args: [path, options] }); },
    readdir: (path) => {
        const entries = call({ op: 'fs', method: 'readdir', args: [path] });
        return isDirEntries(entries) ? entries : malformed('readdir');
    },
    unlink: (path) => { call({ op: 'fs', method: 'unlink', args: [path] }); },
    rmdir: (path) => { call({ op: 'fs', method: 'rmdir', args: [path] }); },
    rmdirRecursive: (path) => { call({ op: 'fs', method: 'rmdirRecursive', args: [path] }); },
    rename: (from, to) => { call({ op: 'fs', method: 'rename', args: [from, to] }); },
    copyFile: (from, to) => { call({ op: 'fs', method: 'copyFile', args: [from, to] }); },
    chmod: (path, mode) => { call({ op: 'fs', method: 'chmod', args: [path, mode] }); },
    get onChange() { return changed; },
    set onChange(listener) {
        changed = listener;
        call({ op: 'watch', on: listener !== undefined });
    },
};
const output = (fd) => ({
    write: (data) => post({ type: 'output', fd, data }),
    writeBytes: (data) => post({ type: 'output', fd, data }),
});
/** The program's servers, as the session reaches them: listening is the host's to record. */
class RealmPorts extends Map {
    set(port, handler) {
        call({ op: 'listen', port });
        return super.set(port, handler);
    }
    delete(port) {
        if (super.has(port))
            call({ op: 'unlisten', port });
        return super.delete(port);
    }
}
const ports = new RealmPorts();
// While the main script runs, `events` holds the realm open; after it, only
// what is still under way does: a request awaiting its answer, as a socket
// holds a Node process.
let mainDone = false;
const holdWhileBusy = () => {
    if (fetched.size > 0 || !mainDone)
        events.ref();
    else
        events.unref();
};
let fetches = 0;
const fetched = new Map();
async function routeLoopback(port, request) {
    const id = ++fetches;
    const headers = {};
    request.headers.forEach((value, key) => { headers[key] = value; });
    const body = request.body ? await request.text() : null;
    const answer = new Promise((resolve) => fetched.set(id, resolve));
    holdWhileBusy();
    post({ type: 'fetch', id, port, url: request.url, method: request.method, headers, body });
    const response = await answer;
    if (!response)
        return null;
    const empty = response.status === 204 || response.status === 304;
    return new Response(empty ? null : response.body, { status: response.status, headers: response.headers });
}
/** A request the host forwards to one of the program's servers. */
async function serve(id, port, request) {
    const handler = ports.get(port);
    if (!handler) {
        post({ type: 'served', id, response: null });
        return;
    }
    const response = { statusCode: 200, headers: {}, body: '' };
    try {
        handler(request, response);
        if (response._donePromise)
            await response._donePromise;
        post({ type: 'served', id, response: { status: response.statusCode, headers: response.headers, body: response.body } });
    }
    catch {
        post({ type: 'served', id, response: null });
    }
}
events.on('message', (event) => {
    if (!isHostEvent(event))
        return;
    switch (event.type) {
        case 'fetched':
            fetched.get(event.id)?.(event.response);
            fetched.delete(event.id);
            holdWhileBusy();
            return;
        case 'serve':
            void serve(event.id, event.port, event.request);
            return;
        case 'changed':
            changed?.();
            return;
    }
});
const rejectionListeners = new Set();
// A rejection nothing handled: the main script's own are reported to it; one
// after it, as in Node, ends the process with 1 once it is printed.
realm.on('unhandledRejection', (reason) => {
    if (reason instanceof ProcessExitError) {
        post({ type: 'exit', code: reason.exitCode });
        realm.exit(reason.exitCode);
    }
    if (rejectionListeners.size > 0) {
        for (const listener of rejectionListeners)
            listener(reason);
        return;
    }
    post({ type: 'output', fd: 2, data: `${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n` });
    post({ type: 'exit', code: 1 });
    realm.exit(1);
});
// An exception no code caught, after the main script ran (a timer's): as in
// Node, it is printed and the process exits 1; process.exit() from a timer
// exits with its code.
realm.on('uncaughtException', (error) => {
    if (error instanceof ProcessExitError) {
        post({ type: 'exit', code: error.exitCode });
        realm.exit(error.exitCode);
    }
    post({ type: 'output', fd: 2, data: `${error instanceof Error ? error.stack ?? error.message : String(error)}\n` });
    post({ type: 'exit', code: 1 });
    realm.exit(1);
});
const end = await runNodeProgram(program, {
    filesystem: () => filesystem,
    stdout: output(1),
    stderr: output(2),
    stdin: () => bytes(call({ op: 'stdin' }), 'stdin'),
    portRegistry: ports,
    routeLoopback,
    onUnhandledRejection: (listener) => {
        rejectionListeners.add(listener);
        return () => rejectionListeners.delete(listener);
    },
});
post({ type: 'exit', code: end.code });
// process.exit() or an error the main script did not catch ends the process
// at once, as in Node. Otherwise what the main script left (timers) runs on,
// and the realm ends when nothing is left, as a Node process does.
if (end.ended)
    realm.exit(end.code);
mainDone = true;
holdWhileBusy();
