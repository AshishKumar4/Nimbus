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

import { callableMetadata, isCallable } from './callable.js';
import { RPC_FRAME_TYPE, type RpcRequestFrame, type RpcResponseFrame } from './protocol.js';

/** The connection as RPC writes to it. partyserver's `Connection` satisfies it. */
export interface RpcConnection {
  send(message: string): void;
}

function sendIfOpen(connection: RpcConnection, frame: RpcResponseFrame): boolean {
  try {
    connection.send(JSON.stringify(frame));
    return true;
  } catch (e) {
    if (e instanceof TypeError && e.message.includes('WebSocket send() after close')) return false;
    throw e;
  }
}

/**
 * The reply channel a streaming callable writes through. One `end()` (or
 * `error()`) closes it; every later write is a refused no-op that returns
 * false, matching the Agents SDK's `StreamingResponse` (dist
 * `index.js:7169-7233`).
 */
export class StreamingResponse {
  #closed = false;

  constructor(
    private readonly connection: RpcConnection,
    private readonly id: string,
  ) {}

  get isClosed(): boolean {
    return this.#closed;
  }

  /** One chunk. Returns false when the stream is closed or the peer is gone. */
  send(chunk: unknown): boolean {
    if (this.#closed) {
      console.warn('loom: StreamingResponse.send() after the stream was closed — chunk not sent');
      return false;
    }
    return sendIfOpen(this.connection, { type: RPC_FRAME_TYPE, id: this.id, success: true, result: chunk, done: false });
  }

  /** Close the stream, with an optional final chunk. */
  end(finalChunk?: unknown): boolean {
    if (this.#closed) return false;
    this.#closed = true;
    return sendIfOpen(this.connection, { type: RPC_FRAME_TYPE, id: this.id, success: true, result: finalChunk, done: true });
  }

  /** Close the stream with an error the caller's promise rejects on. */
  error(message: string): boolean {
    if (this.#closed) return false;
    this.#closed = true;
    return sendIfOpen(this.connection, { type: RPC_FRAME_TYPE, id: this.id, success: false, error: message });
  }
}

/** Run one request frame against the target and reply on the connection. */
export async function dispatchRpc(
  target: object,
  connection: RpcConnection,
  frame: RpcRequestFrame,
): Promise<void> {
  const method = (target as Record<string, unknown>)[frame.method];
  try {
    if (typeof method !== 'function') throw new Error(`Method ${frame.method} does not exist`);
    if (!isCallable(method)) throw new Error(`Method ${frame.method} is not callable`);
    if (callableMetadata(method)?.streaming) {
      const stream = new StreamingResponse(connection, frame.id);
      try {
        await method.apply(target, [stream, ...frame.args]);
      } catch (e) {
        if (!stream.isClosed) stream.error(errorMessage(e));
      }
      return;
    }
    const result: unknown = await method.apply(target, frame.args);
    sendIfOpen(connection, { type: RPC_FRAME_TYPE, id: frame.id, success: true, result, done: true });
  } catch (e) {
    sendIfOpen(connection, { type: RPC_FRAME_TYPE, id: frame.id, success: false, error: errorMessage(e) });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error occurred';
}
