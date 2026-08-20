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
import type { StreamingResponse } from './rpc.js';
/** The connection as the client drives it. A browser WebSocket satisfies it. */
export interface ActorSocket {
    send(data: string): void;
    addEventListener(type: 'message', listener: (event: {
        data: unknown;
    }) => void): void;
    removeEventListener(type: 'message', listener: (event: {
        data: unknown;
    }) => void): void;
}
export interface ActorCallOptions {
    /**
     * Reject the call after this long. Default: 30,000 ms for plain calls;
     * none for streamed calls.
     */
    timeoutMs?: number;
    /** Receives each `done: false` chunk of a streamed reply. */
    onChunk?: (chunk: unknown) => void;
}
/**
 * The target's async methods, callable as promises. Which of them the actor
 * actually answers is decided server-side by the `callable()` mark; an
 * unmarked method rejects with "is not callable".
 *
 * A streaming callable's `StreamingResponse` parameter is server-side —
 * the caller passes the remaining arguments and the promise resolves with
 * the final chunk, so the stub type strips that first parameter. The
 * detection is structural: a method whose first parameter merely ACCEPTS a
 * StreamingResponse (`unknown`, a broad object) is typed as streaming too.
 */
export type ActorStub<T> = {
    [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (stream: StreamingResponse, ...args: infer StreamArgs) => unknown ? (...args: StreamArgs) => Promise<unknown> : T[K] extends (...args: infer Args) => infer Return ? (...args: Args) => Promise<Awaited<Return>> : never;
};
export interface ActorClient {
    /** Call one callable method by name. */
    call<T = unknown>(method: string, args?: unknown[], options?: ActorCallOptions): Promise<T>;
    /** A proxy whose method calls become `call(name, args)`. */
    stub<T>(options?: ActorCallOptions): ActorStub<T>;
    /** Detach from the socket and reject every call still pending. */
    close(): void;
}
export declare const DEFAULT_CALL_TIMEOUT_MS = 30000;
/** Attach an RPC client to a socket. One message listener for all calls. */
export declare function actorClient(socket: ActorSocket, defaults?: ActorCallOptions): ActorClient;
//# sourceMappingURL=client.d.ts.map