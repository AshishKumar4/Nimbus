/**
 * rpc.ts — the server half of callable RPC: dispatch one request frame to a
 * marked method and answer over the connection.
 *
 * The dispatch contract mirrors the Agents SDK (verified in `agents` 0.20.1
 * dist, `index.js:883-934`):
 *   - the method must exist on the target AND carry the `callable()` mark;
 *     either failure is an error frame, not a crash.
 *   - a streaming method receives a {@link StreamingResponse} PREPENDED to
 *     the caller's arguments and owns its own reply frames; if it throws
 *     with the stream still open, the error closes the stream.
 *   - a plain method's awaited return value goes back as one
 *     `{ success: true, done: true }` frame; a throw becomes
 *     `{ success: false, error }` carrying the message only, never the stack.
 *
 * Sends tolerate exactly one failure: workerd throws a TypeError containing
 * "WebSocket send() after close" when the peer is gone, and a reply that
 * cannot be delivered has no one waiting for it. Every other send error is
 * a real bug and propagates.
 */
import { type RpcRequestFrame } from './protocol.js';
/** The connection as RPC writes to it. partyserver's `Connection` satisfies it. */
export interface RpcConnection {
    send(message: string): void;
}
/**
 * The reply channel a streaming callable writes through. One `end()` (or
 * `error()`) closes it; every later write is a refused no-op that returns
 * false, matching the Agents SDK's `StreamingResponse` (dist
 * `index.js:7169-7233`).
 */
export declare class StreamingResponse {
    #private;
    private readonly connection;
    private readonly id;
    constructor(connection: RpcConnection, id: string);
    get isClosed(): boolean;
    /** One chunk. Returns false when the stream is closed or the peer is gone. */
    send(chunk: unknown): boolean;
    /** Close the stream, with an optional final chunk. */
    end(finalChunk?: unknown): boolean;
    /** Close the stream with an error the caller's promise rejects on. */
    error(message: string): boolean;
}
/** Run one request frame against the target and reply on the connection. */
export declare function dispatchRpc(target: object, connection: RpcConnection, frame: RpcRequestFrame): Promise<void>;
//# sourceMappingURL=rpc.d.ts.map