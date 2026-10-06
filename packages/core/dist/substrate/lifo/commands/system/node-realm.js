/**
 * The inline `node`'s realm: each run is a realm of its own (runtime/realm.ts).
 *
 * The program used to be evaluated with `new Function` in the host's realm,
 * so its globals and intrinsics were the host's: a program that rebound
 * `Array` or installed fake timers changed them for the host (in Kinu's CLI, a
 * rebound `globalThis.Array` broke the host's sqlite-vfs).
 *
 * The guest (node-guest.ts) runs node.ts's runNodeProgram. What it reaches
 * outside its realm crosses here:
 *
 *   - synchronous calls ({@link NodeCall}: the filesystem `require` and `fs`
 *     read, fd 0, the session's ports). A call this side answers
 *     asynchronously (fd 0, read to its end) holds the guest exactly as a
 *     blocking read holds a Node program;
 *   - events: its output, the requests its loopback clients make, the
 *     requests this side forwards to its servers, its exit, and under an
 *     egress the requests it makes off the box, whose responses cross back
 *     as they arrive (runtime/realm-egress.ts).
 *
 * Everything the program sends is untrusted: this side answers only the calls
 * it names below, with arguments of their kind, and never lets a message, an
 * answer that cannot cross, or a failed request end the host.
 *
 * workerd has no worker threads; its sessions run their own `node` (worker
 * hosted/commands.ts).
 */
import { realmOutcome, startRealm } from '../../../../runtime/realm.js';
import { synchronousFilesystem } from '../../node-compat/filesystem.js';
import { VfsError } from '../../../../vfs/vfs-error.js';
import { dispatchWorkspaceRequest } from '../net/kernel-fetch.js';
import { isEgressGuestEvent, isEgressHostEvent, RealmEgress } from '../../../../runtime/realm-egress.js';
// ── The protocol's messages, narrowed where they arrive ─────────────────────
// Each side receives a structured clone it must narrow: a guard per shape.
const record = (value) => typeof value === 'object' && value !== null;
const stringRecord = (value) => record(value) && Object.values(value).every((entry) => typeof entry === 'string');
const isResponse = (value) => value === null || (record(value) && typeof value.status === 'number' && stringRecord(value.headers)
    && (typeof value.body === 'string' || value.body instanceof Uint8Array));
export function isGuestEvent(value) {
    if (isEgressGuestEvent(value))
        return true;
    if (!record(value))
        return false;
    switch (value.type) {
        case 'output': return (value.fd === 1 || value.fd === 2) && (typeof value.data === 'string' || value.data instanceof Uint8Array);
        case 'fetch':
            return Number.isSafeInteger(value.id) && Number.isSafeInteger(value.port) && typeof value.url === 'string'
                && typeof value.method === 'string' && stringRecord(value.headers)
                && (value.body === null || typeof value.body === 'string' || value.body instanceof Uint8Array);
        case 'served': return Number.isSafeInteger(value.id) && isResponse(value.response);
        case 'exit': return Number.isSafeInteger(value.code);
        default: return false;
    }
}
export function isHostEvent(value) {
    if (isEgressHostEvent(value))
        return true;
    if (!record(value))
        return false;
    switch (value.type) {
        case 'fetched': return typeof value.id === 'number' && isResponse(value.response);
        case 'serve': return typeof value.id === 'number' && typeof value.port === 'number' && record(value.request);
        case 'changed': return true;
        default: return false;
    }
}
export function isNodeRealmPayload(value) {
    return record(value) && record(value.program) && typeof value.program.source === 'string' && typeof value.egress === 'boolean';
}
export function isStat(value) {
    return record(value) && typeof value.type === 'string' && typeof value.mode === 'number' && typeof value.size === 'number';
}
export function isDirEntries(value) {
    return Array.isArray(value) && value.every((entry) => record(entry) && typeof entry.name === 'string' && typeof entry.type === 'string');
}
/** A call no method answers, or with arguments not of its kind. */
function refused(what) {
    return new VfsError('EINVAL', `the realm's host answers no ${what}`);
}
const pathArg = (value) => {
    if (typeof value !== 'string')
        throw refused('call without a path');
    return value;
};
const dataArg = (value) => {
    if (typeof value !== 'string' && !(value instanceof Uint8Array))
        throw refused('write of anything but text or bytes');
    return value;
};
const modeArg = (value) => {
    if (!Number.isSafeInteger(value) || typeof value !== 'number')
        throw refused('mode that is not a number');
    return value;
};
const mkdirArg = (value) => {
    if (value === undefined)
        return undefined;
    if (!record(value))
        throw refused('mkdir option that is not an object');
    const recursive = value.recursive === undefined || typeof value.recursive === 'boolean' ? value.recursive : undefined;
    if (value.recursive !== undefined && recursive === undefined)
        throw refused('mkdir option `recursive` that is not a boolean');
    return { ...(recursive === undefined ? {} : { recursive }), ...(value.mode === undefined ? {} : { mode: modeArg(value.mode) }) };
};
const portArg = (value) => {
    if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0 || value > 65535)
        throw refused('port that is not one');
    return value;
};
/** NodeFilesystem's `method` on `args`, each checked to be of its kind: only these, never one the object inherits. */
function callFilesystem(fs, method, args) {
    const [a, b] = args;
    switch (method) {
        case 'readFile': return fs.readFile(pathArg(a));
        case 'readFileString': return fs.readFileString(pathArg(a));
        case 'writeFile': return fs.writeFile(pathArg(a), dataArg(b));
        case 'appendFile': return fs.appendFile(pathArg(a), dataArg(b));
        case 'exists': return fs.exists(pathArg(a));
        case 'isFile': return fs.isFile(pathArg(a));
        case 'isDirectory': return fs.isDirectory(pathArg(a));
        case 'stat': return fs.stat(pathArg(a));
        case 'lstat': return fs.lstat(pathArg(a));
        case 'mkdir': return fs.mkdir(pathArg(a), mkdirArg(b));
        case 'readdir': return fs.readdir(pathArg(a));
        case 'unlink': return fs.unlink(pathArg(a));
        case 'rmdir': return fs.rmdir(pathArg(a));
        case 'rmdirRecursive': return fs.rmdirRecursive(pathArg(a));
        case 'rename': return fs.rename(pathArg(a), pathArg(b));
        case 'copyFile': return fs.copyFile(pathArg(a), pathArg(b));
        case 'chmod': return fs.chmod(pathArg(a), modeArg(b));
        default: throw refused(`filesystem method ${JSON.stringify(String(method))}`);
    }
}
async function performCall(call, services) {
    if (!record(call))
        throw refused('call that is not one');
    switch (call.op) {
        case 'fs': {
            if (!Array.isArray(call.args))
                throw refused('filesystem call without arguments');
            return callFilesystem(services.filesystem(), call.method, call.args);
        }
        case 'stdin': return services.stdin();
        case 'listen': return services.listen(portArg(call.port));
        case 'unlisten': return services.unlisten(portArg(call.port));
        case 'watch': {
            if (typeof call.on !== 'boolean')
                throw refused('watch that is neither on nor off');
            return services.watch(call.on);
        }
        default: throw refused(`call ${JSON.stringify(String(call.op))}`);
    }
}
/**
 * The answer to `call`, whatever the guest sent: the value of one of the calls
 * above, or the error it raised; an error, too, for a call none answers and
 * for a value that cannot cross to the guest. Never rejects.
 */
