/**
 * An inline `node` run, inside the worker that is its realm (node-realm.ts).
 *
 * Everything the program reaches outside the realm goes through the host
 * (runtime/realm-guest.ts): the filesystem and fd 0 by synchronous calls,
 * its output and its network by events. The realm is joined before the
 * program runs, and its ports live only in this module's closure.
 *
 * The realm lives as a Node process does: while its event loop has work. Its
 * own timers hold it; so does `events` while a server it started listens and
 * while a request it made is unanswered (its synchronous calls need no loop). A
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
const { program } = joined.payload;
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
/** `events` holds the realm open while anything of the program's waits on it. */
function holdWhileBusy() {
    if (fetched.size > 0 || ports.size > 0)
        events.ref();
    else
        events.unref();
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
