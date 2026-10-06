/**
 * An inline `node` run, inside the worker that is its realm (node-realm.ts).
 *
 * Everything the program reaches outside the realm goes through the host
 * (runtime/realm-guest.ts): the filesystem and fd 0 by synchronous calls,
 * its output and its network by events. The realm is joined before the
 * program runs, and its ports live only in this module's closure.
 *
 * The realm lives as a Node process does: while its event loop has work. Its
 * own timers hold it; so does `events` while a server it started listens, while
 * a request it made is unanswered and while it waits on a response body (its
 * synchronous calls need no loop). A
 * rejection or exception nothing handles is printed and ends it with 1, an
 * ES module whose top-level await never settles with 13.
 */
import realm from 'node:process';
import { joinRealm } from '../../../../runtime/realm-guest.js';
import { ProcessExitError } from '../../node-compat/index.js';
import { runNodeProgram } from './node.js';
import { isDirEntries, isHostEvent, isNodeRealmPayload, isStat, } from './node-realm.js';
const joined = await joinRealm();
if (!isNodeRealmPayload(joined.payload))
    throw new Error('node-guest: started without a program');
const { program, egress } = joined.payload;
const { events } = joined;
/** A synchronous call to the host: its value is the host's answer, as cloned. */
const call = (request) => joined.call(request);
/** A host answer that is not the shape its call returns: a broken realm, not a program error. */
function malformed(method) {
    throw new Error(`node: the host answered ${method} with something it does not return`);
}
function post(event) {
    joined.post(event);
}
// ── Liveness ────────────────────────────────────────────────────────────────
let mainDone = false;
let exiting = false;
const fetched = new Map();
/**
 * Answers the program waits on from off the box (a response's head, a chunk
 * of a body it is reading): each holds the realm, as an active socket holds a
 * Node process. A body it is not reading holds nothing, as in Node.
 */
let awaitedOffTheBox = 0;
/** `events` holds the realm open while anything of the program's waits on it. */
function holdWhileBusy() {
    joined.hold(fetched.size > 0 || ports.size > 0 || awaitedOffTheBox > 0);
}
/** End the process now with `code`, as process.exit() and a fatal error do. */
function exitNow(code) {
    exiting = true;
    post({ type: 'exit', code });
    return realm.exit(code);
}
// ── The filesystem, each method's answer narrowed to what it returns ───────
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
/** The program's servers, as the session reaches them: listening is the host's to record, and holds the realm. */
class RealmPorts extends Map {
    set(port, handler) {
        call({ op: 'listen', port });
        super.set(port, handler);
        holdWhileBusy();
        return this;
    }
    delete(port) {
        if (super.has(port))
            call({ op: 'unlisten', port });
        const deleted = super.delete(port);
        holdWhileBusy();
        return deleted;
    }
}
const ports = new RealmPorts();
let fetches = 0;
/** The program's requests off the box, by id: each takes the answers that cross back for it. */
const offTheBox = new Map();
/** A Request's redirect mode, as its type names it (a string, in the platform's typing). */
function redirectMode(mode) {
    if (mode === 'follow' || mode === 'manual' || mode === 'error')
        return mode;
    throw new TypeError(`fetch: unknown redirect mode ${JSON.stringify(mode)}`);
}
/** Statuses whose response has no body (the Response constructor refuses one). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
/**
 * `request` off the box: it crosses to the host, which sends it out through
 * the egress and follows its redirects as the program asked. The response is
 * the program's once its head arrives; its body is read from the host as the
 * program reads it. Fails as Node's fetch fails: `fetch failed` before the
 * head, `terminated` in the body, the signal's reason on an abort.
 */
