/**
 * client.ts — the caller's half of callable RPC: a promise per call, and a
 * typed stub proxy that makes an actor's methods look local.
 *
 * Dependency-free and workerd-free on purpose: the socket is anything with
 * `send` and message listeners — a browser WebSocket, a PartySocket, a
 * server-side WebSocket from `fetch()` — so this module runs wherever the
 * connection was made. Frames and defaults follow the Agents SDK client
 * (verified in `agents` 0.20.1 dist, `client.js:129-151,217-248`): ids are
 * `crypto.randomUUID()`, plain calls time out at 30 s by default, streamed
 * calls (an `onChunk` listener) get no timeout unless one is passed.
 */
import { isRpcResponseFrame, RPC_FRAME_TYPE } from './protocol.js';
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** Attach an RPC client to a socket. One message listener for all calls. */
export function actorClient(socket, defaults = {}) {
    const pending = new Map();
    const onMessage = (event) => {
        if (typeof event.data !== 'string')
            return;
        let frame;
        try {
            frame = JSON.parse(event.data);
        }
        catch {
            return;
        }
        if (!isRpcResponseFrame(frame))
            return;
        const call = pending.get(frame.id);
        if (!call)
            return;
        if (frame.success === false) {
            settle(frame.id)?.reject(new Error(frame.error));
            return;
        }
        if (frame.done === false) {
            call.onChunk?.(frame.result);
            return;
        }
        settle(frame.id)?.resolve(frame.result);
    };
    const settle = (id) => {
        const call = pending.get(id);
        if (!call)
            return undefined;
        pending.delete(id);
        if (call.timer !== undefined)
            clearTimeout(call.timer);
        return call;
    };
    socket.addEventListener('message', onMessage);
    const call = (method, args = [], options = {}) => {
        const onChunk = options.onChunk ?? defaults.onChunk;
        const timeoutMs = options.timeoutMs ?? defaults.timeoutMs ?? (onChunk ? undefined : DEFAULT_CALL_TIMEOUT_MS);
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const entry = { resolve: resolve, reject, onChunk };
            if (timeoutMs !== undefined) {
                entry.timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`RPC call '${method}' timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            }
            pending.set(id, entry);
            try {
                socket.send(JSON.stringify({ type: RPC_FRAME_TYPE, id, method, args }));
            }
            catch (e) {
                settle(id);
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        });
    };
    return {
        call,
        stub(options) {
            return new Proxy({}, {
                get(_target, name) {
                    if (typeof name !== 'string')
                        return undefined;
                    // `await stub` (or any promise resolution of the stub itself)
                    // probes `.then`; answering with a caller would fire an RPC
                    // literally named "then".
                    if (name === 'then')
                        return undefined;
                    return (...args) => call(name, args, options);
                },
            });
        },
        close() {
            socket.removeEventListener('message', onMessage);
            for (const id of [...pending.keys()]) {
                settle(id)?.reject(new Error('RPC client closed'));
            }
        },
    };
}