export function serveRealmCall(call, services) {
    return realmOutcome(() => performCall(call, services));
}
/**
 * Run `program` in a realm of its own, serving what it reaches from `ctx` and
 * `kernel`. Resolves with its exit code once its realm has ended: its event
 * loop ran empty, or the caller's abort (kill, Ctrl-C) terminated it.
 */
export async function runNodeInRealm(program, ctx, kernel) {
    if (ctx.signal.aborted)
        return 130;
    const filesystem = synchronousFilesystem(ctx.vfs);
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
    // The realm, once it has started: a request for one of the guest's servers waits for none before.
    let post = () => false;
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
        if (!post({ type: 'serve', id, port, request })) {
            pending.get(id)?.(null);
            pending.delete(id);
        }
    };
    let unwatch;
    let stdinTaken = false;
    const services = {
        filesystem,
        stdin: async () => {
            if (stdinTaken || !ctx.stdin || ctx.stdin === ctx.terminalStdin)
                return new Uint8Array(0);
            stdinTaken = true;
            return readToEnd(ctx.stdin);
        },
        listen: (port) => {
            if (!kernel)
                throw new VfsError('EACCES', `listen: no ports on this host :${port}`);
            kernel.portRegistry.set(port, serveFromGuest(port));
            ports.add(port);
        },
        unlisten: (port) => {
            if (ports.delete(port))
                kernel?.portRegistry.delete(port);
        },
        watch: (on) => {
            unwatch?.();
            unwatch = undefined;
            if (!on)
                return;
            const fs = filesystem();
            const listener = () => { post({ type: 'changed' }); };
            fs.onChange = listener;
            unwatch = () => { if (fs.onChange === listener)
                fs.onChange = undefined; };
        },
    };
    let code = null;
    const payload = { program, egress: kernel?.network?.egress !== undefined };
    const network = kernel?.network;
    const egress = network?.egress === undefined ? null : new RealmEgress(network, (event) => { post(event); });
    const realm = await startRealm({
        entry: new URL('./node-guest.js', import.meta.url),
        payload,
        serve: (call) => performCall(call, services),
        onEvent: (event) => {
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
                        post({ type: 'fetched', id: event.id, response });
                    });
                    return;
                case 'egress':
                case 'egress-pull':
                case 'egress-cancel':
                    egress?.handle(event);
                    return;
            }
        },
    });
    if ('unavailable' in realm) {
        await ctx.stderr.write(`node: ${realm.unavailable}, and the inline node runs each program in a realm of its own\n`);
        return 1;
    }
    post = (event) => realm.post(event);
    // A kill or Ctrl-C ends the realm, even in a loop that never yields; the
    // signal is checked again once the listener is on, so none is missed.
    const abort = () => realm.terminate();
    ctx.signal.addEventListener('abort', abort, { once: true });
    if (ctx.signal.aborted)
        abort();
    const end = await realm.ended;
    ctx.signal.removeEventListener('abort', abort);
    for (const port of ports)
        kernel?.portRegistry.delete(port);
    for (const respond of pending.values())
        respond(null);
    egress?.close();
    unwatch?.();
    await written;
    if (end.terminated)
        return 130;
    if (end.failure !== null) {
        await ctx.stderr.write(`${end.failure.stack ?? end.failure.message}\n`);
        return code ?? 1;
    }
    return code ?? end.code;
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
/**
 * A loopback request of the guest's, served as the session serves its own:
 * the kernel's ports, then its loopback router. Null when it cannot be made
 * or answered, its body included: a failure is the guest's failed request.
 */
async function fetchForGuest(kernel, event) {
    if (!kernel)
        return null;
    try {
        const request = new Request(event.url, { method: event.method, headers: event.headers, body: event.body });
        const result = await dispatchWorkspaceRequest(kernel, event.port, request);
        if (result.kind !== 'response')
            return null;
        const headers = {};
        result.response.headers.forEach((value, key) => { headers[key] = value; });
        return { status: result.response.status, headers, body: await result.response.text() };
    }
    catch {
        return null;
    }
}
