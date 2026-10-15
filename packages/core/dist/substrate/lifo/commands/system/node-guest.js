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
import { DNSResolver } from '../../kernel/dns-resolver.js';
import { createHostsResolver } from '../../kernel/index.js';
import { uncaughtReport, writeFailure } from '../../node-compat/output-failure.js';
import { ProcessExitError } from '../../node-compat/index.js';
import { useNodeErrorInspect } from '../../../../_shared/node-error.js';
import { runNodeProgram } from './node-program.js';
import { routeFetchThroughHost } from '../../../../runtime/realm-egress-guest.js';
import { isEgressHostEvent } from '../../../../runtime/realm-egress.js';
import { isDirEntries, isHostEvent, isNodeRealmPayload, isStat, } from './node-realm-protocol.js';
// Node's errors show a value as util.inspect does ('a string' quoted), the program's realm's.
useNodeErrorInspect((value, options) => realm.getBuiltinModule('node:util').inspect(value, options));
const joined = await joinRealm();
if (!isNodeRealmPayload(joined.payload))
    throw new Error('node-guest: started without a program');
const { program, hosts, egress } = joined.payload;
// The kernel's resolver, as the host sent it; one with the default /etc/hosts without a kernel.
const dns = hosts === undefined ? createHostsResolver() : new DNSResolver();
if (hosts !== undefined)
    dns.loadHostsFile(hosts);
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
 * Under an egress, the program's network is its host's: `fetch` (and the
 * http and https modules, which use it) crosses to the host, which sends each
 * request out through the egress (runtime/realm-egress.ts). WebSocket frames
 * cross the realm too. What the program waits
 * on from off the box (a response's head, a chunk of a body it is reading)
 * holds the realm, as an active socket holds a Node process.
 */
let offTheBox = null;
/** `events` holds the realm open while anything of the program's waits on it. */
function holdWhileBusy() {
    joined.hold(fetched.size > 0 || ports.size > 0 || persistentWatches > 0 || (offTheBox?.awaited ?? 0) > 0 || settling || stdinWaiting);
}
/** End the process now with `code`, as process.exit() and a fatal error do: a write that fails later is no one's. */
function exitNow(code) {
    exiting = true;
    post({ type: 'exit', code, ended: true });
    return realm.exit(code);
}
/** The program's process, once runNodeProgram has made it. */
let programProcess = null;
// ── The filesystem, each method's answer narrowed to what it returns ───────
const bytes = (value, method) => value instanceof Uint8Array ? value : malformed(method);
const text = (value, method) => typeof value === 'string' ? value : malformed(method);
const flagOf = (value, method) => typeof value === 'boolean' ? value : malformed(method);
const stat = (value, method) => isStat(value) ? value : malformed(method);
const count = (value, method) => Number.isSafeInteger(value) && typeof value === 'number' && value >= 0 ? value : malformed(method);
/** The program's watches (NodeFilesystem.watch), by id: the host tells each its changes. */
const watches = new Map();
let nextWatch = 1;
let persistentWatches = 0;
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
    realpath: (path) => text(call({ op: 'fs', method: 'realpath', args: [path] }), 'realpath'),
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
    open: (path, flags) => count(call({ op: 'fs', method: 'open', args: [path, flags] }), 'open'),
    read: (fd, position, length) => bytes(call({ op: 'fs', method: 'read', args: [fd, position, length] }), 'read'),
    write: (fd, position, data) => count(call({ op: 'fs', method: 'write', args: [fd, position, data] }), 'write'),
    fstat: (fd) => stat(call({ op: 'fs', method: 'fstat', args: [fd] }), 'fstat'),
    ftruncate: (fd, size) => { call({ op: 'fs', method: 'ftruncate', args: [fd, size] }); },
    fsync: (fd) => { call({ op: 'fs', method: 'fsync', args: [fd] }); },
    close: (fd) => { call({ op: 'fs', method: 'close', args: [fd] }); },
    watch: (path, listener, options) => {
        const id = nextWatch++;
        const watch = { listener, persistent: options?.persistent !== false };
        call({ op: 'watch', id, path });
        watches.set(id, watch);
        if (watch.persistent)
            persistentWatches++;
        holdWhileBusy();
        return {
            close() {
                if (!watches.delete(id))
                    return;
                if (watch.persistent)
                    persistentWatches--;
                call({ op: 'watch', id, path: null });
                holdWhileBusy();
            },
            ref() {
                if (!watches.has(id) || watch.persistent)
                    return;
                watch.persistent = true;
                persistentWatches++;
                holdWhileBusy();
            },
            unref() {
                if (!watches.has(id) || !watch.persistent)
                    return;
                watch.persistent = false;
                persistentWatches--;
                holdWhileBusy();
            },
        };
    },
};
/**
 * The program's output `fd`, as its stream (process.stdout, process.stderr)
 * and its console write it: each write crosses to the host, which makes it
 * later. One the host could not make is told to the stream (FailableOutput),
 * with what made it.
 */
