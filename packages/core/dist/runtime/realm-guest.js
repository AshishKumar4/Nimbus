/**
 * realm-guest.ts — the guest's side of a realm (realm.ts), inside its worker
 * thread or its process.
 *
 * What the host started the realm with is taken before anything of the
 * program's runs, and the channels live only in the closure this answers,
 * never in `workerData` a program can import.
 */
import { createReadStream, readSync, writeSync } from 'node:fs';
import { deserialize, serialize } from 'node:v8';
import { parentPort, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { encodeFrame, FrameReader, fromRealmError, isRealmAnswer, isRealmStart, REALM_FDS, } from './realm.js';
/** Joins the realm the host started this worker or process as. Throws in one no host started. */
export async function joinRealm() {
    return parentPort ? joinThreadRealm(parentPort) : joinProcessRealm();
}
/**
 * The host's first message: taken at once when it is already there, else
 * awaited. The worker can start before the host has posted it (a host
 * descheduled between starting the worker and posting). The listener goes
 * with it, so a program finds parentPort as it would in a worker of its own.
 */
async function firstMessage(port) {
    const ready = receiveMessageOnPort(port);
    if (ready)
        return ready.message;
    return new Promise((resolve) => {
        const take = (message) => {
            port.off('message', take);
            port.unref();
            resolve(message);
        };
        port.on('message', take);
    });
}
async function joinThreadRealm(parent) {
    const start = await firstMessage(parent);
    if (!isRealmStart(start))
        throw new Error('realm: started without a realm');
    const { calls, events } = start;
    const flag = new Int32Array(start.wake);
    const waiting = new Map();
    let ids = 0;
    /** An answer, to the call that waits for it. */
    const deliver = (message) => {
        if (!isRealmAnswer(message))
            return undefined;
        const settle = waiting.get(message.id);
        waiting.delete(message.id);
        settle?.(message);
        return message;
    };
    // Answers to asynchronous calls arrive while the event loop runs; held only while one waits.
    calls.on('message', deliver);
    calls.unref();
    return {
        payload: start.payload,
        call(request) {
            const id = ++ids;
            let own;
            waiting.set(id, (answer) => { own = answer; });
            calls.postMessage({ id, request });
            for (;;) {
                // Cleared, then every answer already there taken, then waited for: an
                // answer posted after the take sets the flag after it was cleared, so
                // the wait returns at once.
                Atomics.store(flag, 0, 0);
                for (let next = receiveMessageOnPort(calls); next; next = receiveMessageOnPort(calls))
                    deliver(next.message);
                if (own)
                    return valueOf(own);
                Atomics.wait(flag, 0, 0);
            }
        },
        callAsync(request) {
            const id = ++ids;
            return new Promise((resolve, reject) => {
                waiting.set(id, (answer) => {
                    if (waiting.size === 0)
                        calls.unref();
                    try {
                        resolve(valueOf(answer));
                    }
                    catch (error) {
                        reject(error);
                    }
                });
                calls.ref();
                calls.postMessage({ id, request });
            });
        },
        post(event) {
            events.postMessage(event);
        },
        events,
        hold(on) {
            if (on)
                events.ref();
            else
                events.unref();
        },
    };
}
function valueOf(answer) {
    if ('error' in answer)
        throw fromRealmError(answer.error);
    return answer.value;
}
/** `length` bytes of `fd`, read synchronously; the host gone is an error. */
function readExactly(fd, length) {
    const bytes = new Uint8Array(length);
    for (let at = 0; at < length;) {
        const read = readSync(fd, bytes, at, length - at, null);
        if (read === 0)
            throw new Error('realm: the host is gone');
        at += read;
    }
    return bytes;
}
/** The next frame on `fd`, read synchronously, deserialized. */
function readFrame(fd) {
    const length = new DataView(readExactly(fd, 4).buffer).getUint32(0, true);
    return deserialize(readExactly(fd, length));
}
/**
 * Its host gone, however it ended (a host killed, or one that exited in the
 * middle of a call), a process realm ends too, even while its own thread
 * spins: a thread of its own watches for its parent to change, and kills the
 * process when it does. A host that ends normally closes the events pipe,
 * which ends an idle realm by itself.
 */
const ORPHAN_WATCH = `const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) process.kill(process.pid, 'SIGKILL'); }, 500);`;
function joinProcessRealm() {
    let start;
    try {
        start = readFrame(REALM_FDS.events);
    }
    catch {
        throw new Error('realm: started without a realm');
    }
    if (typeof start !== 'object' || start === null || !('payload' in start))
        throw new Error('realm: started without a realm');
    new Worker(ORPHAN_WATCH, { eval: true }).unref();
    const send = (frame) => {
        const bytes = encodeFrame(serialize(frame));
        for (let at = 0; at < bytes.byteLength;)
            at += writeSync(REALM_FDS.toHost, bytes, at, bytes.byteLength - at);
    };
    let ids = 0;
    const call = (request) => {
        const id = ++ids;
        send({ kind: 'call', id, request });
        // Answers come in the order of the calls, and every call waits for its own.
        for (;;) {
            const answer = readFrame(REALM_FDS.answers);
            if (isRealmAnswer(answer) && answer.id === id)
                return valueOf(answer);
        }
    };
    // The host's events after the first, read as they come; the host gone ends the process.
    const listeners = [];
    const frames = new FrameReader();
    const stream = createReadStream('', { fd: REALM_FDS.events });
    stream.on('data', (chunk) => {
        for (const serialized of frames.push(chunk)) {
            const event = deserialize(serialized);
            for (const listener of listeners)
                listener(event);
        }
    });
    return {
        payload: start.payload,
        call,
        // The answers' pipe is only ever read synchronously, so an asynchronous call waits as a synchronous one.
        callAsync: async (request) => call(request),
        post: (event) => send({ kind: 'event', event }),
        events: {
            on(_event, listener) {
                listeners.push(listener);
                return this;
            },
        },
        hold: () => { },
    };
}
