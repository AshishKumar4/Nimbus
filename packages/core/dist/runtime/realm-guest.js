/**
 * realm-guest.ts — the guest's side of a realm (realm.ts), inside its worker.
 *
 * The host's first message carries what the guest started with and its
 * ports; it is taken before anything of the program's runs and the ports live
 * only in the closure this answers, never in `workerData` a program can
 * import.
 */
import { parentPort, receiveMessageOnPort } from 'node:worker_threads';
import { fromRealmError, isRealmAnswer, isRealmStart } from './realm.js';
/**
 * The host's first message: taken at once when it is already there, else
 * awaited. The worker can start before the host has posted it (a host
 * descheduled between starting the worker and posting). The listener goes
 * with it, so a program finds parentPort as it would in a worker of its own.
 */
async function firstMessage() {
    if (!parentPort)
        return undefined;
    const ready = receiveMessageOnPort(parentPort);
    if (ready)
        return ready.message;
    const port = parentPort;
    return new Promise((resolve) => {
        const take = (message) => {
            port.off('message', take);
            port.unref();
            resolve(message);
        };
        port.on('message', take);
    });
}
/** Joins the realm the host started this worker as. Throws in a worker no host started. */
export async function joinRealm() {
    const start = await firstMessage();
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
    const valueOf = (answer) => {
        if ('error' in answer)
            throw fromRealmError(answer.error);
        return answer.value;
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
    };
}