function realmOutput(fd) {
    const listeners = [];
    const through = (source) => ({
        write: (data) => postOutput(fd, source, data),
        writeBytes: (data) => postOutput(fd, source, data),
    });
    return {
        stream: { ...through('stream'), onFailure: (listener) => { listeners.push(listener); } },
        console: through('console'),
        fail(error, source) {
            for (const listener of listeners)
                listener(error, source);
        },
    };
}
/** Output writes posted, and the last the host has settled (made, or failed). */
let postedOutput = 0;
let settledOutput = 0;
/** Whether the guest waits for the host to settle its writes (settle): the realm is held meanwhile. */
let settling = false;
function postOutput(fd, source, data) {
    post({ type: 'output', fd, source, data });
    postedOutput++;
}
const outputs = { 1: realmOutput(1), 2: realmOutput(2) };
/** fd 0, a piece at a time, each asked of the host; a read the program waits on (not one it paused) holds the realm. */
const stdinPieces = new Map();
let stdinReads = 0;
let stdinWaiting = false;
const input = {
    read: () => new Promise((resolve) => {
        const id = ++stdinReads;
        stdinPieces.set(id, resolve);
        post({ type: 'stdin-read', id });
    }),
    waiting: (on) => {
        stdinWaiting = on;
        holdWhileBusy();
    },
};
/** What a standard descriptor is, asked of the host once. */
const fdKinds = new Map();
const fdKind = (fd) => {
    if (!fdKinds.has(fd))
        fdKinds.set(fd, call({ op: 'fdKind', fd }));
    return fdKinds.get(fd);
};
const terminal = {
    isatty: (fd) => fdKind(fd) === 'terminal',
    isPipe: (fd) => fdKind(fd) === 'pipe',
    setRawMode: (on) => { call({ op: 'rawMode', on }); },
};
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
    if (isEgressHostEvent(event)) {
        offTheBox?.answer(event);
        return;
    }
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
            watches.get(event.id)?.listener(event.event);
            return;
        case 'stdin':
            stdinPieces.get(event.id)?.(event.data);
            stdinPieces.delete(event.id);
            return;
        case 'output-failed':
            // A stream's failure is heard here, whatever the program makes of it: the host reports it no more.
            if (event.source === 'stream')
                post({ type: 'heard', fd: event.fd });
            outputs[event.fd].fail(writeFailure(event.code, event.pipe), event.source);
            return;
        case 'output-settled':
            settledOutput = event.seq;
            settling = false;
            holdWhileBusy();
            return;
    }
});
// ── Fatal errors, as Node ends a process on them ───────────────────────────
const fatal = (reason) => {
    if (reason instanceof ProcessExitError)
        return exitNow(reason.exitCode);
    postOutput(2, 'console', `${uncaughtReport(reason, (value) => realm.getBuiltinModule('node:util').inspect(value))}\n`);
    return exitNow(1);
};
/** An error nothing caught is the program's process's first (LifoProcess.takeUncaught); one it does not take ends it. */
const uncaught = (origin) => (reason, promise) => {
    if (reason instanceof ProcessExitError || programProcess === null) {
        fatal(reason);
        return;
    }
    try {
        if (origin === 'unhandledRejection' && programProcess.emit('unhandledRejection', reason, promise))
            return;
        if (programProcess.takeUncaught(reason, origin))
            return;
    }
    catch (thrown) {
        fatal(thrown);
    }
    fatal(reason);
};
realm.on('unhandledRejection', uncaught('unhandledRejection'));
realm.on('uncaughtException', uncaught('uncaughtException'));
// The loop ran empty: a program that would hear of a failed write
// (LifoProcess.hearsWriteFailures), whenever it began to listen, waits for its
// writes, as a Node process's are made before it ends. What it hears may run
// more of it, and the loop runs empty again.
realm.on('beforeExit', () => {
    if (settling || settledOutput === postedOutput || programProcess?.hearsWriteFailures() !== true)
        return;
    settling = true;
    post({ type: 'settle', upTo: postedOutput });
    holdWhileBusy();
});
// The loop ran empty with the main script still waiting: an ES module whose
// top-level await never settled.
// The program's status once its loop runs empty: its process.exitCode then
// (set after main ran), told only when it is not the one main ended with.
let finalCode = () => 0;
let mainCode = 0;
realm.on('exit', () => {
    if (exiting)
        return;
    if (mainDone) {
        const code = finalCode();
        if (code !== mainCode)
            post({ type: 'exit', code, ended: false });
        return;
    }
    postOutput(2, 'console', `Warning: Detected unsettled top-level await at ${program.filename}\n`);
    post({ type: 'exit', code: 13, ended: false });
});
if (egress) {
    offTheBox = routeFetchThroughHost(post, holdWhileBusy);
}
holdWhileBusy();
const end = await runNodeProgram(program, {
    filesystem: () => filesystem,
    stdout: outputs[1].console,
    stderr: outputs[2].console,
    stdoutStream: outputs[1].stream,
    stderrStream: outputs[2].stream,
    stdin: () => bytes(call({ op: 'stdin' }), 'stdin'),
    input,
    terminal,
    setUmask: (mask) => { call({ op: 'umask', mask }); },
    started: (process) => { programProcess = process; },
    portRegistry: ports,
    routeLoopback,
    dns,
});
if (end.ended)
    exitNow(end.code);
post({ type: 'exit', code: end.code, ended: false });
mainCode = end.code;
finalCode = end.finalCode;
mainDone = true;