function sendOffTheBox(request, body) {
    const id = ++fetches;
    const signal = request.signal;
    return new Promise((resolve, reject) => {
        let awaiting = false;
        const await_ = (on) => {
            if (awaiting === on)
                return;
            awaiting = on;
            awaitedOffTheBox += on ? 1 : -1;
            holdWhileBusy();
        };
        let stream;
        /** Settles the stream's pull, once its chunk, end or error has arrived. */
        let pulled;
        const done = () => {
            offTheBox.delete(id);
            signal.removeEventListener('abort', aborted);
            await_(false);
            pulled?.();
            pulled = undefined;
        };
        const aborted = () => {
            post({ type: 'egress-cancel', id });
            if (stream)
                stream.error(signal.reason);
            else
                reject(signal.reason);
            done();
        };
        const head = (answer) => {
            await_(false);
            const withBody = answer.body && !NULL_BODY_STATUSES.has(answer.status);
            if (answer.body && !withBody) {
                post({ type: 'egress-cancel', id });
                done();
            }
            else if (!withBody) {
                done();
            }
            const source = withBody ? new ReadableStream({
                start: (controller) => { stream = controller; },
                pull: () => new Promise((settle) => {
                    pulled = settle;
                    await_(true);
                    post({ type: 'egress-pull', id });
                }),
                cancel: () => {
                    post({ type: 'egress-cancel', id });
                    done();
                },
            }, { highWaterMark: 0 }) : null;
            let response;
            try {
                response = new Response(source, { status: answer.status, statusText: answer.statusText, headers: answer.headers.map(([name, value]) => [name, value]) });
            }
            catch (error) {
                post({ type: 'egress-cancel', id });
                done();
                reject(new TypeError('fetch failed', { cause: error }));
                return;
            }
            // Where the response came from, as Node's fetch reports it.
            Object.defineProperties(response, { url: { value: answer.url }, redirected: { value: answer.redirected } });
            resolve(response);
        };
        offTheBox.set(id, (answer) => {
            switch (answer.type) {
                case 'egress-head':
                    head(answer.head);
                    return;
                case 'egress-chunk':
                    await_(false);
                    stream?.enqueue(answer.chunk);
                    pulled?.();
                    pulled = undefined;
                    return;
                case 'egress-end':
                    stream?.close();
                    done();
                    return;
                case 'egress-error': {
                    const cause = new Error(answer.message);
                    if (stream)
                        stream.error(new TypeError('terminated', { cause }));
                    else
                        reject(new TypeError('fetch failed', { cause }));
                    done();
                    return;
                }
            }
        });
        signal.addEventListener('abort', aborted, { once: true });
        await_(true);
        post({ type: 'egress', id, request: { url: request.url, method: request.method, headers: [...request.headers], body, redirect: redirectMode(request.redirect) } });
    });
}
/**
 * Under an egress, the program's network is its host's: `fetch` (and the
 * http and https modules, which use it) sends every request off the box
 * across to the host, which sends it out through the egress. A WebSocket
 * cannot cross the realm, so it is refused by name.
 */
function routeOffTheBox() {
    globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        request.signal.throwIfAborted();
        const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
        request.signal.throwIfAborted();
        return await sendOffTheBox(request, body);
    };
    globalThis.WebSocket = class {
        constructor() {
            throw new Error("Nimbus: WebSocket is not available to an inline node program when the workspace's network goes through an egress");
        }
    };
}
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
        case 'egress-head':
        case 'egress-chunk':
        case 'egress-end':
        case 'egress-error':
            offTheBox.get(event.id)?.(event);
            return;
    }
});
// ── Fatal errors, as Node ends a process on them ───────────────────────────
const fatal = (reason) => {
    if (reason instanceof ProcessExitError)
        return exitNow(reason.exitCode);
    post({ type: 'output', fd: 2, data: `${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n` });
    return exitNow(1);
};
realm.on('unhandledRejection', fatal);
realm.on('uncaughtException', fatal);
// The loop ran empty with the main script still waiting: an ES module whose
// top-level await never settled.
realm.on('exit', () => {
    if (exiting || mainDone)
        return;
    post({ type: 'output', fd: 2, data: `Warning: Detected unsettled top-level await at ${program.filename}\n` });
    post({ type: 'exit', code: 13 });
});
if (egress)
    routeOffTheBox();
holdWhileBusy();
const end = await runNodeProgram(program, {
    filesystem: () => filesystem,
    stdout: output(1),
    stderr: output(2),
    stdin: () => bytes(call({ op: 'stdin' }), 'stdin'),
    portRegistry: ports,
    routeLoopback,
});
if (end.ended)
    exitNow(end.code);
post({ type: 'exit', code: end.code });
mainDone = true;
holdWhileBusy();
